import logging

import pytest

from summarize_worker.config import parse_log_level


def test_default_and_valid_levels():
    assert parse_log_level("info") == logging.INFO
    assert parse_log_level("DEBUG") == logging.DEBUG
    assert parse_log_level("warn") == logging.WARNING
    assert parse_log_level("warning") == logging.WARNING
    assert parse_log_level("error") == logging.ERROR


def test_invalid_level_fails_fast():
    with pytest.raises(ValueError):
        parse_log_level("bogus")
