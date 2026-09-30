"""Draft -> fact-check -> format -> checks, one chapter at a time (from legacy riassumi_con_istruzioni)."""
import logging
from dataclasses import dataclass
from typing import Callable

from .checks import fix_format, run_checks
from .config import ModelEntry, Provider
from .llm import Usage, call_model, limiter_for
from .prompts import VERIFY_INSTRUCTIONS
from .text import Chapter

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Phase:
    """Where one phase (draft or verify) runs: the provider's client, the catalogue entry and its provider."""
    client: object
    entry: ModelEntry
    provider: Provider | None = None  # token parameter and concurrency limit; defaults when absent


def _call(phase: Phase, prompt: str, **kw) -> str:
    p = phase.provider
    return call_model(phase.client, phase.entry.model, prompt, temperature=phase.entry.temperature,
                      token_param=p.token_param if p else "max_tokens", limiter=limiter_for(p) if p else None, **kw)


def recorder(on_call: Callable[[dict], None] | None, phase: str, target: Phase, chapter: int):
    """call_model's on_call callback that reports one LlmCall record; None when nobody listens."""
    if not on_call:
        return None
    return lambda tin, tout, ms, ok: on_call({"phase": phase, "chapter": chapter, "model": target.entry.model,
                                              "provider": target.entry.provider, "modelId": target.entry.id,
                                              "inputTokens": tin, "outputTokens": tout,
                                              "durationMs": ms, "ok": ok})


def _header(line: str | None, chapter: Chapter) -> str | None:
    if not line:
        return None
    if not chapter.page_from:
        return line
    if chapter.page_from == chapter.page_to:
        return f"{line}, p. {chapter.page_from}"
    return f"{line}, pp. {chapter.page_from}–{chapter.page_to}"


def draft_prompt(chapter: Chapter, length_percent: int, bibliographic_line: str | None, text: str | None = None) -> str:
    """The draft user message; text overrides the chapter text (the Lab prompt dump uses a placeholder)."""
    header = _header(bibliographic_line, chapter)
    prompt = (f"Target length: about {chapter.words * length_percent // 100} words "
              f"({length_percent}% of the original).\n\n")
    if header:
        prompt += f"Use exactly this bibliographic line under the title:\n{header}\n\n"
    return prompt + f"Reading to summarize:\n\n{chapter.text if text is None else text}"


def verify_prompt(original: str, draft: str) -> str:
    return f"ORIGINAL TEXT:\n\n{original}\n\n=====\n\nDRAFT SUMMARY:\n\n{draft}"


def prompts_dump(draft: Phase, verify: Phase | None, chapters: list[Chapter], instructions: str, *,
                 length_percent: int, bibliographic_line: str | None, judge: Phase | None = None) -> str:
    """Every message the run sends, built by the same functions as the real calls, with the chapter and
    draft texts replaced by placeholders so the file stays small."""
    n = len(chapters)

    def placeholders(i: int, c: Chapter) -> tuple[str, str]:
        return f"<<chapter {i + 1} text: {c.words} words>>", f"<<chapter {i + 1} draft summary>>"

    parts = [f"=== DRAFT \u00b7 model {draft.entry.id} ===\n[system]\n{instructions}"]
    for i, c in enumerate(chapters):
        parts.append(f'[user \u00b7 chapter {i + 1}/{n} "{c.title}"]\n'
                     + draft_prompt(c, length_percent, bibliographic_line, placeholders(i, c)[0]))
    if verify is not None:
        parts.append(f"=== FACT-CHECK \u00b7 model {verify.entry.id} ===\n[system]\n{VERIFY_INSTRUCTIONS}")
        for i, c in enumerate(chapters):
            parts.append(f'[user \u00b7 chapter {i + 1}/{n} "{c.title}"]\n' + verify_prompt(*placeholders(i, c)))
    if judge is not None:
        from .judge import JUDGE_INSTRUCTIONS, judge_prompt  # lazy: judge imports this module
        parts.append(f"=== JUDGE · model {judge.entry.id} ===\n[system]\n{JUDGE_INSTRUCTIONS}")
        for i, c in enumerate(chapters):
            original, summary = placeholders(i, c)
            parts.append(f'[user · chapter {i + 1}/{n} "{c.title}"]\n'
                         + judge_prompt(original, summary, c.words * length_percent // 100, "<<actual words>>"))
    return "\n\n".join(parts) + "\n"


def summarize_chapters(draft: Phase, chapters: list[Chapter], instructions: str, *, length_percent: int,
                       bibliographic_line: str | None, verify: Phase | None = None,
                       on_progress: Callable[[int, str], None] | None = None,
                       usage: Usage | None = None,
                       on_call: Callable[[dict], None] | None = None) -> tuple[str, list[str], list[str]]:
    """Returns the whole Markdown, the check warnings and the per-chapter summaries. verify=None skips the fact-check.
    on_progress(percent 0-99, phase)."""
    phases = 2 if verify is not None else 1
    steps = len(chapters) * phases
    summaries, warnings = [], []

    def progress(step: int, phase: str, expected_words: int):
        # ponytail: estimated from words written vs expected; reasoning time is not measurable
        def update(written: int):
            if on_progress:
                share = min(written / max(expected_words, 1), 0.99)
                on_progress(int((step + share) / steps * 100), phase)
        return update

    for i, chapter in enumerate(chapters):
        label = f"Chapter {i + 1}/{len(chapters)}"
        header = _header(bibliographic_line, chapter)
        target = chapter.words * length_percent // 100
        prompt = draft_prompt(chapter, length_percent, bibliographic_line)
        step = i * phases
        log.info(f"{label}: draft")
        text = fix_format(_call(draft, prompt, system=instructions, usage=usage,
                                on_call=recorder(on_call, "draft", draft, i),
                                on_tokens=progress(step, f"{label}: draft", target)), header)
        if verify is not None:
            log.info(f"{label}: fact-check")
            checked = _call(verify,
                            verify_prompt(chapter.text, text),
                            system=VERIFY_INSTRUCTIONS, usage=usage,
                            on_call=recorder(on_call, "verify", verify, i),
                            on_tokens=progress(step + 1, f"{label}: fact-check", len(text.split())))
            # ponytail: a much shorter answer is a refusal or a truncation, so the draft is kept
            if len(checked.split()) > 0.7 * len(text.split()):
                text = fix_format(checked, header)
        warnings += [f"chapter {i + 1}: {w}" for w in run_checks(text, chapter.text, length_percent)]
        summaries.append(text)
    return "\n\n---\n\n".join(summaries) + "\n", warnings, summaries
