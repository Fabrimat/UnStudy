import logging
import time

from . import db
from .docx import to_docx
from .judge import evaluate
from .llm import Usage
from .pipeline import Phase, prompts_dump, summarize_chapters
from .prompts import length_percent, render_custom, render_instructions
from .text import Chapter, chapters_text, clean_pages, drop_matter, extract_pages, inspect_pdf, split_chapters

MAX_BYTES = 50 * 1024 * 1024
MAX_PAGES = 400
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

log = logging.getLogger(__name__)


class Rejected(Exception):
    """The file itself is unusable; the message is shown to the user."""


class FileChanged(Exception):
    """The stored PDF no longer matches what priced the job (F1 credit bypass): fail now, no retry."""


class UnknownModel(Exception):
    """The job asks for a model id this worker's catalog does not have: fail now, no retry."""


def _entry(models, model_id):
    # Entries always come from the resolved catalog, never from options.model; adminOnly ids are allowed here.
    try:
        if model_id is None:
            return next(m for m in models if not m.admin_only)  # user-job default: first non-adminOnly
        return next(m for m in models if m.id == model_id)
    except StopIteration:
        raise UnknownModel(f"unknown model id {model_id!r}") from None


def resolve_phases(settings, opts: dict, models=None):
    """(draft entry, verify entry or None): phaseModels > modelId > default; verify null skips the fact-check.
    models: catalog resolved by the run loop (DB, else env); defaults to settings.models."""
    models = settings.models if models is None else models
    phase_models = opts.get("phaseModels")
    if phase_models is None:
        draft = _entry(models, opts.get("modelId"))
        return draft, draft
    draft = _entry(models, phase_models.get("draft") or opts.get("modelId"))
    verify_id = phase_models.get("verify")
    return draft, (None if verify_id is None else _entry(models, verify_id))


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


def save_lab_source(storage, job: dict, chapters: list[Chapter]) -> None:
    # best effort: the Lab source text is a download convenience and must never fail the lane
    try:
        storage.put(f"users/{job['userId']}/lab/{job['benchmarkId']}/source.txt",
                    chapters_text(chapters).encode("utf-8"), "text/plain; charset=utf-8")
    except Exception:
        log.warning(f"could not store the source text of Lab run {job['benchmarkId']}", exc_info=True)


def save_lab_prompt(storage, job: dict, dump: str) -> None:
    try:
        storage.put(f"users/{job['userId']}/lab/{job['benchmarkId']}/prompts/{job['id']}.txt",
                    dump.encode("utf-8"), "text/plain; charset=utf-8")
    except Exception:
        log.warning(f"could not store the prompts of Lab job {job['id']}", exc_info=True)


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


def handle_summarize(conn, storage, settings, clients: dict, job: dict, draft_entry, verify_entry, providers=None,
                     models=None) -> None:
    start = time.monotonic()
    doc = db.get_document(conn, job["documentId"])
    chapters, _, _ = read_chapters(load_pdf(storage, doc), settings.ocr_langs,
                                   _page_heartbeat(conn, job["id"], analyze=False, attempts=job["attempts"]))
    if sum(c.words for c in chapters) != doc["words"]:
        # The object behind the presigned PUT URL was swapped after analyze priced the job: never
        # call the LLM on it, and never retry (a retry would just re-read the same swapped file).
        raise FileChanged("The file changed after it was priced")
    opts = job["options"]
    chapters_all = chapters  # the source text is always the whole document
    if (picked := opts.get("chapters")) is not None:
        if len(chapters) != len(doc["chapters"] or []):
            raise FileChanged("The chapter split changed after it was priced")
        if not picked or not all(isinstance(i, int) and 0 <= i < len(chapters) for i in picked):
            raise FileChanged("Chapter selection does not match the document")  # the API validates this; never retry
        chapters = [chapters[i] for i in picked]
    else:
        chapters = drop_matter(chapters)  # only without an explicit selection: picked chapters are always summarized
    lab = job.get("benchmarkId") is not None
    if lab:
        save_lab_source(storage, job, chapters_all)
    percent, extras = length_percent(opts), opts.get("extras") or ()
    usage = Usage()
    custom = opts.get("customInstructions")
    if isinstance(custom, str) and custom.strip():
        instructions = render_custom(custom, opts["language"], percent, extras)
        log.debug(f"summarize job {job['id']} custom instructions ({len(custom)} chars)")
    else:  # a custom:<id> method without a snapshot lands here and fails as an unknown preset
        instructions = render_instructions(opts.get("preset") or opts.get("method"), opts["language"], percent, extras)

    def phase(entry) -> Phase | None:
        if entry is None:
            return None
        provider = next(p for p in (settings.providers if providers is None else providers) if p.id == entry.provider)
        return Phase(clients[provider.id], entry, provider)

    model = draft_entry.model

    def on_call(rec: dict):
        db.record_call(conn, job, rec)  # a raising recorder is swallowed and logged by call_model

    judge_id = opts.get("judge") if lab else None  # the judge only runs in Lab lanes
    judge_phase = judge_error = None
    if judge_id:
        try:  # an unknown judge model must never fail the lane: it ends up in evaluation.error
            judge_phase = phase(_entry(settings.models if models is None else models, judge_id))
        except Exception as e:
            log.warning(f"judge {judge_id!r} unusable for job {job['id']}: {e}")
            judge_error = f"judge unavailable: {e}"
    if lab:
        save_lab_prompt(storage, job, prompts_dump(phase(draft_entry), phase(verify_entry), chapters, instructions,
                                                  length_percent=percent, bibliographic_line=opts.get("bibliographicLine"),
                                                  judge=judge_phase))
    markdown, warnings, summaries = summarize_chapters(
        phase(draft_entry), chapters, instructions, verify=phase(verify_entry),
        length_percent=percent, bibliographic_line=opts.get("bibliographicLine"),
        on_progress=lambda percent, phase: db.progress(conn, job["id"], percent, phase, job["attempts"]), usage=usage,
        on_call=on_call)
    db.progress(conn, job["id"], 99, "Saving", job["attempts"])
    prefix = f"users/{job['userId']}/results/{job['id']}"
    storage.put(f"{prefix}.md", markdown.encode("utf-8"), "text/markdown; charset=utf-8")
    storage.put(f"{prefix}.docx", to_docx(markdown), DOCX_MIME)
    duration_ms = int((time.monotonic() - start) * 1000)  # before judging: judged and unjudged lanes stay comparable
    if judge_id:
        evaluation = {"judge": judge_id, "overall": None, "scores": None, "chapters": [], "error": judge_error}
        if judge_phase:
            try:
                evaluation = evaluate(judge_phase, chapters, summaries, percent, usage=usage, on_call=on_call,
                                      on_progress=lambda i, n: db.progress(conn, job["id"], 99, f"Judging chapter {i}/{n}",
                                                                           job["attempts"]))
            except Exception as e:  # evaluate only raises on bugs or a dead DB: still never fail the lane
                log.warning(f"judge crashed for job {job['id']}", exc_info=True)
                evaluation["error"] = f"judge failed: {type(e).__name__}"
        try:
            db.save_evaluation(conn, job, evaluation)
        except Exception:
            log.warning(f"could not store the evaluation of job {job['id']}", exc_info=True)
    db.finish_summary(conn, job, md_key=f"{prefix}.md", docx_key=f"{prefix}.docx", warnings=warnings,
                      model=model, duration_ms=duration_ms)
    log.info(f"summarize job {job['id']} succeeded in {time.monotonic() - start:.1f}s "
            f"(tokens in={usage.input_tokens} out={usage.output_tokens})")


def process(conn, storage, settings, clients: dict, job: dict, models=None, providers=None) -> None:
    """clients: provider id -> client. models, providers: loaded before the claim (None: env settings)."""
    model = None
    try:
        if job["kind"] == "summarize":
            draft, verify = resolve_phases(settings, job["options"], models)
            model = draft.model
        if job["kind"] == "analyze":
            handle_analyze(conn, storage, settings, job)
        else:
            handle_summarize(conn, storage, settings, clients, job, draft, verify, providers, models)
    except UnknownModel:
        log.error(f"job {job['id']} failed (unknown model id, refunded, no retry)")
        db.fail(conn, job, None)
    except FileChanged:
        log.error(f"job {job['id']} failed (file changed after pricing, refunded, no retry)", exc_info=True)
        db.fail(conn, job, model)
    except Exception:
        if job.get("benchmarkId") is not None:  # a retried Lab lane is not a measurement
            log.error(f"benchmark job {job['id']} failed (no retry)", exc_info=True)
            db.fail(conn, job, model)
            return
        retry = job["attempts"] < db.MAX_ATTEMPTS
        outcome = "will retry" if retry else "refunded" if job["kind"] == "summarize" else "rejected"
        log.error(f"job {job['id']} failed ({outcome})", exc_info=True)  # user sees db.SUMMARY_ERROR / ANALYZE_ERROR
        db.fail_or_retry(conn, job, model)
