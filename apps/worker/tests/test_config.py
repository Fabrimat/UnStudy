import logging

import pytest

from summarize_worker.config import parse_log_level, parse_models


def test_default_and_valid_levels():
    assert parse_log_level("info") == logging.INFO
    assert parse_log_level("DEBUG") == logging.DEBUG
    assert parse_log_level("warn") == logging.WARNING
    assert parse_log_level("warning") == logging.WARNING
    assert parse_log_level("error") == logging.ERROR


def test_invalid_level_fails_fast():
    with pytest.raises(ValueError):
        parse_log_level("bogus")


GOOD = '[{"id":"a","label":"A","model":"m-a","multiplier":1},{"id":"b-2","label":"B","model":"m-b","multiplier":1.5}]'


def test_models_parse_and_fallback():
    assert parse_models(GOOD, None) == (("a", "m-a"), ("b-2", "m-b"))
    assert parse_models(None, "fb") == parse_models("  ", "fb") == (("default", "fb"),)
    with pytest.raises(ValueError):
        parse_models("", None)


@pytest.mark.parametrize("raw", [
    "{oops", "[]", "{}",
    '[{"id":"A","label":"A","model":"m","multiplier":1}]',
    '[{"id":"a","label":"","model":"m","multiplier":1}]',
    '[{"id":"a","label":"A","model":"m","multiplier":0}]',
    '[{"id":"a","label":"A","model":"m","multiplier":101}]',
    '[{"id":"a","label":"A","model":"m","multiplier":1},{"id":"a","label":"B","model":"n","multiplier":1}]'])
def test_invalid_models_fail_fast(raw):
    with pytest.raises(ValueError):
        parse_models(raw, "fb")
