"""Job queue on the Prisma-owned schema. Identifiers are quoted: Prisma keeps PascalCase/camelCase names."""
import contextlib
import logging
import os
import re
import threading
import time

import psycopg.errors
from psycopg.types.json import Jsonb

from .config import ModelEntry, Provider

MAX_ATTEMPTS = 2
SUMMARY_ERROR = "Summary generation failed. Your credits have been refunded."
ANALYZE_ERROR = "Could not read this PDF."

log = logging.getLogger(__name__)
_warned_missing_table = False
_warned_missing_providers = False
_warned_keyless: set[str] = set()


def claim(conn, kind: str, user_only: bool = False) -> dict | None:
    """Next queued job of a kind. user_only skips Lab (benchmark) jobs; summaries claim user jobs first."""
    where = ' AND "benchmarkId" IS NULL' if user_only else ""
    order = '("benchmarkId" IS NOT NULL), "createdAt"' if kind == "summarize" else '"createdAt"'
    return conn.execute(
        f"""UPDATE "Job" SET status = 'running', attempts = attempts + 1, "heartbeatAt" = now(), phase = 'starting'
            WHERE id = (SELECT id FROM "Job" WHERE status = 'queued' AND kind = %s::"JobKind"{where}
                        ORDER BY {order} FOR UPDATE SKIP LOCKED LIMIT 1)
            RETURNING *""", (kind,)).fetchone()


class JobGone(BaseException):
    """The job was cancelled (failed by an admin) or reclaimed: stop working on it, write nothing more.
    BaseException on purpose: the retry loop in call_model and the per-stage `except Exception` fallbacks
    must not swallow it."""


_held: dict = {}  # job id -> attempts, for the jobs this process is running right now
_held_lock = threading.Lock()


def hold(job: dict) -> None:
    with _held_lock:
        _held[job["id"]] = job["attempts"]


def release(job: dict) -> None:
    with _held_lock:
        _held.pop(job["id"], None)


def requeue_held(conn) -> int:
    """Shutdown (SIGTERM): hand every job this process holds back to the queue, user and Lab alike, whatever
    MAX_ATTEMPTS says: a redeploy is not the job's fault. Fenced; attempts stays monotonic (the fence relies on it)."""
    with _held_lock:
        held = list(_held.items())
    return sum(requeue(conn, job_id, attempts) for job_id, attempts in held)


def requeue(conn, job_id, attempts: int) -> int:
    return conn.execute("""UPDATE "Job" SET status = 'queued', phase = 'retrying'
                           WHERE id = %s AND status = 'running' AND attempts = %s""", (job_id, attempts)).rowcount


def progress(conn, job_id, percent: int, phase: str, attempts: int) -> bool:
    """False: the fenced UPDATE hit no row (job cancelled or reclaimed)."""
    # Fenced by attempts: a worker whose claim was reclaimed by recover_stale (attempts bumped by
    # the new claim) must not be able to move progress/phase/heartbeat for the new claim's run.
    return conn.execute("""UPDATE "Job" SET progress = %s, phase = %s, "heartbeatAt" = now()
                    WHERE id = %s AND status = 'running' AND attempts = %s""",
                        (percent, phase, job_id, attempts)).rowcount > 0


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


def record_call(conn, job: dict, rec: dict) -> None:
    """One LlmCall row, written on the autocommit connection so it survives crashes and retries."""
    conn.execute("""INSERT INTO "LlmCall" ("jobId", attempt, chapter, phase, model, provider, "modelId",
                                           "inputTokens", "outputTokens", "durationMs", ok)
                    VALUES (%s, %s, %s, %s::"LlmPhase", %s, %s, %s, %s, %s, %s, %s)""",
                 (job["id"], job["attempts"], rec["chapter"], rec["phase"], rec["model"], rec.get("provider"),
                  rec.get("modelId"), rec["inputTokens"], rec["outputTokens"], rec["durationMs"], rec["ok"]))


# Job totals are the sum over every attempt's LlmCall rows (retries cost real tokens too).
_TOTALS = """"inputTokens" = (SELECT COALESCE(SUM("inputTokens"), 0) FROM "LlmCall" WHERE "jobId" = "Job".id),
             "outputTokens" = (SELECT COALESCE(SUM("outputTokens"), 0) FROM "LlmCall" WHERE "jobId" = "Job".id)"""


def finish_summary(conn, job: dict, *, md_key: str, docx_key: str, warnings: list[str],
                   model: str, duration_ms: int) -> None:
    with conn.transaction():
        row = conn.execute(
            f"""UPDATE "Job" SET status = 'done', progress = 100, phase = 'done', "finishedAt" = now(),
                      "resultMdKey" = %s, "resultDocxKey" = %s, warnings = %s, {_TOTALS},
                      model = %s, "durationMs" = %s
               WHERE id = %s AND status = 'running' AND attempts = %s RETURNING id""",
            (md_key, docx_key, Jsonb(warnings), model, duration_ms, job["id"], job["attempts"])).fetchone()
        if row and job.get("benchmarkId") is None:  # Lab jobs write no ledger rows at all
            # the unique (jobId, type) index makes a second charge impossible anyway
            conn.execute("""INSERT INTO "CreditLedger" ("userId", type, amount, "jobId")
                            VALUES (%s, 'charge', 0, %s) ON CONFLICT DO NOTHING""", (job["userId"], job["id"]))


def save_evaluation(conn, job: dict, evaluation: dict) -> None:
    """Lab judge scores, written before the job is marked done. An old DB without the column is only a warning."""
    try:
        conn.execute('UPDATE "Job" SET evaluation = %s WHERE id = %s AND attempts = %s',
                     (Jsonb(evaluation), job["id"], job["attempts"]))
    except psycopg.errors.UndefinedColumn:
        conn.rollback()
        log.warning('column "Job".evaluation is missing (API migration not applied yet), evaluation not saved')


def lab_error(e: BaseException) -> str:
    """Error text stored on a failed Lab lane (admin-only): exception type and message, key-looking tokens masked."""
    text = re.sub(r"\b(?:sk|nvapi|gsk|xai)-[\w-]{8,}|Bearer\s+\S+", "***", f"{type(e).__name__}: {e}")
    return text[:500]


def _fail(conn, job_id, attempts: int | None = None, model: str | None = None, detail: str | None = None) -> None:
    """detail (Lab lanes): stored instead of the generic message, with the phase the job was in."""
    # attempts=None (recover_stale): the row is already locked FOR UPDATE and its own current
    # attempts was just read in the same transaction, so no fencing is needed there.
    fence = ' AND attempts = %s' if attempts is not None else ''
    params = (detail, SUMMARY_ERROR, ANALYZE_ERROR, model, job_id) + ((attempts,) if attempts is not None else ())
    row = conn.execute(
        f"""UPDATE "Job" SET status = 'failed', phase = 'failed', "finishedAt" = now(),
                  error = COALESCE(%s::text || ' (during: ' || COALESCE(phase, '?') || ')',
                                   CASE WHEN kind = 'summarize' THEN %s ELSE %s END), {_TOTALS},
                  model = COALESCE(%s, model)
           WHERE id = %s AND status = 'running'{fence}
           RETURNING id, "userId", "documentId", kind, credits""", params).fetchone()
    if not row:
        return
    if row["kind"] == "summarize" and row["credits"] > 0:
        conn.execute("""INSERT INTO "CreditLedger" ("userId", type, amount, "jobId")
                        VALUES (%s, 'refund', %s, %s) ON CONFLICT DO NOTHING""", (row["userId"], row["credits"], job_id))
    if row["kind"] == "analyze":
        conn.execute("""UPDATE "Document" SET status = 'rejected', "rejectReason" = %s
                        WHERE id = %s AND status = 'uploaded'""", (ANALYZE_ERROR, row["documentId"]))


def fail(conn, job: dict, model: str | None = None, detail: str | None = None) -> None:
    """Fail immediately, no retry (e.g. the source file changed after pricing): refunds like any other failure."""
    with conn.transaction():
        _fail(conn, job["id"], job["attempts"], model, detail)


def fail_or_retry(conn, job: dict, model: str | None = None) -> None:
    """After an exception: requeue while attempts remain, else fail (refunding summaries)."""
    with conn.transaction():
        if job["attempts"] < MAX_ATTEMPTS and job.get("benchmarkId") is None:  # Lab lanes never retry
            conn.execute("""UPDATE "Job" SET status = 'queued', phase = 'retrying'
                            WHERE id = %s AND status = 'running' AND attempts = %s""", (job["id"], job["attempts"]))
        else:
            _fail(conn, job["id"], job["attempts"], model)


def recover_stale(conn, stale_after: str = "10 minutes") -> int:
    """Jobs whose worker died (no heartbeat): requeue or fail+refund. Returns how many were handled.
    Lab lanes are requeued too: a dead worker (OOM, SIGKILL) is not the model's fault."""
    with conn.transaction():
        stale = conn.execute("""SELECT id, attempts, "benchmarkId" FROM "Job"
                                WHERE status = 'running' AND "heartbeatAt" < now() - %s::interval
                                FOR UPDATE SKIP LOCKED""", (stale_after,)).fetchall()
        for row in stale:
            if row["attempts"] < MAX_ATTEMPTS:
                conn.execute("""UPDATE "Job" SET status = 'queued', phase = 'retrying' WHERE id = %s""", (row["id"],))
            else:
                _fail(conn, row["id"], detail=None if row["benchmarkId"] is None else "worker stopped responding")
    return len(stale)


def models_from_rows(rows, provider_ids, fallback: tuple[ModelEntry, ...]) -> tuple[ModelEntry, ...]:
    """ModelPreset rows -> catalog; no rows: env fallback. `enabled` is ignored on purpose (queued jobs keep working).
    Rows of a provider this worker lacks are dropped, so resolving their id is UnknownModel."""
    if not rows:
        return fallback
    return tuple(ModelEntry(r["id"], r["model"], r["provider"], r["temperature"], r["adminOnly"])
                 for r in rows if r["provider"] in provider_ids)


def load_models(conn, settings, provider_ids=None) -> tuple[ModelEntry, ...]:
    """Catalog for the next job: one SELECT, env fallback when the table is empty or not migrated yet."""
    global _warned_missing_table
    try:
        rows = conn.execute('SELECT id, model, provider, temperature, "adminOnly" FROM "ModelPreset" '
                            'ORDER BY position, id').fetchall()
    except psycopg.errors.UndefinedTable:
        conn.rollback()  # no-op under autocommit; keeps a non-autocommit connection usable
        if not _warned_missing_table:
            _warned_missing_table = True
            log.warning('table "ModelPreset" is missing (API migration not applied yet), using LLM_MODELS')
        return settings.models
    return models_from_rows(rows, provider_ids if provider_ids is not None else {p.id for p in settings.providers},
                            settings.models)


def providers_from_rows(rows, fallback: tuple[Provider, ...], env) -> tuple[Provider, ...]:
    """LlmProvider rows override the env providers by id; env-only ids stay (no rows: just env). Key = env LLM_KEY_<ID>, else the env-configured key of the
    same id, else "" (the DB never names an env var). Warns once per id on a keyless non-fake endpoint, never logs a key."""
    env_keys = {p.id: p.api_key for p in fallback}
    out = []
    for r in rows:
        key = env.get("LLM_KEY_" + r["id"].upper().replace("-", "_")) or env_keys.get(r["id"], "")
        if not key and r["baseUrl"] != "fake" and r["id"] not in _warned_keyless:
            _warned_keyless.add(r["id"])
            log.warning(f"provider {r['id']} has no API key (set LLM_KEY_{r['id'].upper().replace('-', '_')}), calling it keyless")
        out.append(Provider(r["id"], "openai", r["baseUrl"], key, r["tokenParam"], r["maxConcurrency"]))
    db_ids = {p.id for p in out}
    return tuple(out) + tuple(p for p in fallback if p.id not in db_ids)


def load_providers(conn, settings, env=None) -> tuple[Provider, ...]:
    """Providers for the next job: one SELECT, DB rows override env providers by id; env alone when the table is empty or not migrated yet."""
    global _warned_missing_providers
    try:
        rows = conn.execute('SELECT id, "baseUrl", "tokenParam", "maxConcurrency" FROM "LlmProvider" '
                            'ORDER BY "createdAt", id').fetchall()
    except psycopg.errors.UndefinedTable:
        conn.rollback()
        if not _warned_missing_providers:
            _warned_missing_providers = True
            log.warning('table "LlmProvider" is missing (API migration not applied yet), using LLM_PROVIDERS')
        return settings.providers
    return providers_from_rows(rows, settings.providers, os.environ if env is None else env)


_KEY_STATUS_EVERY = 300  # heartbeat: the API treats a status older than 15 min as stale
_reported: dict[str, tuple[tuple[bool, str], float]] = {}  # provider id -> ((hasKey, source), time of this process's last write attempt)
_reported_lock = threading.Lock()
_warned_missing_status = False


def key_source(p: Provider, env) -> str:
    """Where the resolved key came from: presence only, the key itself never leaves this function."""
    if not p.api_key:
        return "none"
    return "LLM_KEY" if env.get("LLM_KEY_" + p.id.upper().replace("-", "_")) == p.api_key else "LLM_PROVIDERS"


def report_key_status(conn, providers, env=None, clock=time.monotonic) -> None:
    """Tell the API which providers have a key here (hasKey + source only). Writes on change or every 5 min per id;
    never raises: a failure here must not touch job processing."""
    global _warned_missing_status
    env = os.environ if env is None else env
    try:
        for p in providers:
            if p.base_url == "fake":
                continue
            status, now = (bool(p.api_key), key_source(p, env)), clock()
            with _reported_lock:
                last = _reported.get(p.id)
                if last and last[0] == status and now - last[1] < _KEY_STATUS_EVERY:
                    continue
                _reported[p.id] = (status, now)  # before the write: a failing write retries on change or after 5 min, not every poll
            conn.execute('INSERT INTO "ProviderKeyStatus" (id, "hasKey", source, "checkedAt") VALUES (%s, %s, %s, now()) '
                         'ON CONFLICT (id) DO UPDATE SET "hasKey" = EXCLUDED."hasKey", source = EXCLUDED.source, "checkedAt" = now()',
                         (p.id, *status))
    except psycopg.errors.UndefinedTable:
        with contextlib.suppress(Exception):
            conn.rollback()
        if not _warned_missing_status:
            _warned_missing_status = True
            log.warning('table "ProviderKeyStatus" is missing (API migration not applied yet), key status not reported')
    except Exception as e:
        log.warning(f"could not report provider key status ({type(e).__name__})")
