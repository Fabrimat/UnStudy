"""Provider key status reporting: change detection, heartbeat, source, failure isolation, never the key."""
import psycopg.errors
import pytest

from summarize_worker import db
from summarize_worker.config import Provider


class _Conn:
    def __init__(self, exc=None):
        self.calls, self.exc, self.rollbacks = [], exc, 0

    def execute(self, sql, params=()):
        if self.exc:
            raise self.exc
        self.calls.append((sql, params))

    def rollback(self):
        self.rollbacks += 1


class _Clock:
    t = 1000.0

    def __call__(self):
        return self.t


@pytest.fixture(autouse=True)
def reset(monkeypatch):
    monkeypatch.setattr(db, "_reported", {})
    monkeypatch.setattr(db, "_warned_missing_status", False)


def P(id, key="", url="http://x/v1"):
    return Provider(id, "openai", url, key)


def test_writes_only_on_change_or_after_five_minutes():
    c, clock, ps = _Conn(), _Clock(), (P("a", "k"),)
    db.report_key_status(c, ps, {}, clock)
    db.report_key_status(c, ps, {}, clock)
    assert len(c.calls) == 1
    db.report_key_status(c, (P("a", ""),), {}, clock)  # changed
    assert len(c.calls) == 2
    clock.t += 299
    db.report_key_status(c, (P("a", ""),), {}, clock)
    assert len(c.calls) == 2
    clock.t += 2
    db.report_key_status(c, (P("a", ""),), {}, clock)  # heartbeat
    assert len(c.calls) == 3


def test_sources_and_params_never_carry_the_key():
    c = _Conn()
    env = {"LLM_KEY_A": "secret-a"}
    db.report_key_status(c, (P("a", "secret-a"), P("b", "secret-b"), P("c")), env, _Clock())
    assert [p for _, p in c.calls] == [("a", True, "LLM_KEY"), ("b", True, "LLM_PROVIDERS"), ("c", False, "none")]
    assert not any("secret" in str(x) for x in c.calls)
    assert '"ProviderKeyStatus"' in c.calls[0][0]


def test_fake_providers_skipped():
    c = _Conn()
    db.report_key_status(c, (P("f", "", "fake"),), {}, _Clock())
    assert c.calls == []


def test_missing_table_rolls_back_warns_once_no_raise(caplog):
    c, clock = _Conn(psycopg.errors.UndefinedTable("no table")), _Clock()
    with caplog.at_level("WARNING"):
        db.report_key_status(c, (P("a", "k"),), {}, clock)
        db.report_key_status(c, (P("b", "k"),), {}, clock)
    assert c.rollbacks == 2 and len([r for r in caplog.records if "ProviderKeyStatus" in r.message]) == 1


def test_other_error_does_not_raise_or_log_key(caplog):
    c = _Conn(RuntimeError("boom secret-a"))
    with caplog.at_level("WARNING"):
        db.report_key_status(c, (P("a", "secret-a"),), {}, _Clock())
    assert caplog.records and "secret-a" not in caplog.text
