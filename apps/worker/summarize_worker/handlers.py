import logging
import time

from . import db
from .docx import to_docx
from .llm import Usage
from .pipeline import summarize_chapters
from .prompts import render_instructions
from .text import Chapter, clean_pages, extract_pages, inspect_pdf, split_chapters

MAX_BYTES = 50 * 1024 * 1024
MAX_PAGES = 400
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

log = logging.getLogger(__name__)


class Rejected(Exception):
    """The file itself is unusable; the message is shown to the user."""


class FileChanged(Exception):
    """The stored PDF no longer matches what priced the job (F1 credit bypass): fail now, no retry."""


def load_pdf(storage, doc: dict) -> bytes:
    if storage.size(doc["s3Key"]) > MAX_BYTES:
        raise Rejected("File larger than 50 MB")
    pdf = storage.get(doc["s3Key"])
    if not pdf.startswith(b"%PDF-"):
        raise Rejected("Not a PDF file")
    return pdf


def read_chapters(pdf: bytes, ocr_langs: str | None, on_page=None) -> tuple[list[Chapter], int, bool]:
    try:
        pages_count, needs_pass = inspect_pdf(pdf)
    except ValueError:
        raise Rejected("Not a readable PDF file")
    if needs_pass:
        raise Rejected("Password-protected PDF")
    if pages_count > MAX_PAGES:
        raise Rejected("More than 400 pages")
    pages, toc, used_ocr = extract_pages(pdf, ocr_langs, on_page)
    chapters = split_chapters(clean_pages(pages), toc)
    if not chapters:
        raise Rejected("No text found in the PDF, even with OCR")
    log.info(f"extracted {pages_count} pages, {sum(c.words for c in chapters)} words, "
            f"ocr={used_ocr}, {len(chapters)} chapter(s)")
    return chapters, pages_count, used_ocr


def _page_heartbeat(conn, job_id, analyze: bool, attempts: int):
    # extraction with OCR can outlast the 10-minute stale window, so every page updates the heartbeat
    def on_page(i: int, n: int):
        log.debug(f"heartbeat: job {job_id} page {i}/{n}")
        db.progress(conn, job_id, int(i / n * 99) if analyze else 0, f"Reading page {i}/{n}", attempts)
    return on_page


def handle_analyze(conn, storage, settings, job: dict) -> None:
    start = time.monotonic()
    doc = db.get_document(conn, job["documentId"])
    try:
        chapters, pages, used_ocr = read_chapters(load_pdf(storage, doc), settings.ocr_langs,
                                                  _page_heartbeat(conn, job["id"], analyze=True, attempts=job["attempts"]))
    except Rejected as e:
        db.reject_document(conn, job, str(e))
        log.warning(f"analyze job {job['id']} rejected: {e}")
        return
    db.finish_analyze(conn, job, pages=pages, words=sum(c.words for c in chapters), used_ocr=used_ocr,
                      chapters=[c.as_json() for c in chapters])
    log.info(f"analyze job {job['id']} succeeded in {time.monotonic() - start:.1f}s")


def handle_summarize(conn, storage, settings, client, job: dict) -> None:
    start = time.monotonic()
    doc = db.get_document(conn, job["documentId"])
    chapters, _, _ = read_chapters(load_pdf(storage, doc), settings.ocr_langs,
                                   _page_heartbeat(conn, job["id"], analyze=False, attempts=job["attempts"]))
    if sum(c.words for c in chapters) != doc["words"]:
        # The object behind the presigned PUT URL was swapped after analyze priced the job: never
        # call the LLM on it, and never retry (a retry would just re-read the same swapped file).
        raise FileChanged("The file changed after it was priced")
    opts = job["options"]
    usage = Usage()

    def on_call(rec: dict):
        db.record_call(conn, job, rec)  # a raising recorder is swallowed and logged by call_model

    markdown, warnings = summarize_chapters(
        client, settings.llm_model, chapters, render_instructions(opts["preset"], opts["language"], opts["fraction"]),
        fraction=opts["fraction"], bibliographic_line=opts.get("bibliographicLine"),
        on_progress=lambda percent, phase: db.progress(conn, job["id"], percent, phase, job["attempts"]), usage=usage,
        on_call=on_call)
    db.progress(conn, job["id"], 99, "Saving", job["attempts"])
    prefix = f"users/{job['userId']}/results/{job['id']}"
    storage.put(f"{prefix}.md", markdown.encode("utf-8"), "text/markdown; charset=utf-8")
    storage.put(f"{prefix}.docx", to_docx(markdown), DOCX_MIME)
    db.finish_summary(conn, job, md_key=f"{prefix}.md", docx_key=f"{prefix}.docx", warnings=warnings,
                      model=settings.llm_model, duration_ms=int((time.monotonic() - start) * 1000))
    log.info(f"summarize job {job['id']} succeeded in {time.monotonic() - start:.1f}s "
            f"(tokens in={usage.input_tokens} out={usage.output_tokens})")


def process(conn, storage, settings, client, job: dict) -> None:
    model = settings.llm_model if job["kind"] == "summarize" else None
    try:
        if job["kind"] == "analyze":
            handle_analyze(conn, storage, settings, job)
        else:
            handle_summarize(conn, storage, settings, client, job)
    except FileChanged:
        log.error(f"job {job['id']} failed (file changed after pricing, refunded, no retry)", exc_info=True)
        db.fail(conn, job, model)
    except Exception:
        retry = job["attempts"] < db.MAX_ATTEMPTS
        outcome = "will retry" if retry else "refunded" if job["kind"] == "summarize" else "rejected"
        log.error(f"job {job['id']} failed ({outcome})", exc_info=True)  # user sees db.SUMMARY_ERROR / ANALYZE_ERROR
        db.fail_or_retry(conn, job, model)
