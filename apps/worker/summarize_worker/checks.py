"""Model-free checks and formatting (ported unchanged in logic from legacy/riassumi_libro.py)."""
import re

SMALL_WORDS = {"a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "vs"}


def normalize(text: str) -> str:
    # PDF text for comparisons: ligatures, hyphenated line breaks, quotes, whitespace.
    text = text.replace("ﬁ", "fi").replace("ﬂ", "fl").replace("ﬀ", "ff")
    text = re.sub(r"(\w)-\s+(\w)", r"\1\2", text)
    text = text.translate(str.maketrans("“”‘’–—", "\"\"''--"))
    return re.sub(r"\s+", " ", text).lower()


def _letters(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", normalize(s))


def run_checks(summary: str, original: str, length_percent: int = 33) -> list[str]:
    """Quotes not found in the original, leftover [placeholders], length off target. Never blocks delivery."""
    problems = []
    # running headers like "CONSENSUS MODEL OF DEMOCRACY  45" split quotes across pages: drop them first
    original = re.sub(r"^(?:\d+\s+)?[A-Z][A-Z ,:;'’\-–]{3,}(?:\s+\d+)?\s*$", " ", original, flags=re.M)
    source = _letters(original)
    # curly and straight quotes are matched separately: mixing them pairs one style's opening with the other's closing
    quotes = re.findall(r"“([^“”\n]{8,400}?)”", summary) + re.findall(r"\"([^\"\n]{8,400}?)\"", summary)
    for quote in quotes:
        # ponytail: 5-word chunks, letters only; tolerates page breaks, split ligatures and [editorial] inserts.
        # 80% threshold: a near-verbatim paraphrase can slip through.
        words = re.sub(r"\*\*|[\[\]]", " ", quote).split()
        chunks = [c for c in (_letters(" ".join(words[j:j + 5])) for j in range(0, len(words), 5)) if c]
        if chunks and sum(c in source for c in chunks) < 0.8 * len(chunks):
            problems.append(f"quote not found in the text: \"{quote}\"")
    outside_quotes = re.sub(r"“[^“”\n]*”|\"[^\"\n]*\"", "", summary)  # [..] inside quotes are legitimate inserts
    for leftover in re.findall(r"\[[^\]]*\]", outside_quotes):
        problems.append(f"square brackets left: {leftover}")
    words, target = len(summary.split()), len(original.split()) * length_percent // 100
    if not 0.75 * target <= words <= 1.25 * target:
        problems.append(f"length {words} words, target ~{target}")
    return problems


def fix_format(text: str, header: str | None) -> str:
    text = re.sub(r"\n*^---[ \t]*$\n*", "\n\n---\n\n", text, flags=re.M)  # avoid setext headings
    text = re.sub(r"[ \t]+$", "", text, flags=re.M)
    text = re.sub(r"\n*^(#{1,6} .*)$\n*", r"\n\n\1\n\n", text, flags=re.M)  # pandoc needs blank lines around headings

    def title_case(m):  # ALL CAPS headings copied from the PDF -> Title Case
        words = m.group(2).lower().split()
        return m.group(1) + " ".join(w if j and w in SMALL_WORDS else w[:1].upper() + w[1:] for j, w in enumerate(words))

    text = re.sub(r"^(#{1,6} )([^a-z\n]*[A-Z]{3}[^a-z\n]*)$", title_case, text, flags=re.M)
    text = re.sub(r"\n{3,}", "\n\n", text)
    if header:  # the bibliographic line is imposed, not guessed by the model
        text = re.sub(r"^\*\*.*$", lambda _: header, text, count=1, flags=re.M)
    return text.strip()
