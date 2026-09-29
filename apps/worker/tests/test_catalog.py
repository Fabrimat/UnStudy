"""Catalog loader against a real ModelPreset table."""
import psycopg
import psycopg.rows
import pytest

from summarize_worker import db
from summarize_worker.config import ModelEntry


@pytest.fixture(autouse=True)
def reset_warning(monkeypatch):
    monkeypatch.setattr(db, "_warned_missing_table", False)


@pytest.fixture
def presets(conn):
    conn.execute('TRUNCATE "ModelPreset"')
    yield conn


def insert(conn, id, position=0, provider="default", enabled=True, admin_only=False, temperature=0.4):
    conn.execute('INSERT INTO "ModelPreset" (id, label, provider, model, multiplier, temperature, "adminOnly", enabled, '
                 'position, "updatedAt") VALUES (%s, %s, %s, %s, 1, %s, %s, %s, %s, now())',
                 (id, id, provider, f"{id}-model", temperature, admin_only, enabled, position))


def test_empty_table_uses_env(presets, settings):
    assert db.load_models(presets, settings) == settings.models


def test_rows_ordered_by_position_then_id(presets, settings):
    insert(presets, "b", 1)
    insert(presets, "a", 1, temperature=None)
    insert(presets, "z", 0, enabled=False, admin_only=True)
    models = db.load_models(presets, settings)
    assert models == (ModelEntry("z", "z-model", "default", 0.4, True), ModelEntry("a", "a-model", "default", None),
                      ModelEntry("b", "b-model", "default"))


def test_row_with_unknown_provider_does_not_crash(presets, settings):
    insert(presets, "ok")
    insert(presets, "ghost", provider="gone")
    assert [m.id for m in db.load_models(presets, settings)] == ["ok"]


def test_missing_table_falls_back_and_warns_once(presets, settings, caplog):
    presets.execute('ALTER TABLE "ModelPreset" RENAME TO "ModelPreset_off"')
    try:
        with caplog.at_level("WARNING"):
            assert db.load_models(presets, settings) == settings.models
            assert db.load_models(presets, settings) == settings.models
        assert len([r for r in caplog.records if "ModelPreset" in r.message]) == 1
        assert presets.execute("SELECT 1 AS one").fetchone()["one"] == 1  # connection still usable
    finally:
        presets.execute('ALTER TABLE "ModelPreset_off" RENAME TO "ModelPreset"')


def test_missing_table_in_open_transaction_is_rolled_back(settings):
    c = psycopg.connect(settings.database_url, row_factory=psycopg.rows.dict_row)  # not autocommit
    c.execute('ALTER TABLE "ModelPreset" RENAME TO "ModelPreset_off"')
    c.commit()
    try:
        assert db.load_models(c, settings) == settings.models
        assert c.execute("SELECT 1 AS one").fetchone()["one"] == 1
    finally:
        c.rollback()
        c.execute('ALTER TABLE "ModelPreset_off" RENAME TO "ModelPreset"')
        c.commit()
        c.close()
