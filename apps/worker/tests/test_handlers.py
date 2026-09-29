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
