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
