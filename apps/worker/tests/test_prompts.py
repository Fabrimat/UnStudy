import pytest

from summarize_worker.prompts import PRESETS, render_instructions


@pytest.mark.parametrize("preset", PRESETS)
def test_every_preset_renders_without_placeholders(preset):
    text = render_instructions(preset, "it", 5)
    assert "{" not in text and "}" not in text
    assert "Italian" in text and "one fifth" in text


def test_auto_language_follows_the_reading():
    assert "the same language as the reading" in render_instructions("studio", "auto", 3)


def test_unknown_values_are_rejected():
    with pytest.raises(ValueError):
        render_instructions("poem", "en", 3)
    with pytest.raises(KeyError):
        render_instructions("studio", "xx", 3)
