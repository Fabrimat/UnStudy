"""python -m summarize_worker — one analyze thread plus SUMMARIZE_CONCURRENCY summarize threads."""
import contextlib
import logging
import sys
import threading
import time
from urllib.parse import urlsplit

import psycopg
from psycopg.rows import dict_row

from . import db
from .config import Settings
from .handlers import process
from .llm import make_client
from .storage import Storage

POLL_SECONDS = 2
RECOVERY_EVERY = 300
ERROR_PAUSE = 5
NOISY_LOGGERS = ("httpx", "httpcore", "openai", "botocore", "urllib3", "boto3")

log = logging.getLogger(__name__)


def configure_logging(level: int) -> None:
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(name)s: %(message)s", stream=sys.stdout)
    for name in NOISY_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)  # never at debug: would log request bodies


def run(kind: str, settings: Settings, stop: threading.Event, user_only: bool = False) -> None:
    # one client per provider per thread; provider concurrency limits are shared process-wide (llm.limiter_for)
    storage, clients = Storage(settings), {p.id: make_client(p) for p in settings.providers}
    conn, last_recovery = None, 0.0
    while not stop.is_set():
        try:
            if conn is None or conn.closed:
                conn = psycopg.connect(settings.database_url, autocommit=True, row_factory=dict_row)
            if kind == "analyze" and time.time() - last_recovery > RECOVERY_EVERY:
                if n := db.recover_stale(conn):
                    log.info(f"recovered {n} stale job(s)")
                last_recovery = time.time()
            models = db.load_models(conn, settings)  # before the claim: an error here never strands a running job
            job = db.claim(conn, kind, user_only=user_only)
            if job is None:
                stop.wait(POLL_SECONDS)
                continue
            log.info(f"{kind}: job {job['id']} claimed (doc {job['documentId']}, attempt {job['attempts']})")
            process(conn, storage, settings, clients, job, models)
        except psycopg.OperationalError:
            log.error("database connection lost, will reconnect", exc_info=True)  # database restarted
            conn = None
            stop.wait(5)
        except Exception:
            log.error("unexpected error in worker loop", exc_info=True)  # never let it kill this thread silently
            if conn is not None:
                with contextlib.suppress(Exception):
                    conn.close()  # may be broken (e.g. InterfaceError, half-open socket): reconnect next loop
            conn = None
            stop.wait(ERROR_PAUSE)


def main() -> None:
    settings = Settings.from_env()
    configure_logging(settings.log_level)
    stop = threading.Event()
    n = settings.summarize_concurrency
    # slot 0 only takes user jobs when there are other slots, so Lab jobs can never starve users
    specs = [("analyze", False)] + [("summarize", n > 1 and slot == 0) for slot in range(n)]
    threads = [threading.Thread(target=run, args=(kind, settings, stop, user_only), daemon=True) for kind, user_only in specs]
    for t in threads:
        t.start()
    hosts = ", ".join(f"{p.id}={urlsplit(p.base_url).hostname or p.base_url}" for p in settings.providers)  # never keys
    log.info(f"worker started (model {settings.default_model}, providers {hosts}, "
             f"summarize concurrency {n}, poll {POLL_SECONDS}s)")
    try:
        while all(t.is_alive() for t in threads):
            stop.wait(1)
    except KeyboardInterrupt:
        stop.set()  # a job interrupted mid-run is picked up again by recover_stale
    if not stop.is_set():
        sys.exit(1)  # a thread died unexpectedly: exit non-zero so the platform restarts the worker


if __name__ == "__main__":
    main()
