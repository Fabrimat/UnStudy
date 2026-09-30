"""Lab judge: scores each chapter summary against its source text (accuracy, coverage, concision, structure)."""
import json
import logging
from typing import Callable

from .llm import Usage
from .pipeline import Phase, _call, recorder
from .text import Chapter

log = logging.getLogger(__name__)

CRITERIA = ("accuracy", "coverage", "concision", "structure")

JUDGE_INSTRUCTIONS = """You are a strict, consistent evaluator of academic summaries. You receive an ORIGINAL text, a SUMMARY of it, the target word count and the actual word count of the summary. Judge the SUMMARY against the ORIGINAL only: never use outside knowledge, and never reward what the original does not say.

Score each criterion with an integer from 1 (terrible) to 10 (excellent):
- accuracy: no factual errors, no invented facts or quotes, correct attributions.
- coverage: thesis, all original sections, numbered elements, definitions, cited authors and key examples are present.
- concision: a real synthesis near the target length. Penalize both transcription or over-length and omissions caused by over-cutting. The target and actual word counts matter here.
- structure: follows the requested template (headings in order, bold key terms, discursive paragraphs, no leftover placeholders).

Be strict: reserve 9-10 for near-flawless work and use the whole scale. In "issues" name concrete problems (wrong facts, invented quotes, missing sections, length problems), at most 5 short strings, the most important first; use an empty list if there are none.

Answer with ONLY a JSON object, no prose and no code fences:
{"accuracy": <int>, "coverage": <int>, "concision": <int>, "structure": <int>, "issues": ["...", "..."]}"""


def judge_prompt(original: str, summary: str, target_words: int, actual_words: int | str | None = None) -> str:
    """The judge user message; actual_words defaults to the summary's own word count (the Lab dump passes a placeholder)."""
    actual = len(summary.split()) if actual_words is None else actual_words
    return (f"Target length: about {target_words} words. Actual length of the summary: {actual} words.\n\n"
            f"ORIGINAL TEXT:\n\n{original}\n\n=====\n\nSUMMARY:\n\n{summary}")


def parse_scores(text: str) -> dict:
    """{criterion: int 1-10, ..., "issues": [<=5 strings of <=300 chars]} from the first JSON object in text
    (fences or prose around it are fine). ValueError when unusable."""
    start = text.find("{")
    if start < 0:
        raise ValueError("no JSON object in the judge reply")
    try:
        data, _ = json.JSONDecoder().raw_decode(text[start:])
    except json.JSONDecodeError as e:
        raise ValueError(f"invalid JSON in the judge reply: {e.msg}") from None
    if not isinstance(data, dict):
        raise ValueError("the judge reply is not a JSON object")
    out: dict = {}
    for k in CRITERIA:
        v = data.get(k)
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise ValueError(f"missing or non-numeric score: {k}")
        out[k] = max(1, min(10, round(v)))
    issues = data.get("issues")
    out["issues"] = [str(i)[:300] for i in issues[:5]] if isinstance(issues, list) else []
    return out


def _mean(pairs: list[tuple[float, int]]) -> float:
    return sum(v * w for v, w in pairs) / sum(w for _, w in pairs)


def evaluate(phase: Phase, chapters: list[Chapter], summaries: list[str], length_percent: int, *,
             usage: Usage | None = None, on_call: Callable[[dict], None] | None = None,
             on_progress: Callable[[int, int], None] | None = None) -> dict:
    """The Evaluation JSON of the contract. One judge call per chapter; a failing chapter is listed with
    scores=None and left out of the means. Never raises for model errors. on_progress(i, n) before each call and as a heartbeat while it runs."""
    results = []
    for i, (chapter, summary) in enumerate(zip(chapters, summaries)):
        def beat(_words: int = 0, i=i):  # heartbeat at every attempt and ~2 s while streaming, like draft/verify
            if on_progress:
                on_progress(i + 1, len(chapters))
        beat()
        try:
            reply = _call(phase, judge_prompt(chapter.text, summary, chapter.words * length_percent // 100),
                          system=JUDGE_INSTRUCTIONS, usage=usage, on_call=recorder(on_call, "judge", phase, i), on_tokens=beat)
            parsed = parse_scores(reply)
            entry = {"scores": {k: parsed[k] for k in CRITERIA}, "issues": parsed["issues"]}
        except Exception as e:  # call errors and parse errors alike: captured per chapter
            log.warning(f"judge failed on chapter {i + 1}: {e}")
            entry = {"scores": None, "issues": [f"judge failed: {str(e)[:200] or type(e).__name__}"]}
        results.append({"index": i, "title": chapter.title, **entry})
    ok = [(r, max(c.words, 1)) for r, c in zip(results, chapters) if r["scores"]]
    base = {"judge": phase.entry.id, "chapters": results}
    if not ok:
        return {**base, "overall": None, "scores": None, "error": "judge failed"}
    scores = {k: round(_mean([(r["scores"][k], w) for r, w in ok]), 1) for k in CRITERIA}
    return {**base, "overall": round(sum(scores.values()) / len(CRITERIA), 1), "scores": scores, "error": None}
