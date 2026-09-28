from uuid import uuid4

import fitz
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from summarize_worker import db, handlers
from summarize_worker.handlers import process
from summarize_worker.llm import FakeClient
from summarize_worker.text import clean_pages, extract_pages, split_chapters
from tests.pdfs import make_pdf

OPTIONS = {"language": "auto", "fraction": 3, "preset": "studio"}
TEXT_PDF = make_pdf(["Chapter 1 Origins\n" + "Democracy shares power. " * 30,
                     "Chapter 2 Growth\n" + "Consensus spreads power. " * 30])


def _real_words(pdf: bytes) -> int:
    """What handle_summarize would extract & price this PDF at, absent any tampering."""
    pages, toc, _ = extract_pages(pdf, None)
    return sum(c.words for c in split_chapters(clean_pages(pages), toc))


class BrokenClient:
    def __init__(self):
        self.chat = self
        self.completions = self

    def create(self, **_):
        raise RuntimeError("LLM down")


def seed(conn, storage, pdf: bytes, *, kind="analyze", doc_status="uploaded", credits=0, attempts=0, words=None):
    user = conn.execute('INSERT INTO "User" (email) VALUES (%s) RETURNING id', (f"{uuid4().hex}@x.com",)).fetchone()["id"]
    doc_id = uuid4()
    key = f"users/{user}/documents/{doc_id}.pdf"
    storage.put(key, pdf, "application/pdf")
    if words is None and kind == "summarize":
        words = _real_words(pdf)  # matches what was actually priced, unless a test overrides it
    conn.execute('INSERT INTO "Document" (id, "userId", "s3Key", filename, "sizeBytes", status, words) '
                 'VALUES (%s, %s, %s, %s, %s, %s::"DocumentStatus", %s)',
                 (doc_id, user, key, "t.pdf", len(pdf), doc_status, words))
    job_id = conn.execute('INSERT INTO "Job" ("userId", "documentId", kind, options, credits, attempts) '
                          'VALUES (%s, %s, %s::"JobKind", %s, %s, %s) RETURNING id',
                          (user, doc_id, kind, Jsonb(OPTIONS if kind == "summarize" else {}), credits, attempts)).fetchone()["id"]
    if credits:
        conn.execute("""INSERT INTO "CreditLedger" ("userId", type, amount) VALUES (%s, 'grant', %s)""", (user, credits))
        conn.execute("""INSERT INTO "CreditLedger" ("userId", type, amount, "jobId") VALUES (%s, 'reserve', %s, %s)""",
                     (user, -credits, job_id))
    return user, doc_id, job_id


def job(conn, job_id):
    return conn.execute('SELECT * FROM "Job" WHERE id = %s', (job_id,)).fetchone()


def document(conn, doc_id):
    return conn.execute('SELECT * FROM "Document" WHERE id = %s', (doc_id,)).fetchone()


def balance(conn, user):
    return conn.execute('SELECT COALESCE(SUM(amount), 0) AS b FROM "CreditLedger" WHERE "userId" = %s', (user,)).fetchone()["b"]


def run_one(conn, storage, settings, kind, client=None):
    process(conn, storage, settings, client or FakeClient(), db.claim(conn, kind))


def test_claim_takes_each_job_once(conn, storage, settings):
    seed(conn, storage, TEXT_PDF)
    other = psycopg.connect(settings.database_url, autocommit=True, row_factory=dict_row)
    assert db.claim(conn, "analyze")["status"] == "running"
    assert db.claim(other, "analyze") is None
    assert db.claim(conn, "summarize") is None
    other.close()


def test_analyze_stores_words_and_chapters(conn, storage, settings):
    _, doc_id, job_id = seed(conn, storage, TEXT_PDF)
    run_one(conn, storage, settings, "analyze")
    doc = document(conn, doc_id)
    assert doc["status"] == "analyzed" and doc["pages"] == 2 and doc["words"] > 100
    assert [c["title"] for c in doc["chapters"]] == ["Chapter 1 Origins", "Chapter 2 Growth"]
    assert job(conn, job_id)["status"] == "done"


def test_analyze_rejects_bad_files(conn, storage, settings):
    cases = {
        b"hello, not a pdf": "Not a PDF file",
        make_pdf(["", ""]): "No text found in the PDF, even with OCR",
        make_pdf(["secret"], encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="o", user_pw="u"): "Password-protected PDF",
        make_pdf(["x"] * 401): "More than 400 pages",
    }
    for pdf, reason in cases.items():
        user, doc_id, job_id = seed(conn, storage, pdf)
        run_one(conn, storage, settings, "analyze")
        assert (document(conn, doc_id)["status"], document(conn, doc_id)["rejectReason"]) == ("rejected", reason)
        assert job(conn, job_id)["status"] == "done"
        assert balance(conn, user) == 0


def test_summary_is_uploaded_and_charged(conn, storage, settings):
    user, _, job_id = seed(conn, storage, TEXT_PDF, kind="summarize", doc_status="analyzed", credits=3)
    run_one(conn, storage, settings, "summarize")
    row = job(conn, job_id)
    assert (row["status"], row["progress"], row["phase"]) == ("done", 100, "done")
    assert row["inputTokens"] > 0 and row["outputTokens"] > 0
    assert storage.get(row["resultMdKey"]).startswith(b"# ")
    assert storage.get(row["resultDocxKey"])[:2] == b"PK"
    types = sorted(r["type"] for r in conn.execute('SELECT type FROM "CreditLedger" WHERE "userId" = %s', (user,)))
    assert types == ["charge", "grant", "reserve"]
    assert balance(conn, user) == 0


def test_finishing_twice_charges_once(conn, storage, settings):
    user, _, job_id = seed(conn, storage, TEXT_PDF, kind="summarize", doc_status="analyzed", credits=3)
    claimed = db.claim(conn, "summarize")
    for _ in range(2):
        db.finish_summary(conn, claimed, md_key="a.md", docx_key="a.docx", warnings=[], input_tokens=1, output_tokens=1)
    charges = conn.execute("""SELECT count(*) AS n FROM "CreditLedger" WHERE "jobId" = %s AND type = 'charge'""", (job_id,)).fetchone()
    assert charges["n"] == 1


def test_failed_summary_retries_once_then_refunds(conn, storage, settings, monkeypatch):
    monkeypatch.setattr("time.sleep", lambda _: None)
    user, _, job_id = seed(conn, storage, TEXT_PDF, kind="summarize", doc_status="analyzed", credits=3)
    run_one(conn, storage, settings, "summarize", BrokenClient())
    assert job(conn, job_id)["status"] == "queued"
    run_one(conn, storage, settings, "summarize", BrokenClient())
    row = job(conn, job_id)
    assert (row["status"], row["error"]) == ("failed", db.SUMMARY_ERROR)
    assert balance(conn, user) == 3


def test_summarize_fails_immediately_if_file_changed_after_pricing(conn, storage, settings):
    # Document.words (frozen at analyze time / used to price the job) no longer matches what the
    # stored PDF actually yields -> the swapped-file credit bypass (F1). Must fail with no retry,
    # a refund, and zero LLM calls.
    user, _, job_id = seed(conn, storage, TEXT_PDF, kind="summarize", doc_status="analyzed", credits=3, words=1)
    client = FakeClient()
    run_one(conn, storage, settings, "summarize", client)
    row = job(conn, job_id)
    assert (row["status"], row["error"]) == ("failed", db.SUMMARY_ERROR)
    assert balance(conn, user) == 3
    assert client.calls == []


def test_stale_jobs_are_requeued_or_refunded(conn, storage, settings):
    _, _, retry_id = seed(conn, storage, TEXT_PDF, kind="summarize", doc_status="analyzed", credits=2, attempts=1)
    user_b, _, dead_id = seed(conn, storage, TEXT_PDF, kind="summarize", doc_status="analyzed", credits=2, attempts=2)
    conn.execute("""UPDATE "Job" SET status = 'running', "heartbeatAt" = now() - interval '20 minutes'""")
    assert db.recover_stale(conn) == 2
    assert job(conn, retry_id)["status"] == "queued"
    assert job(conn, dead_id)["status"] == "failed" and balance(conn, user_b) == 2


def test_fresh_running_jobs_are_left_alone(conn, storage, settings):
    _, _, job_id = seed(conn, storage, TEXT_PDF, kind="summarize", doc_status="analyzed", credits=2)
    db.claim(conn, "summarize")
    assert db.recover_stale(conn) == 0
    assert job(conn, job_id)["status"] == "running"


def test_every_page_is_a_heartbeat(conn, storage, settings):
    _, _, job_id = seed(conn, storage, TEXT_PDF)
    claimed = db.claim(conn, "analyze")
    conn.execute("""UPDATE "Job" SET "heartbeatAt" = now() - interval '1 hour' WHERE id = %s""", (job_id,))
    stale_heartbeat = job(conn, job_id)["heartbeatAt"]
    on_page = handlers._page_heartbeat(conn, job_id, analyze=True, attempts=claimed["attempts"])
    on_page(1, 3)
    row = job(conn, job_id)
    assert row["phase"] == "Reading page 1/3"
    assert row["heartbeatAt"] > stale_heartbeat
    on_page(2, 3)
    on_page(3, 3)


def test_fencing_blocks_writes_from_a_superseded_claim(conn, storage, settings):
    # A worker holding a claim that recover_stale already reclaimed (attempts bumped by a fresh
    # claim) must not be able to progress/finish the job out from under the new claim (F2c).
    _, _, job_id = seed(conn, storage, TEXT_PDF, kind="summarize", doc_status="analyzed", credits=2)
    old = db.claim(conn, "summarize")
    assert old["attempts"] == 1
    conn.execute("""UPDATE "Job" SET "heartbeatAt" = now() - interval '20 minutes' WHERE id = %s""", (job_id,))
    assert db.recover_stale(conn) == 1
    assert job(conn, job_id)["status"] == "queued"
    new = db.claim(conn, "summarize")
    assert new["attempts"] == 2

    db.progress(conn, job_id, 42, "stale write", old["attempts"])
    row = job(conn, job_id)
    assert row["progress"] != 42 and row["phase"] != "stale write"

    db.finish_summary(conn, old, md_key="old.md", docx_key="old.docx", warnings=[], input_tokens=1, output_tokens=1)
    row = job(conn, job_id)
    assert row["status"] == "running" and row["resultMdKey"] is None
    charges = conn.execute("""SELECT count(*) AS n FROM "CreditLedger" WHERE "jobId" = %s AND type = 'charge'""",
                           (job_id,)).fetchone()
    assert charges["n"] == 0
