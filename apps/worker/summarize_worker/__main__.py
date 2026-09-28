"""python -m summarize_worker — one thread per job kind, so a new upload is analysed while a long summary runs."""
import threading
import time
import traceback

import psycopg
from psycopg.rows import dict_row

from . import db
from .config import Settings
from .handlers import process
from .llm import make_client
from .storage import Storage

POLL_SECONDS = 2
RECOVERY_EVERY = 300


def run(kind: str, settings: Settings, stop: threading.Event) -> None:
    storage, client = Storage(settings), make_client(settings.llm_base_url, settings.llm_api_key)
    conn, last_recovery = None, 0.0
    while not stop.is_set():
        try:
            if conn is None or conn.closed:
                conn = psycopg.connect(settings.database_url, autocommit=True, row_factory=dict_row)
            if kind == "analyze" and time.time() - last_recovery > RECOVERY_EVERY:
                if n := db.recover_stale(conn):
                    print(f"recovered {n} stale job(s)")
                last_recovery = time.time()
            job = db.claim(conn, kind)
            if job is None:
                stop.wait(POLL_SECONDS)
                continue
            print(f"{kind}: job {job['id']} (attempt {job['attempts']})")
            process(conn, storage, settings, client, job)
        except psycopg.OperationalError:
            traceback.print_exc()  # database restarted: reconnect after a pause
            conn = None
            stop.wait(5)


def main() -> None:
    settings = Settings.from_env()
    stop = threading.Event()
    threads = [threading.Thread(target=run, args=(kind, settings, stop), daemon=True) for kind in ("analyze", "summarize")]
    for t in threads:
        t.start()
    print(f"worker started (model {settings.llm_model})")
    try:
        while any(t.is_alive() for t in threads):
            stop.wait(1)
    except KeyboardInterrupt:
        stop.set()  # a job interrupted mid-run is picked up again by recover_stale


if __name__ == "__main__":
    main()
