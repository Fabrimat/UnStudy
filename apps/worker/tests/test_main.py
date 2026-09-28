import threading

import summarize_worker.__main__ as main_mod
from summarize_worker.config import Settings


class _DummyConn:
    closed = False


def test_run_survives_unexpected_exceptions(monkeypatch):
    monkeypatch.setattr(main_mod, "ERROR_PAUSE", 0)
    stop = threading.Event()
    calls = []

    def fake_claim(conn, kind):
        calls.append(kind)
        if len(calls) == 1:
            raise RuntimeError("boom")
        stop.set()
        return None

    monkeypatch.setattr(main_mod.db, "claim", fake_claim)
    monkeypatch.setattr(main_mod.db, "recover_stale", lambda conn: 0)
    monkeypatch.setattr(main_mod.psycopg, "connect", lambda *a, **k: _DummyConn())

    settings = Settings(database_url="unused", s3_endpoint=None, s3_region="us-east-1", s3_bucket="unused",
                        s3_key="unused", s3_secret="unused", llm_base_url="fake", llm_api_key="", llm_model="fake",
                        ocr_langs=None)

    main_mod.run("analyze", settings, stop)

    assert calls == ["analyze", "analyze"]
