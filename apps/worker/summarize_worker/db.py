"""Job queue on the Prisma-owned schema. Identifiers are quoted: Prisma keeps PascalCase/camelCase names."""
from psycopg.types.json import Jsonb

MAX_ATTEMPTS = 2
SUMMARY_ERROR = "Summary generation failed. Your credits have been refunded."
ANALYZE_ERROR = "Could not read this PDF."


def claim(conn, kind: str) -> dict | None:
    return conn.execute(
        """UPDATE "Job" SET status = 'running', attempts = attempts + 1, "heartbeatAt" = now(), phase = 'starting'
           WHERE id = (SELECT id FROM "Job" WHERE status = 'queued' AND kind = %s::"JobKind"
                       ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1)
           RETURNING *""", (kind,)).fetchone()


def progress(conn, job_id, percent: int, phase: str, attempts: int) -> None:
    # Fenced by attempts: a worker whose claim was reclaimed by recover_stale (attempts bumped by
    # the new claim) must not be able to move progress/phase/heartbeat for the new claim's run.
    conn.execute("""UPDATE "Job" SET progress = %s, phase = %s, "heartbeatAt" = now()
                    WHERE id = %s AND status = 'running' AND attempts = %s""", (percent, phase, job_id, attempts))


def get_document(conn, doc_id) -> dict:
    return conn.execute('SELECT * FROM "Document" WHERE id = %s', (doc_id,)).fetchone()


def _done(conn, job_id, attempts: int, phase: str = "done") -> dict | None:
    return conn.execute(
        """UPDATE "Job" SET status = 'done', progress = 100, phase = %s, "finishedAt" = now()
           WHERE id = %s AND status = 'running' AND attempts = %s
           RETURNING id""", (phase, job_id, attempts)).fetchone()


def finish_analyze(conn, job: dict, *, pages: int, words: int, used_ocr: bool, chapters: list[dict]) -> None:
    with conn.transaction():
        if not _done(conn, job["id"], job["attempts"]):
            return  # a superseded claim: the reclaiming worker owns this job now
        conn.execute("""UPDATE "Document" SET status = 'analyzed', pages = %s, words = %s, "usedOcr" = %s, chapters = %s
                        WHERE id = %s""", (pages, words, used_ocr, Jsonb(chapters), job["documentId"]))


def reject_document(conn, job: dict, reason: str) -> None:
    with conn.transaction():
        if not _done(conn, job["id"], job["attempts"], phase="rejected"):
            return  # a superseded claim: the reclaiming worker owns this job now
        conn.execute("""UPDATE "Document" SET status = 'rejected', "rejectReason" = %s WHERE id = %s""",
                     (reason, job["documentId"]))


def finish_summary(conn, job: dict, *, md_key: str, docx_key: str, warnings: list[str],
                   input_tokens: int, output_tokens: int) -> None:
    with conn.transaction():
        row = conn.execute(
            """UPDATE "Job" SET status = 'done', progress = 100, phase = 'done', "finishedAt" = now(),
                      "resultMdKey" = %s, "resultDocxKey" = %s, warnings = %s, "inputTokens" = %s, "outputTokens" = %s
               WHERE id = %s AND status = 'running' AND attempts = %s RETURNING id""",
            (md_key, docx_key, Jsonb(warnings), input_tokens, output_tokens, job["id"], job["attempts"])).fetchone()
        if row:  # the unique (jobId, type) index makes a second charge impossible anyway
            conn.execute("""INSERT INTO "CreditLedger" ("userId", type, amount, "jobId")
                            VALUES (%s, 'charge', 0, %s) ON CONFLICT DO NOTHING""", (job["userId"], job["id"]))


def _fail(conn, job_id, attempts: int | None = None) -> None:
    # attempts=None (recover_stale): the row is already locked FOR UPDATE and its own current
    # attempts was just read in the same transaction, so no fencing is needed there.
    fence = ' AND attempts = %s' if attempts is not None else ''
    params = (SUMMARY_ERROR, ANALYZE_ERROR, job_id) + ((attempts,) if attempts is not None else ())
    row = conn.execute(
        f"""UPDATE "Job" SET status = 'failed', phase = 'failed', "finishedAt" = now(),
                  error = CASE WHEN kind = 'summarize' THEN %s ELSE %s END
           WHERE id = %s AND status IN ('running', 'queued'){fence}
           RETURNING id, "userId", "documentId", kind, credits""", params).fetchone()
    if not row:
        return
    if row["kind"] == "summarize" and row["credits"] > 0:
        conn.execute("""INSERT INTO "CreditLedger" ("userId", type, amount, "jobId")
                        VALUES (%s, 'refund', %s, %s) ON CONFLICT DO NOTHING""", (row["userId"], row["credits"], job_id))
    if row["kind"] == "analyze":
        conn.execute("""UPDATE "Document" SET status = 'rejected', "rejectReason" = %s
                        WHERE id = %s AND status = 'uploaded'""", (ANALYZE_ERROR, row["documentId"]))


def fail(conn, job: dict) -> None:
    """Fail immediately, no retry (e.g. the source file changed after pricing): refunds like any other failure."""
    with conn.transaction():
        _fail(conn, job["id"], job["attempts"])


def fail_or_retry(conn, job: dict) -> None:
    """After an exception: requeue while attempts remain, else fail (refunding summaries)."""
    with conn.transaction():
        if job["attempts"] < MAX_ATTEMPTS:
            conn.execute("""UPDATE "Job" SET status = 'queued', phase = 'retrying'
                            WHERE id = %s AND status = 'running' AND attempts = %s""", (job["id"], job["attempts"]))
        else:
            _fail(conn, job["id"], job["attempts"])


def recover_stale(conn, stale_after: str = "10 minutes") -> int:
    """Jobs whose worker died (no heartbeat): requeue or fail+refund. Returns how many were handled."""
    with conn.transaction():
        stale = conn.execute("""SELECT id, attempts FROM "Job"
                                WHERE status = 'running' AND "heartbeatAt" < now() - %s::interval
                                FOR UPDATE SKIP LOCKED""", (stale_after,)).fetchall()
        for row in stale:
            if row["attempts"] < MAX_ATTEMPTS:
                conn.execute("""UPDATE "Job" SET status = 'queued', phase = 'retrying' WHERE id = %s""", (row["id"],))
            else:
                _fail(conn, row["id"])
    return len(stale)
