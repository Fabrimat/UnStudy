import traceback

from . import db
from .docx import to_docx
from .llm import Usage
from .pipeline import summarize_chapters
from .prompts import render_instructions
from .text import Chapter, clean_pages, extract_pages, inspect_pdf, split_chapters

MAX_BYTES = 50 * 1024 * 1024
MAX_PAGES = 400
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


class Rejected(Exception):
    """The file itself is unusable; the message is shown to the user."""


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
    return chapters, pages_count, used_ocr


def _page_heartbeat(conn, job_id, analyze: bool):
    # extraction with OCR can outlast the 10-minute stale window, so every page updates the heartbeat
    def on_page(i: int, n: int):
        db.progress(conn, job_id, int(i / n * 99) if analyze else 0, f"Reading page {i}/{n}")
    return on_page


def handle_analyze(conn, storage, settings, job: dict) -> None:
    doc = db.get_document(conn, job["documentId"])
    try:
        chapters, pages, used_ocr = read_chapters(load_pdf(storage, doc), settings.ocr_langs,
                                                  _page_heartbeat(conn, job["id"], analyze=True))
    except Rejected as e:
        db.reject_document(conn, job, str(e))
        return
    db.finish_analyze(conn, job, pages=pages, words=sum(c.words for c in chapters), used_ocr=used_ocr,
                      chapters=[c.as_json() for c in chapters])


def handle_summarize(conn, storage, settings, client, job: dict) -> None:
    doc = db.get_document(conn, job["documentId"])
    chapters, _, _ = read_chapters(load_pdf(storage, doc), settings.ocr_langs,
                                   _page_heartbeat(conn, job["id"], analyze=False))
    opts = job["options"]
    usage = Usage()
    markdown, warnings = summarize_chapters(
        client, settings.llm_model, chapters, render_instructions(opts["preset"], opts["language"], opts["fraction"]),
        fraction=opts["fraction"], bibliographic_line=opts.get("bibliographicLine"),
        on_progress=lambda percent, phase: db.progress(conn, job["id"], percent, phase), usage=usage)
    db.progress(conn, job["id"], 99, "Saving")
    prefix = f"users/{job['userId']}/results/{job['id']}"
    storage.put(f"{prefix}.md", markdown.encode("utf-8"), "text/markdown; charset=utf-8")
    storage.put(f"{prefix}.docx", to_docx(markdown), DOCX_MIME)
    db.finish_summary(conn, job, md_key=f"{prefix}.md", docx_key=f"{prefix}.docx", warnings=warnings,
                      input_tokens=usage.input_tokens, output_tokens=usage.output_tokens)


def process(conn, storage, settings, client, job: dict) -> None:
    try:
        if job["kind"] == "analyze":
            handle_analyze(conn, storage, settings, job)
        else:
            handle_summarize(conn, storage, settings, client, job)
    except Exception:
        traceback.print_exc()  # details stay in the worker log; the user sees db.SUMMARY_ERROR / ANALYZE_ERROR
        db.fail_or_retry(conn, job)
