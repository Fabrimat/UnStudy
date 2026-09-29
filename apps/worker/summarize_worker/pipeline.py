"""Draft -> fact-check -> format -> checks, one chapter at a time (from legacy riassumi_con_istruzioni)."""
import logging
from typing import Callable

from .checks import fix_format, run_checks
from .llm import Usage, call_model
from .prompts import VERIFY_INSTRUCTIONS
from .text import Chapter

log = logging.getLogger(__name__)


def _header(line: str | None, chapter: Chapter) -> str | None:
    if not line:
        return None
    if not chapter.page_from:
        return line
    if chapter.page_from == chapter.page_to:
        return f"{line}, p. {chapter.page_from}"
    return f"{line}, pp. {chapter.page_from}–{chapter.page_to}"


def summarize_chapters(client, model: str, chapters: list[Chapter], instructions: str, *, length_percent: int,
                       bibliographic_line: str | None, verify: bool = True,
                       on_progress: Callable[[int, str], None] | None = None,
                       usage: Usage | None = None,
                       on_call: Callable[[dict], None] | None = None) -> tuple[str, list[str]]:
    """Returns the whole Markdown and the check warnings. on_progress(percent 0-99, phase)."""
    phases = 2 if verify else 1
    steps = len(chapters) * phases
    summaries, warnings = [], []

    def progress(step: int, phase: str, expected_words: int):
        # ponytail: estimated from words written vs expected; reasoning time is not measurable
        def update(written: int):
            if on_progress:
                share = min(written / max(expected_words, 1), 0.99)
                on_progress(int((step + share) / steps * 100), phase)
        return update

    def recorder(phase: str, chapter: int):
        if not on_call:
            return None
        return lambda tin, tout, ms, ok: on_call({"phase": phase, "chapter": chapter, "model": model,
                                                  "inputTokens": tin, "outputTokens": tout,
                                                  "durationMs": ms, "ok": ok})

    for i, chapter in enumerate(chapters):
        label = f"Chapter {i + 1}/{len(chapters)}"
        header = _header(bibliographic_line, chapter)
        target = chapter.words * length_percent // 100
        prompt = f"Target length: about {target} words ({length_percent}% of the original).\n\n"
        if header:
            prompt += f"Use exactly this bibliographic line under the title:\n{header}\n\n"
        prompt += f"Reading to summarize:\n\n{chapter.text}"
        step = i * phases
        log.info(f"{label}: draft")
        text = fix_format(call_model(client, model, prompt, system=instructions, usage=usage,
                                     on_call=recorder("draft", i),
                                     on_tokens=progress(step, f"{label}: draft", target)), header)
        if verify:
            log.info(f"{label}: fact-check")
            checked = call_model(client, model,
                                 f"ORIGINAL TEXT:\n\n{chapter.text}\n\n=====\n\nDRAFT SUMMARY:\n\n{text}",
                                 system=VERIFY_INSTRUCTIONS, usage=usage,
                                 on_call=recorder("verify", i),
                                 on_tokens=progress(step + 1, f"{label}: fact-check", len(text.split())))
            # ponytail: a much shorter answer is a refusal or a truncation, so the draft is kept
            if len(checked.split()) > 0.7 * len(text.split()):
                text = fix_format(checked, header)
        warnings += [f"chapter {i + 1}: {w}" for w in run_checks(text, chapter.text, length_percent)]
        summaries.append(text)
    return "\n\n---\n\n".join(summaries) + "\n", warnings
