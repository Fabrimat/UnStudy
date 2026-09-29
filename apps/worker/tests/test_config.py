import logging

import pytest

from summarize_worker.config import (ModelEntry, Provider, parse_concurrency, parse_log_level, parse_models,
                                     parse_providers)


def test_default_and_valid_levels():
    assert parse_log_level("info") == logging.INFO
    assert parse_log_level("DEBUG") == logging.DEBUG
    assert parse_log_level("warn") == logging.WARNING
    assert parse_log_level("warning") == logging.WARNING
    assert parse_log_level("error") == logging.ERROR


def test_invalid_level_fails_fast():
    with pytest.raises(ValueError):
        parse_log_level("bogus")


PROVS = (Provider("p1", "openai", "fake"), Provider("p2", "openai", "fake"))
GOOD = '[{"id":"a","label":"A","model":"m-a","multiplier":1},{"id":"b-2","label":"B","model":"m-b","multiplier":1.5}]'


def test_models_parse_and_fallback():
    assert parse_models(GOOD, None, PROVS) == (ModelEntry("a", "m-a", "p1"), ModelEntry("b-2", "m-b", "p1"))
    assert parse_models(None, "fb", PROVS) == parse_models("  ", "fb", PROVS) == (ModelEntry("default", "fb", "p1"),)
    with pytest.raises(ValueError):
        parse_models("", None, PROVS)


@pytest.mark.parametrize("raw", [
    "{oops", "[]", "{}",
    '[{"id":"A","label":"A","model":"m","multiplier":1}]',
    '[{"id":"a","label":"","model":"m","multiplier":1}]',
    '[{"id":"a","label":"A","model":"m","multiplier":0}]',
    '[{"id":"a","label":"A","model":"m","multiplier":101}]',
    '[{"id":"a","label":"A","model":"m","multiplier":1},{"id":"a","label":"B","model":"n","multiplier":1}]'])
def test_invalid_models_fail_fast(raw):
    with pytest.raises(ValueError):
        parse_models(raw, "fb", PROVS)


def test_models_provider_temperature_admin_only():
    raw = ('[{"id":"a","label":"A","model":"m","multiplier":1},'
           '{"id":"b","label":"B","model":"n","multiplier":1,"provider":"p2","temperature":null,"adminOnly":true,'
           '"priceIn":1,"priceOut":2.5},'
           '{"id":"c","label":"C","model":"o","multiplier":1,"temperature":1.5}]')
    a, b, c = parse_models(raw, None, PROVS)
    assert (a.provider, a.temperature, a.admin_only) == ("p1", 0.4, False)
    assert (b.provider, b.temperature, b.admin_only) == ("p2", None, True)
    assert c.temperature == 1.5


@pytest.mark.parametrize("extra", ['"provider":"nope"', '"temperature":2.5', '"temperature":"hot"', '"priceIn":-1',
                                   '"adminOnly":"yes"'])
def test_bad_model_extras_fail_fast(extra):
    with pytest.raises(ValueError):
        parse_models('[{"id":"a","label":"A","model":"m","multiplier":1,%s}]' % extra, None, PROVS)


def test_all_admin_only_models_fail_fast():
    with pytest.raises(ValueError):
        parse_models('[{"id":"a","label":"A","model":"m","multiplier":1,"adminOnly":true}]', None, PROVS)


def test_providers_default_falls_back_to_llm_base_url_and_key():
    env = {"LLM_BASE_URL": "http://x/v1", "NVIDIA_API_KEY": "nv"}
    assert parse_providers(None, env) == (Provider("default", "openai", "http://x/v1", "nv"),)
    assert parse_providers(" ", {**env, "LLM_API_KEY": "own"})[0].api_key == "own"
    with pytest.raises(ValueError):
        parse_providers(None, {})


def test_providers_parse_all_fields_and_read_key_from_env():
    raw = ('[{"id":"nv","baseUrl":"https://n/v1","apiKeyEnv":"NV_KEY"},'
           '{"id":"oa","kind":"openai","baseUrl":"https://o/v1","apiKeyEnv":"OA_KEY",'
           '"tokenParam":"max_completion_tokens","maxConcurrency":4}]')
    nv, oa = parse_providers(raw, {"NV_KEY": "k1", "OA_KEY": "k2"})
    assert nv == Provider("nv", "openai", "https://n/v1", "k1", "max_tokens", None)
    assert oa == Provider("oa", "openai", "https://o/v1", "k2", "max_completion_tokens", 4)
    assert "k2" not in repr(oa)


def test_missing_key_env_names_the_variable_only():
    raw = '[{"id":"nv","baseUrl":"https://n/v1","apiKeyEnv":"NV_KEY"}]'
    with pytest.raises(ValueError, match="NV_KEY") as e:
        parse_providers(raw, {"OTHER": "secret-value"})
    assert "secret-value" not in str(e.value)
    with pytest.raises(ValueError, match="NV_KEY"):
        parse_providers(raw, {"NV_KEY": ""})


@pytest.mark.parametrize("item", [
    '{"id":"a","kind":"anthropic","baseUrl":"u"}', '{"id":"A","baseUrl":"u"}', '{"id":"a","baseUrl":""}',
    '{"id":"a","baseUrl":"u","tokenParam":"nope"}', '{"id":"a","baseUrl":"u","maxConcurrency":0}',
    '{"id":"a","baseUrl":"u","maxConcurrency":65}', '{"id":"a","baseUrl":"u","maxConcurrency":true}'])
def test_invalid_providers_fail_fast(item):
    with pytest.raises(ValueError):
        parse_providers(f"[{item}]", {})


@pytest.mark.parametrize("raw", ["{oops", "[]", '[{"id":"a","baseUrl":"u"},{"id":"a","baseUrl":"v"}]'])
def test_invalid_provider_lists_fail_fast(raw):
    with pytest.raises(ValueError):
        parse_providers(raw, {})


def test_summarize_concurrency_parsing():
    assert parse_concurrency(None) == parse_concurrency("") == 1
    assert parse_concurrency("1") == 1 and parse_concurrency("16") == 16
    for bad in ("0", "17", "-1", "x", "1.5"):
        with pytest.raises(ValueError):
            parse_concurrency(bad)
