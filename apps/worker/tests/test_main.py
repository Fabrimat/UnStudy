import threading

import summarize_worker.__main__ as main_mod
from summarize_worker.config import Settings


class _DummyConn:
    def __init__(self):
        self.closed = False
        self.close_calls = 0

    def close(self):
        self.closed = True
        self.close_calls += 1


def test_run_survives_unexpected_exceptions(monkeypatch):
    monkeypatch.setattr(main_mod, "ERROR_PAUSE", 0)
    stop = threading.Event()
    calls = []
    conns = []

    def fake_claim(conn, kind):
        calls.append(kind)
        if len(calls) == 1:
            raise RuntimeError("boom")
        stop.set()
        return None

    def fake_connect(*a, **k):
        c = _DummyConn()
        conns.append(c)
        return c

    monkeypatch.setattr(main_mod.db, "claim", fake_claim)
    monkeypatch.setattr(main_mod.db, "recover_stale", lambda conn: 0)
    monkeypatch.setattr(main_mod.psycopg, "connect", fake_connect)

    settings = Settings(database_url="unused", s3_endpoint=None, s3_region="us-east-1", s3_bucket="unused",
                        s3_key="unused", s3_secret="unused", llm_base_url="fake", llm_api_key="", llm_model="fake",
                        ocr_langs=None)

    main_mod.run("analyze", settings, stop)

    assert calls == ["analyze", "analyze"]
    # the RuntimeError from the first claim must have dropped the (possibly broken) connection,
    # forcing a reconnect on the next loop iteration instead of reusing it forever
    assert len(conns) == 2
    assert conns[0].close_calls == 1
