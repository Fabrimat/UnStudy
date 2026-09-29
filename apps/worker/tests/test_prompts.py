import pytest

from summarize_worker.prompts import PLATFORM_RULES, PRESETS, render_custom, render_instructions


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


def test_custom_prompt_is_user_text_then_platform_block_with_placeholders_filled():
    text = render_custom("Be brief in {language}, keep {fraction}.", "it", 5)
    assert text.startswith("Be brief in Italian, keep one fifth.\n\nPLATFORM RULES")
    assert text.endswith(PLATFORM_RULES.replace("{language}", "Italian").replace("{fraction}", "one fifth"))
    assert "{" not in text and "- Language: Italian.\n- Length: about one fifth of" in text
