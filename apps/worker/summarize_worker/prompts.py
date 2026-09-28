from importlib.resources import files

# Must match apps/api/src/jobs/options.ts
PRESETS = ("studio", "schematico", "abstract")
LANGUAGE_NAMES = {"en": "English", "it": "Italian", "nl": "Dutch", "fr": "French", "de": "German", "es": "Spanish"}
FRACTION_NAMES = {3: "one third", 5: "one fifth", 10: "one tenth"}

VERIFY_INSTRUCTIONS = """You are a meticulous fact-checker. The user message contains the ORIGINAL TEXT of a reading and a DRAFT SUMMARY of it.
Return the corrected summary in Markdown, and NOTHING else (no comments, no list of changes).
- Check every name, year, number, percentage, seat count, date, citation (Author year) and quotation against the original; fix wrong ones.
- Delete any claim, term or quotation that is not supported by the original (invented facts, content only found in footnotes).
- Quotation marks may only enclose words that appear verbatim in the original.
- Check that attributions are correct (who said what, which year) and that comparisons are not reversed.
- Keep the language, structure, headings, bold terms, length and style unchanged: correct, do not rewrite."""


def render_instructions(preset: str, language: str, fraction: int) -> str:
    if preset not in PRESETS:
        raise ValueError(f"unknown preset {preset!r}")
    template = files("summarize_worker").joinpath(f"presets/{preset}.md").read_text(encoding="utf-8")
    language_text = "the same language as the reading" if language == "auto" else LANGUAGE_NAMES[language]
    return template.replace("{language}", language_text).replace("{fraction}", FRACTION_NAMES[fraction])
