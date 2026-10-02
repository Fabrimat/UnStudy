"""Harness pipeline: plan -> draft -> (3 critics -> revise) x2 -> checks, one chapter at a time.
Used when job options carry harness=true; the classic pipeline stays the default."""
import json
import logging
from typing import Callable

from .checks import fix_format, run_checks
from .llm import Usage
from .pipeline import Phase, _call, _header, draft_prompt, recorder
from .text import Chapter

log = logging.getLogger(__name__)

ROUNDS = 2  # review -> revise rounds per chapter
LENGTH_BAND = (0.85, 1.15)  # accepted summary length, as a share of the target
MAX_CRITIC_ISSUES = 8
MAX_REVISE_ISSUES = 15

PLAN_INSTRUCTIONS = """You plan a summary of an academic text. You receive a target word count and the text, and the summary template the final summary must follow (below). Produce an outline whose sections follow the template's headings, in order.

For each section give: "heading" (the template heading, or a content heading where the template leaves it free), "points" (the concrete items of the ORIGINAL that section must cover: thesis, arguments, numbered elements, definitions, cited authors, key examples), and "words" (its word budget). The budgets must add up to the target. Use only what the original says.

Answer with ONLY a JSON object, no prose and no code fences:
{"sections": [{"heading": "...", "points": ["...", "..."], "words": <int>}]}

SUMMARY TEMPLATE:
"""

_ISSUES_FORMAT = """

Answer with ONLY a JSON object, no prose and no code fences, at most 8 issues, most important first; use an empty list when there is nothing to report:
{"issues": [{"excerpt": "<short quote from the summary>", "problem": "<what is wrong>", "fix": "<how to correct it>"}]}"""

FACT_INSTRUCTIONS = ("You are a strict fact-checker. You receive an ORIGINAL text and a SUMMARY of it. Judge the SUMMARY against "
                     "the ORIGINAL only: never use outside knowledge. Report only: wrong names, years, numbers or attributions; "
                     "claims the original does not make; quotes that are not verbatim in the original. Ignore style and omissions."
                     + _ISSUES_FORMAT)

COVERAGE_INSTRUCTIONS = ("You are a strict coverage reviewer. You receive an ORIGINAL text, a SUMMARY of it and possibly the "
                         "planned outline. Judge against the ORIGINAL only. Report only important items of the original that "
                         "the summary misses: thesis, sections, numbered elements, definitions, cited authors, key examples. "
                         "Do not ask for minor detail, and ignore style and facts that are present. In \"fix\" say what to add, "
                         "briefly, and where." + _ISSUES_FORMAT)

STYLE_INSTRUCTIONS = ("You are a strict style reviewer. You receive a SUMMARY and the summary template it must follow (below). "
                      "Report only: template violations (headings, order, format), repetition (for example a conclusion that "
                      "repeats earlier text), leftover placeholders, missing bold key terms. Do not judge facts or coverage."
                      + _ISSUES_FORMAT + "\n\nSUMMARY TEMPLATE:\n")

REVISE_RULES = """

---
You now correct an existing summary. You receive the ORIGINAL text, the CURRENT SUMMARY, a numbered list of issues and the target length. Apply ONLY the listed fixes and keep everything else as is. Judge against the ORIGINAL only. Return the whole corrected summary in Markdown and nothing else: no comments, no code fences."""


# --- prompts (shared by the real calls and the Lab dump) ---

def plan_prompt(target: int, text: str) -> str:
    return f"Target length: {target} words.\n\nTEXT:\n\n{text}"


def render_outline(plan: list[dict]) -> str:
    lines = ["Follow this outline; per-section word budgets are binding (±15%):"]
    for s in plan:
        lines.append(f"\n## {s['heading']} (~{s['words']} words)")
        lines += [f"- {p}" for p in s["points"]]
    return "\n".join(lines)


def harness_draft_prompt(chapter: Chapter, length_percent: int, bibliographic_line: str | None,
                         plan: list[dict] | None, text: str | None = None) -> str:
    """The classic draft message, with the outline placed before the reading text when a plan exists."""
    prompt = draft_prompt(chapter, length_percent, bibliographic_line, text)
    if not plan:
        return prompt
    marker = "Reading to summarize:"
    return prompt.replace(marker, render_outline(plan) + "\n\n" + marker, 1)


def pair_prompt(original: str, summary: str, outline: str = "") -> str:
    return (f"ORIGINAL TEXT:\n\n{original}\n\n=====\n\nSUMMARY:\n\n{summary}"
            + (f"\n\n=====\n\nPLANNED OUTLINE:\n\n{outline}" if outline else ""))


def format_issues(issues: list[dict]) -> str:
    return "\n".join(f"{n}. \"{i['excerpt']}\": {i['problem']} -> {i['fix']}"
                     for n, i in enumerate(issues[:MAX_REVISE_ISSUES], 1))


def revise_prompt(original: str, summary: str, issues: str, target: int) -> str:
    return (f"Target length: about {target} words.\n\nORIGINAL TEXT:\n\n{original}\n\n=====\n\nCURRENT SUMMARY:\n\n{summary}"
            f"\n\n=====\n\nISSUES TO FIX:\n\n{issues}")


# --- parsing ---

def _json_object(text: str) -> dict:
    """First JSON object in text (fences or prose around it are fine). ValueError when unusable."""
    start = text.find("{")
    if start < 0:
        raise ValueError("no JSON object in the reply")
    try:
        data, _ = json.JSONDecoder().raw_decode(text[start:])
    except json.JSONDecodeError as e:
        raise ValueError(f"invalid JSON in the reply: {e.msg}") from None
    if not isinstance(data, dict):
        raise ValueError("the reply is not a JSON object")
    return data


def parse_plan(text: str, target: int) -> list[dict]:
    """Sections [{heading, points, words}] with word budgets rescaled to sum to target. ValueError when unusable."""
    sections = _json_object(text).get("sections")
    if not isinstance(sections, list) or not sections:
        raise ValueError("no sections in the plan")
    out = []
    for s in sections:
        if (not isinstance(s, dict) or not isinstance(s.get("heading"), str) or not isinstance(s.get("points"), list)
                or isinstance(s.get("words"), bool) or not isinstance(s.get("words"), (int, float))):
            raise ValueError("malformed plan section")
        out.append({"heading": s["heading"], "points": [str(p) for p in s["points"]], "words": max(float(s["words"]), 0)})
    total = sum(s["words"] for s in out)
    for s in out:
        s["words"] = max(1, round(s["words"] / total * target)) if total else max(1, round(target / len(out)))
    return out


def parse_issues(text: str) -> list[dict]:
    """At most 8 {excerpt, problem, fix} dicts. ValueError when unusable."""
    issues = _json_object(text).get("issues")
    if not isinstance(issues, list):
        raise ValueError("no issues list in the reply")
    return [{k: str(i.get(k, ""))[:400] for k in ("excerpt", "problem", "fix")}
            for i in issues[:MAX_CRITIC_ISSUES] if isinstance(i, dict) and i.get("problem")]


def length_issue(words: int, target: int) -> list[dict]:
    if LENGTH_BAND[0] * target <= words <= LENGTH_BAND[1] * target:
        return []
    verb = "Cut" if words > target else "Expand"
    return [{"excerpt": "(whole summary)", "problem": f"The summary has {words} words, the target is {target}.",
             "fix": f"{verb} it to about {target} words, keeping the key content."}]


# --- Lab prompt dump ---

def prompts_dump(draft: Phase, critic: Phase | None, chapters: list[Chapter], instructions: str, *, length_percent: int,
                 bibliographic_line: str | None, judge: Phase | None = None) -> str:
    """Every message the harness sends, built by the same functions as the real calls, with chapter text, draft,
    outline and issues replaced by placeholders."""
    critic = critic or draft
    n = len(chapters)
    parts = [f"=== PLAN · model {draft.entry.id} ===\n[system]\n{PLAN_INSTRUCTIONS}{instructions}"]
    for i, c in enumerate(chapters):
        parts.append(f'[user · chapter {i + 1}/{n} "{c.title}"]\n'
                     + plan_prompt(c.words * length_percent // 100, f"<<chapter {i + 1} text: {c.words} words>>"))
    parts.append(f"=== DRAFT · model {draft.entry.id} ===\n[system]\n{instructions}")
    for i, c in enumerate(chapters):
        fake_plan = [{"heading": "<<heading>>", "points": ["<<points>>"], "words": 0}]
        prompt = harness_draft_prompt(c, length_percent, bibliographic_line, fake_plan, f"<<chapter {i + 1} text: {c.words} words>>")
        prompt = prompt.replace(render_outline(fake_plan), "<<outline from the plan, when the plan succeeded>>")
        parts.append(f'[user · chapter {i + 1}/{n} "{c.title}"]\n' + prompt)
    for name, system in (("FACT CRITIC", FACT_INSTRUCTIONS), ("COVERAGE CRITIC", COVERAGE_INSTRUCTIONS),
                         ("STYLE CRITIC", STYLE_INSTRUCTIONS + instructions)):
        parts.append(f"=== {name} · model {critic.entry.id} ===\n[system]\n{system}")
        for i, c in enumerate(chapters):
            original, summary = f"<<chapter {i + 1} text: {c.words} words>>", f"<<chapter {i + 1} draft summary>>"
            body = summary if name == "STYLE CRITIC" else pair_prompt(original, summary, "<<outline, when planned>>" if name == "COVERAGE CRITIC" else "")
            parts.append(f'[user · chapter {i + 1}/{n} "{c.title}"]\n{body}')
    parts.append(f"=== REVISE · model {draft.entry.id} (up to {ROUNDS} rounds) ===\n[system]\n{instructions}{REVISE_RULES}")
    for i, c in enumerate(chapters):
        parts.append(f'[user · chapter {i + 1}/{n} "{c.title}"]\n'
                     + revise_prompt(f"<<chapter {i + 1} text: {c.words} words>>", f"<<chapter {i + 1} current summary>>",
                                     "<<numbered issues>>", c.words * length_percent // 100))
    if judge is not None:
        from .judge import JUDGE_INSTRUCTIONS, judge_prompt  # lazy: judge imports pipeline
        parts.append(f"=== JUDGE · model {judge.entry.id} ===\n[system]\n{JUDGE_INSTRUCTIONS}")
        for i, c in enumerate(chapters):
            parts.append(f'[user · chapter {i + 1}/{n} "{c.title}"]\n'
                         + judge_prompt(f"<<chapter {i + 1} text: {c.words} words>>", f"<<chapter {i + 1} draft summary>>",
                                        c.words * length_percent // 100, "<<actual words>>"))
    return "\n\n".join(parts) + "\n"


# --- pipeline ---

def summarize_chapters(draft: Phase, chapters: list[Chapter], instructions: str, *, length_percent: int,
                       bibliographic_line: str | None, verify: Phase | None = None,
                       on_progress: Callable[[int, str], None] | None = None,
                       usage: Usage | None = None,
                       on_call: Callable[[dict], None] | None = None) -> tuple[str, list[str], list[str]]:
    """Same contract as pipeline.summarize_chapters. verify is the critic model (the draft model when None).
    Plan and critic failures never raise; draft and revise failures propagate."""
    critic = verify or draft
    n = len(chapters)
    summaries, warnings = [], []

    def progress(i: int, lo: float, hi: float, label: str, expected: int):
        # ponytail: a fixed share of the chapter per stage, interpolated by words written; reasoning time is not measurable
        def update(written: int):
            if on_progress:
                share = lo + (hi - lo) * min(written / max(expected, 1), 0.99)
                on_progress(min(int((i + share) / n * 100), 99), f"Chapter {i + 1}/{n}: {label}")
        return update

    def ask(p: Phase, rec_phase: str, system: str, prompt: str, i: int, lo: float, hi: float, label: str, expected: int) -> str:
        return _call(p, prompt, system=system, usage=usage, on_call=recorder(on_call, rec_phase, p, i),
                     on_tokens=progress(i, lo, hi, label, expected))

    for i, chapter in enumerate(chapters):
        log.info(f"Chapter {i + 1}/{n}: harness")
        header = _header(bibliographic_line, chapter)
        target = chapter.words * length_percent // 100

        plan = None
        try:
            plan = parse_plan(ask(draft, "draft", PLAN_INSTRUCTIONS + instructions, plan_prompt(target, chapter.text),
                                  i, 0.0, 0.1, "plan", 300), target)
        except Exception as e:  # call or parse failure: classic-style draft without outline
            log.warning(f"chapter {i + 1}: plan failed, drafting without outline: {e}")

        text = fix_format(ask(draft, "draft", instructions, harness_draft_prompt(chapter, length_percent, bibliographic_line, plan),
                              i, 0.1, 0.5, "draft", target), header)

        outline = render_outline(plan) if plan else ""
        for _ in range(ROUNDS):
            issues = length_issue(len(text.split()), target)
            # ponytail: critics run one after another because the DB call recorder shares a single psycopg
            # connection; parallel critics need a connection per thread.
            for system, prompt in ((FACT_INSTRUCTIONS, pair_prompt(chapter.text, text)),
                                   (COVERAGE_INSTRUCTIONS, pair_prompt(chapter.text, text, outline)),
                                   (STYLE_INSTRUCTIONS + instructions, text)):
                try:
                    issues += parse_issues(ask(critic, "verify", system, prompt, i, 0.5, 0.75, "review", len(text.split())))
                except Exception as e:  # a broken critic counts as no issues
                    log.warning(f"chapter {i + 1}: critic failed, ignored: {e}")
            if not issues:
                break
            revised = ask(draft, "draft", instructions + REVISE_RULES,
                          revise_prompt(chapter.text, text, format_issues(issues), target),
                          i, 0.75, 1.0, "revise", target)
            # ponytail: a much shorter answer is a refusal or a truncation, so the current text is kept
            if len(revised.split()) <= 0.5 * len(text.split()):
                log.warning(f"chapter {i + 1}: revision too short, kept the current text")
                break
            text = fix_format(revised, header)
        warnings += [f"chapter {i + 1}: {w}" for w in run_checks(text, chapter.text, length_percent)]
        summaries.append(text)
    return "\n\n---\n\n".join(summaries) + "\n", warnings, summaries
