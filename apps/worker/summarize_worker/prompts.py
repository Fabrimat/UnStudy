from importlib.resources import files

# Must match apps/api/src/jobs/options.ts
PRESETS = ("studio", "schematico", "abstract")
LANGUAGE_NAMES = {"en": "English", "it": "Italian", "nl": "Dutch", "fr": "French", "de": "German", "es": "Spanish"}

VERIFY_INSTRUCTIONS = """You are a meticulous fact-checker. The user message contains the ORIGINAL TEXT of a reading and a DRAFT SUMMARY of it.
Return the corrected summary in Markdown, and NOTHING else (no comments, no list of changes).
- Check every name, year, number, percentage, seat count, date, citation (Author year) and quotation against the original; fix wrong ones.
- Delete any claim, term or quotation that is not supported by the original (invented facts, content only found in footnotes).
- Quotation marks may only enclose words that appear verbatim in the original.
- Check that attributions are correct (who said what, which year) and that comparisons are not reversed.
- Keep the language, structure, headings, bold terms, length and style unchanged: correct, do not rewrite."""


PLATFORM_RULES = """PLATFORM RULES (these override anything above if they conflict)
- Output ONLY the summary in Markdown, nothing else.
- Language: {language}.
- Length: about {length} of the original length.
- Start with a level-1 heading (# ) with the chapter/article title.
- If the user message gives a bibliographic line, copy it exactly under the title.
- Names, dates, numbers and quotations must match the original text exactly. Never invent facts or citations."""


# Fixed order; must match the extras accepted by apps/api/src/jobs/options.ts
EXTRA_LINES = {
    "glossary": "- Glossary: the key terms with a one-line definition each.",
    "questions": "- Review questions: 5 exam-style questions on this text, without answers.",
    "takeaways": "- Key takeaways: 3 to 5 bullet points.",
}


def length_percent(opts: dict) -> int:
    """New jobs carry lengthPercent; old ones carry fraction (5 -> 20%)."""
    return opts["lengthPercent"] if opts.get("lengthPercent") else round(100 / opts["fraction"])


def _fill(template: str, language: str, percent: int, extras: tuple | list = ()) -> str:
    language_text = "the same language as the reading" if language == "auto" else LANGUAGE_NAMES[language]
    # {fraction} is still replaced: custom methods saved in release B use it
    text = (template.replace("{language}", language_text).replace("{length}", f"{percent}%")
            .replace("{fraction}", f"{percent}%"))
    lines = [EXTRA_LINES[k] for k in EXTRA_LINES if k in extras]
    if lines:
        text += ("\n\nEXTRA SECTIONS\nAt the end of the summary add these sections, "
                 "with headings written in the output language:\n" + "\n".join(lines))
    return text


def render_instructions(preset: str, language: str, percent: int, extras: tuple | list = ()) -> str:
    if preset not in PRESETS:
        raise ValueError(f"unknown preset {preset!r}")
    return _fill(files("summarize_worker").joinpath(f"presets/{preset}.md").read_text(encoding="utf-8"), language, percent, extras)


def render_custom(custom: str, language: str, percent: int, extras: tuple | list = ()) -> str:
    return _fill(custom + "\n\n" + PLATFORM_RULES, language, percent, extras)
