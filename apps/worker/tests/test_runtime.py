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

OPTIONS = {"language": "auto", "lengthPercent": 33, "preset": "studio"}
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


def seed(conn, storage, pdf: bytes, *, kind="analyze", doc_status="uploaded", credits=0, attempts=0, words=None, options=OPTIONS):
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
                          (user, doc_id, kind, Jsonb(options if kind == "summarize" else {}), credits, attempts)).fetchone()["id"]
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
        db.finish_summary(conn, claimed, md_key="a.md", docx_key="a.docx", warnings=[], model="fake", duration_ms=1)
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

    db.finish_summary(conn, old, md_key="old.md", docx_key="old.docx", warnings=[], model="fake", duration_ms=1)
    row = job(conn, job_id)
    assert row["status"] == "running" and row["resultMdKey"] is None
    charges = conn.execute("""SELECT count(*) AS n FROM "CreditLedger" WHERE "jobId" = %s AND type = 'charge'""",
                           (job_id,)).fetchone()
    assert charges["n"] == 0


def calls(conn, job_id):
    return conn.execute('SELECT * FROM "LlmCall" WHERE "jobId" = %s ORDER BY "createdAt"', (job_id,)).fetchall()


def test_summary_records_a_row_per_call_and_sums_them(conn, storage, settings):
    _, _, job_id = seed(conn, storage, TEXT_PDF, kind="summarize", doc_status="analyzed", credits=3)
    run_one(conn, storage, settings, "summarize")
    rows, row = calls(conn, job_id), job(conn, job_id)
    assert sorted((r["chapter"], r["phase"]) for r in rows) == [(0, "draft"), (0, "verify"), (1, "draft"), (1, "verify")]
    assert all(r["ok"] and r["attempt"] == 1 and r["model"] == "fake" for r in rows)
    assert row["inputTokens"] == sum(r["inputTokens"] for r in rows) == 400
    assert row["outputTokens"] == sum(r["outputTokens"] for r in rows) == 200
    assert row["model"] == "fake" and row["durationMs"] is not None


def test_broken_llm_records_failed_calls_and_totals(conn, storage, settings, monkeypatch):
    monkeypatch.setattr("time.sleep", lambda _: None)
    _, _, job_id = seed(conn, storage, TEXT_PDF, kind="summarize", doc_status="analyzed", credits=3, attempts=1)
    run_one(conn, storage, settings, "summarize", BrokenClient())  # attempts=2: final failure, refunded
    rows, row = calls(conn, job_id), job(conn, job_id)
    assert [(r["phase"], r["chapter"], r["ok"], r["attempt"]) for r in rows] == [("draft", 0, False, 2)]
    assert (row["status"], row["inputTokens"], row["outputTokens"], row["model"]) == ("failed", 0, 0, "fake")


def test_failure_totals_include_earlier_attempts(conn, storage, settings, monkeypatch):
    monkeypatch.setattr("time.sleep", lambda _: None)
    _, _, job_id = seed(conn, storage, TEXT_PDF, kind="summarize", doc_status="analyzed", credits=3)

    class DiesAfterOneCall(FakeClient):
        def create(self, **kw):
            if self.calls:
                raise RuntimeError("LLM down")
            return super().create(**kw)

    run_one(conn, storage, settings, "summarize", DiesAfterOneCall())
    assert job(conn, job_id)["status"] == "queued"
    run_one(conn, storage, settings, "summarize", BrokenClient())
    rows, row = calls(conn, job_id), job(conn, job_id)
    assert [(r["attempt"], r["ok"]) for r in rows] == [(1, True), (1, False), (2, False)]
    assert (row["status"], row["inputTokens"], row["outputTokens"]) == ("failed", 100, 50)


def test_a_failing_call_recorder_does_not_fail_the_job(conn, storage, settings, monkeypatch):
    def boom(*_):
        raise RuntimeError("db write failed")
    monkeypatch.setattr(db, "record_call", boom)
    _, _, job_id = seed(conn, storage, TEXT_PDF, kind="summarize", doc_status="analyzed", credits=3)
    run_one(conn, storage, settings, "summarize")
    assert job(conn, job_id)["status"] == "done"


def test_custom_method_job_uses_custom_draft_prompt_and_plain_verify(conn, storage, settings):
    from summarize_worker.prompts import VERIFY_INSTRUCTIONS
    opts = {"language": "it", "fraction": 5, "method": "custom:abc", "methodName": "Mine",
            "customInstructions": "SECRET-USER-TEXT in {language}"}
    _, _, job_id = seed(conn, storage, TEXT_PDF, kind="summarize", doc_status="analyzed", credits=3, options=opts)
    client = FakeClient()
    run_one(conn, storage, settings, "summarize", client)
    assert job(conn, job_id)["status"] == "done"
    systems = [c[0]["content"] for c in client.calls]
    drafts, verifies = systems[0::2], systems[1::2]
    assert all(d.startswith("SECRET-USER-TEXT in Italian") and "PLATFORM RULES" in d for d in drafts)
    assert verifies and all(v == VERIFY_INSTRUCTIONS for v in verifies)


def test_legacy_method_only_and_custom_without_snapshot(conn, storage, settings, monkeypatch):
    monkeypatch.setattr("time.sleep", lambda _: None)
    _, _, ok_id = seed(conn, storage, TEXT_PDF, kind="summarize", doc_status="analyzed", credits=3,
                       options={"language": "auto", "fraction": 3, "method": "studio"})
    run_one(conn, storage, settings, "summarize")
    assert job(conn, ok_id)["status"] == "done"
    user, _, bad_id = seed(conn, storage, TEXT_PDF, kind="summarize", doc_status="analyzed", credits=3,
                           options={"language": "auto", "fraction": 3, "method": "custom:gone"})
    client = FakeClient()
    run_one(conn, storage, settings, "summarize", client)
    run_one(conn, storage, settings, "summarize", client)
    assert job(conn, bad_id)["status"] == "failed" and balance(conn, user) == 3 and client.calls == []


def _summarize(conn, storage, settings, opts, *, client=None):
    user, doc_id, job_id = seed(conn, storage, TEXT_PDF, kind="summarize", doc_status="analyzed", credits=3, options=opts)
    pages, toc, _ = extract_pages(TEXT_PDF, None)
    n = len(split_chapters(clean_pages(pages), toc))
    conn.execute('UPDATE "Document" SET chapters = %s WHERE id = %s',
                 (Jsonb([{"title": str(i), "words": 1} for i in range(n)]), doc_id))
    client = client or FakeClient()
    run_one(conn, storage, settings, "summarize", client)
    return user, job_id, client


def test_chapter_filter_sends_only_chosen_chapters(conn, storage, settings):
    _, job_id, client = _summarize(conn, storage, settings, {**OPTIONS, "chapters": [1]})
    assert job(conn, job_id)["status"] == "done"
    users = [c[1]["content"] for c in client.calls]
    assert len(client.calls) == 2 and "Consensus spreads" in users[0] and "Democracy shares" not in users[0]


def test_chapter_count_mismatch_is_file_changed_and_refunded(conn, storage, settings):
    user, doc_id, job_id = seed(conn, storage, TEXT_PDF, kind="summarize", doc_status="analyzed", credits=3,
                                options={**OPTIONS, "chapters": [0]})
    conn.execute('UPDATE "Document" SET chapters = %s WHERE id = %s', (Jsonb([{"title": "x", "words": 1}] * 7), doc_id))
    client = FakeClient()
    run_one(conn, storage, settings, "summarize", client)
    assert job(conn, job_id)["status"] == "failed" and balance(conn, user) == 3 and client.calls == []


def test_length_percent_and_legacy_fraction_reach_prompts(conn, storage, settings):
    _, _, client = _summarize(conn, storage, settings, {"language": "auto", "lengthPercent": 10, "preset": "studio"})
    assert "about 10% of the original length" in client.calls[0][0]["content"]
    assert "(10% of the original)" in client.calls[0][1]["content"]
    _, _, client = _summarize(conn, storage, settings, {"language": "auto", "fraction": 5, "preset": "studio"})
    assert "(20% of the original)" in client.calls[0][1]["content"] and "about 20% of" in client.calls[0][0]["content"]


def test_extras_reach_the_draft_system_prompt(conn, storage, settings):
    _, _, client = _summarize(conn, storage, settings, {**OPTIONS, "extras": ["glossary"]})
    assert "EXTRA SECTIONS" in client.calls[0][0]["content"]


def test_known_model_id_uses_worker_catalog_not_options_model(conn, storage, settings):
    seen = []

    class Spy(FakeClient):
        def create(self, **kw):
            seen.append(kw["model"])
            return super().create(**kw)

    _, job_id, _ = _summarize(conn, storage, settings, {**OPTIONS, "modelId": "alt", "model": "evil-model"}, client=Spy())
    assert set(seen) == {"alt-model"} and job(conn, job_id)["model"] == "alt-model"


def test_unknown_model_id_fails_refunded_without_retry_or_calls(conn, storage, settings):
    user, job_id, client = _summarize(conn, storage, settings, {**OPTIONS, "modelId": "nope", "model": "x"})
    row = job(conn, job_id)
    assert row["status"] == "failed" and row["attempts"] == 1 and balance(conn, user) == 3 and client.calls == []
