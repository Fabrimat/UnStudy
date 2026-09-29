import pytest

from summarize_worker.prompts import PLATFORM_RULES, length_percent, PRESETS, render_custom, render_instructions


@pytest.mark.parametrize("preset", PRESETS)
def test_every_preset_renders_without_placeholders(preset):
    text = render_instructions(preset, "it", 20)
    assert "{" not in text and "}" not in text
    assert "Italian" in text and "20%" in text


def test_auto_language_follows_the_reading():
    assert "the same language as the reading" in render_instructions("studio", "auto", 33)


def test_unknown_values_are_rejected():
    with pytest.raises(ValueError):
        render_instructions("poem", "en", 33)
    with pytest.raises(KeyError):
        render_instructions("studio", "xx", 33)


def test_custom_prompt_is_user_text_then_platform_block_with_placeholders_filled():
    text = render_custom("Be brief in {language}, keep {fraction} / {length}.", "it", 20)
    assert text.startswith("Be brief in Italian, keep 20% / 20%.\n\nPLATFORM RULES")
    assert text.endswith(PLATFORM_RULES.replace("{language}", "Italian").replace("{length}", "20%"))
    assert "{" not in text and "- Language: Italian.\n- Length: about 20% of" in text


def test_length_percent_new_and_legacy():
    assert length_percent({"lengthPercent": 15}) == 15
    assert length_percent({"fraction": 5}) == 20 and length_percent({"fraction": 3}) == 33


def test_extras_block_in_fixed_order_after_everything_and_absent_without_extras():
    for text in (render_instructions("studio", "en", 20, ["takeaways", "glossary"]),
                 render_custom("Mine", "en", 20, ["takeaways", "glossary"])):
        tail = text.split("\n\nEXTRA SECTIONS\n")[1]
        assert tail == ("At the end of the summary add these sections, with headings written in the output language:\n"
                        "- Glossary: the key terms with a one-line definition each.\n"
                        "- Key takeaways: 3 to 5 bullet points.")
    assert "EXTRA SECTIONS" not in render_custom("Mine", "en", 20)
    assert "5 exam-style questions" in render_custom("Mine", "en", 20, ["questions"])
