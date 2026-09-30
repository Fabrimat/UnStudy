import pytest

from summarize_worker.handlers import UnknownModel, resolve_phases


def ids(pair):
    return tuple(e and e.id for e in pair)


def test_default_when_no_ids(settings):
    assert ids(resolve_phases(settings, {})) == ("default", "default")


def test_model_id_drives_both_phases_and_ignores_options_model(settings):
    draft, verify = resolve_phases(settings, {"modelId": "alt", "model": "evil"})
    assert (draft.model, verify.model) == ("alt-model", "alt-model")


def test_phase_models_draft_and_verify(settings):
    draft, verify = resolve_phases(settings, {"modelId": "alt", "phaseModels": {"draft": "other-m", "verify": "lab"}})
    assert (draft.provider, verify.provider, verify.admin_only) == ("other", "other", True)
    assert draft.temperature is None


def test_phase_models_draft_falls_back_to_model_id_then_default(settings):
    assert ids(resolve_phases(settings, {"modelId": "alt", "phaseModels": {"verify": "default"}})) == ("alt", "default")
    assert ids(resolve_phases(settings, {"phaseModels": {"verify": "alt"}})) == ("default", "alt")


def test_null_verify_skips_the_fact_check(settings):
    draft, verify = resolve_phases(settings, {"phaseModels": {"draft": "alt", "verify": None}})
    assert draft.id == "alt" and verify is None


@pytest.mark.parametrize("opts", [{"modelId": "nope"}, {"phaseModels": {"draft": "nope", "verify": None}},
                                  {"phaseModels": {"draft": "alt", "verify": "nope"}}])
def test_unknown_ids_raise(settings, opts):
    with pytest.raises(UnknownModel):
        resolve_phases(settings, opts)


# --- DB-backed catalog (ModelPreset) mapping, no database needed ---
from summarize_worker.config import ModelEntry  # noqa: E402
from summarize_worker.db import models_from_rows  # noqa: E402


def row(id, provider="default", model="m", temperature=0.4, adminOnly=False, enabled=True):
    return {"id": id, "model": model, "provider": provider, "temperature": temperature, "adminOnly": adminOnly,
            "enabled": enabled}


def test_empty_table_falls_back_to_env(settings):
    assert models_from_rows([], {"default"}, settings.models) == settings.models


def test_rows_become_entries(settings):
    models = models_from_rows([row("x", "other", "x-model", None, True), row("y")], {"default", "other"}, settings.models)
    assert models == (ModelEntry("x", "x-model", "other", None, True), ModelEntry("y", "m", "default", 0.4, False))
    draft, verify = resolve_phases(settings, {"modelId": "y"}, models)
    assert (draft.model, verify.model) == ("m", "m")
    assert resolve_phases(settings, {}, models)[0].id == "y"  # default = first non-adminOnly of the DB catalog


def test_unknown_provider_row_is_unknown_model(settings):
    models = models_from_rows([row("ok"), row("ghost", provider="gone")], {"default"}, settings.models)
    with pytest.raises(UnknownModel):
        resolve_phases(settings, {"modelId": "ghost"}, models)
    assert resolve_phases(settings, {"modelId": "ok"}, models)[0].id == "ok"


def test_disabled_row_still_resolves(settings):
    models = models_from_rows([row("off", enabled=False)], {"default"}, settings.models)
    assert resolve_phases(settings, {"modelId": "off"}, models)[0].id == "off"


def test_db_catalog_replaces_env_ids(settings):
    models = models_from_rows([row("only")], {"default"}, settings.models)
    with pytest.raises(UnknownModel):
        resolve_phases(settings, {"modelId": "alt"}, models)  # env id absent from a non-empty table


# --- Lab source text persisted to storage (no database needed) ---
from types import SimpleNamespace  # noqa: E402

from summarize_worker import handlers  # noqa: E402
from summarize_worker.text import Chapter  # noqa: E402

CHAPTERS = [Chapter("One", 1, 2, "a b c"), Chapter("Two", 3, 3, "d e")]
DOC = {"id": "d1", "userId": "u1", "words": 5, "chapters": [{}, {}]}
SOURCE_KEY = "users/u1/lab/b1/source.txt"
JOB = {"id": "j1", "documentId": "d1", "userId": "u1", "attempts": 1, "options": {}}
LAB_JOB = {**JOB, "benchmarkId": "b1"}


class FakeStorage:
    def __init__(self, fail_text=False):
        self.puts, self.fail_text = {}, fail_text

    def put(self, key, body, content_type):
        if self.fail_text and key.endswith(".txt"):
            raise OSError("s3 down")
        self.puts[key] = (body, content_type)


@pytest.fixture
def calls(monkeypatch):
    calls = []
    monkeypatch.setattr(handlers, "read_chapters", lambda *a, **k: (CHAPTERS, 3, False))
    monkeypatch.setattr(handlers, "load_pdf", lambda *a: b"")
    monkeypatch.setattr(handlers, "summarize_chapters", lambda *a, **k: ("# md", []))
    monkeypatch.setattr(handlers, "to_docx", lambda md: b"docx")
    monkeypatch.setattr(handlers.db, "get_document", lambda *a: DOC)
    for name in ("progress", "record_call", "finish_analyze", "finish_summary"):
        monkeypatch.setattr(handlers.db, name, lambda *a, _n=name, **k: calls.append(_n))
    return calls


def run_summarize(storage, job, options=None, verify=None):
    job = {**job, "options": {"language": "en", "preset": "abstract", "lengthPercent": 20, **(options or {})}}
    handlers.handle_summarize(None, storage, SimpleNamespace(ocr_langs=None, providers=[SimpleNamespace(id="default")]),
                              {"default": None}, job,
                              SimpleNamespace(model="m", id="m", provider="default", temperature=None), verify)


def test_lab_lane_writes_whole_source_text(calls):
    st = FakeStorage()
    run_summarize(st, LAB_JOB, {"chapters": [1]})
    body, ctype = st.puts[SOURCE_KEY]
    assert body.decode() == "=== One (pp. 1\u20132) ===\na b c\n\n=== Two (pp. 3\u20133) ===\nd e"
    assert ctype == "text/plain; charset=utf-8" and "finish_summary" in calls


def test_normal_summarize_and_analyze_write_no_text(calls):
    st = FakeStorage()
    run_summarize(st, JOB)
    handlers.handle_analyze(None, st, SimpleNamespace(ocr_langs=None), JOB)
    assert not any(k.endswith(".txt") for k in st.puts) and "finish_analyze" in calls


def test_source_put_failure_does_not_fail_lane(calls):
    st = FakeStorage(fail_text=True)
    run_summarize(st, LAB_JOB)
    assert "finish_summary" in calls and "users/u1/results/j1.md" in st.puts


def test_lab_lane_writes_prompts_without_chapter_text(calls, monkeypatch):
    monkeypatch.setattr(handlers, "render_instructions", lambda *a: "SYSTEM RULES")
    st = FakeStorage()
    verify = SimpleNamespace(model="v", id="v", provider="default", temperature=None)
    run_summarize(st, LAB_JOB, verify=verify)
    dump = st.puts["users/u1/lab/b1/prompts/j1.txt"][0].decode()
    assert "SYSTEM RULES" in dump and "<<chapter 2 text: 2 words>>" in dump and "=== FACT-CHECK" in dump
    assert "a b c" not in dump and "d e" not in dump


def test_normal_summarize_writes_no_prompts(calls):
    st = FakeStorage()
    run_summarize(st, JOB)
    assert not any("prompts" in k for k in st.puts)
