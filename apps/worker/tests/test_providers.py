"""Editable providers: pure row mapping, missing-table fallback and the run loop (no LlmProvider table needed)."""
import threading

import psycopg.errors
import pytest

import summarize_worker.__main__ as main_mod
from summarize_worker import db
from summarize_worker.config import Provider, Settings

ENV = (Provider("default", "openai", "http://env/v1", "env-key"),)


def row(id, baseUrl="http://x/v1", tokenParam="max_tokens", maxConcurrency=None):
    return {"id": id, "baseUrl": baseUrl, "tokenParam": tokenParam, "maxConcurrency": maxConcurrency}


@pytest.fixture(autouse=True)
def reset_warnings(monkeypatch):
    monkeypatch.setattr(db, "_warned_missing_providers", False)
    monkeypatch.setattr(db, "_warned_keyless", set())


def test_no_rows_uses_env_providers():
    assert db.providers_from_rows([], ENV, {}) == ENV


def test_key_rule_llm_key_wins_then_env_entry_then_empty():
    env = {"LLM_KEY_MY_HOST": "k1", "LLM_KEY_DEFAULT": "k2"}
    a, b, c = db.providers_from_rows([row("my-host"), row("default"), row("nokey")], ENV, env)
    assert (a.api_key, b.api_key, c.api_key) == ("k1", "k2", "")
    (d,) = db.providers_from_rows([row("default")], ENV, {})
    assert d.api_key == "env-key"  # same id as an env LLM_PROVIDERS entry


def test_row_fields_and_keyless_warning_once_never_logs_key(caplog):
    with caplog.at_level("WARNING"):
        rows = [row("a", "http://a/v1", "max_completion_tokens", 3), row("f", "fake")]
        p, f, _ = db.providers_from_rows(rows, ENV, {})
        db.providers_from_rows(rows, ENV, {})
    assert (p.base_url, p.token_param, p.max_concurrency) == ("http://a/v1", "max_completion_tokens", 3)
    assert [r.message for r in caplog.records if "no API key" in r.message] == [r.message for r in caplog.records][:1]
    assert len(caplog.records) == 1 and "provider a" in caplog.records[0].message


class _Conn:
    def __init__(self, rows=None):
        self.rows, self.rollbacks = rows, 0

    def execute(self, *a):
        if self.rows is None:
            raise psycopg.errors.UndefinedTable("no table")
        return self

    def fetchall(self):
        return self.rows

    def rollback(self):
        self.rollbacks += 1


def test_missing_table_falls_back_and_warns_once(settings, caplog):
    c = _Conn()
    with caplog.at_level("WARNING"):
        assert db.load_providers(c, settings) == settings.providers
        assert db.load_providers(c, settings) == settings.providers
    assert c.rollbacks == 2 and len([r for r in caplog.records if "LlmProvider" in r.message]) == 1


def test_load_providers_maps_rows_and_models_filter_on_them(settings):
    p, *rest = db.load_providers(_Conn([row("db-only")]), settings, {"LLM_KEY_DB_ONLY": "k"})
    assert rest == list(settings.providers)  # env providers stay the baseline
    assert p == Provider("db-only", "openai", "http://x/v1", "k")
    rows = [{"id": "m", "model": "m", "provider": "db-only", "temperature": 0.4, "adminOnly": False},
            {"id": "n", "model": "n", "provider": "default", "temperature": 0.4, "adminOnly": False}]
    assert [m.id for m in db.models_from_rows(rows, {p.id}, settings.models)] == ["m"]


def test_db_row_overrides_env_by_id_env_only_ids_stay():
    env_p = (Provider("default", "openai", "http://env/v1", "env-key"), Provider("nv", "openai", "http://nv/v1", "nk"))
    a, b = db.providers_from_rows([row("default", "http://db/v1")], env_p, {})
    assert (a.base_url, a.api_key) == ("http://db/v1", "env-key")
    assert b == env_p[1]


def test_run_rebuilds_client_when_provider_changes_and_passes_loaded_providers(monkeypatch):
    stop, seen, built = threading.Event(), [], []
    loads = iter([(Provider("db-only", "openai", "http://a/v1"),), (Provider("db-only", "openai", "http://b/v1"),),
                  (Provider("db-only", "openai", "http://b/v1"),)])
    jobs = iter([{"id": "j", "documentId": "d", "attempts": 1}] * 3)

    def claim(conn, kind, user_only=False):
        job = next(jobs, None)
        if job is None:
            stop.set()
        return job

    def process(conn, storage, settings, clients, job, models, providers):
        seen.append((providers, clients["db-only"]))
        if len(seen) == 3:
            stop.set()

    monkeypatch.setattr(main_mod, "make_client", lambda p: built.append(p) or object())
    monkeypatch.setattr(main_mod, "process", process)
    monkeypatch.setattr(main_mod, "Storage", lambda s: None)
    monkeypatch.setattr(main_mod.db, "claim", claim)
    monkeypatch.setattr(main_mod.db, "load_providers", lambda conn, settings: next(loads))
    monkeypatch.setattr(main_mod.db, "load_models", lambda conn, settings, ids=None: ())
    monkeypatch.setattr(main_mod.db, "recover_stale", lambda conn: 0)
    monkeypatch.setattr(main_mod.psycopg, "connect", lambda *a, **k: type("C", (), {"closed": False})())
    settings = Settings(database_url="u", s3_endpoint=None, s3_region="r", s3_bucket="b", s3_key="k", s3_secret="s",
                        llm_base_url="fake", llm_api_key="", llm_model="fake", ocr_langs=None)
    main_mod.run("summarize", settings, stop)
    assert [p.base_url for p in built] == ["http://a/v1", "http://b/v1"]  # unchanged row reuses its client
    assert seen[0][1] is not seen[1][1] and seen[1][1] is seen[2][1]
    assert seen[0][0][0].id == "db-only"  # a DB-only provider reaches the handlers
