"""OpenAI-compatible streaming client (NVIDIA in dev, Anthropic's OpenAI-compatible endpoint in prod)."""
import logging
import time
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Callable

log = logging.getLogger(__name__)

DEFAULT_REPLY = ("# Fake Summary\n\n**Fake Author** – Fake Source\n\n---\n\n## Introduction\n\n"
                 + "This is a generated test summary. " * 20 + "\n\n---\n\n## Conclusion\n\nEnd.")


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0


class FakeClient:
    """LLM stand-in for tests and local e2e (LLM_BASE_URL=fake). Replies in order, then DEFAULT_REPLY."""

    def __init__(self, replies: list[str] | None = None):
        self.replies = list(replies or [])
        self.calls: list[list[dict]] = []
        self.chat = self
        self.completions = self

    def create(self, *, messages, **_):
        self.calls.append(messages)
        text = self.replies.pop(0) if self.replies else DEFAULT_REPLY
        return iter([
            SimpleNamespace(usage=None, choices=[SimpleNamespace(delta=SimpleNamespace(content=text), finish_reason="stop")]),
            SimpleNamespace(usage=SimpleNamespace(prompt_tokens=100, completion_tokens=50), choices=[]),
        ])


def make_client(base_url: str, api_key: str):
    if base_url == "fake":
        return FakeClient()
    from openai import OpenAI
    # 120 s timeout keeps a stalled stream well inside the 10-minute heartbeat window;
    # max_retries=0 because call_model already retries with its own backoff below.
    return OpenAI(base_url=base_url, api_key=api_key, timeout=120, max_retries=0)


def call_model(client, model: str, prompt: str, *, system: str = "", max_tokens: int = 32000, attempts: int = 5,
               on_tokens: Callable[[int], None] | None = None, usage: Usage | None = None,
               on_call: Callable[[int, int, int, bool], None] | None = None) -> str:
    """Streams one completion. on_tokens(words_written) fires about every 2 s (also while the model reasons).
    on_call(input_tokens, output_tokens, duration_ms, ok) fires once when the call ends, success or final failure."""
    # ponytail: one on_call per logical call, not per HTTP retry; tokens are those of the last attempt
    # (a failed attempt reports none) and duration spans all attempts including backoff.
    call_start = time.time()
    tokens_in = tokens_out = 0

    def report(ok: bool):
        if on_call:
            try:
                on_call(tokens_in, tokens_out, int((time.time() - call_start) * 1000), ok)
            except Exception:
                log.warning("on_call failed", exc_info=True)  # a recorder must never cost a retry or mask the real error

    messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}]
    for attempt in range(attempts):
        if on_tokens:
            on_tokens(0)  # heartbeat at the start of every attempt, so a slow/failing call still heartbeats
        start = time.time()
        try:
            stream = client.chat.completions.create(model=model, messages=messages, max_tokens=max_tokens,
                                                    temperature=0.4, stream=True,
                                                    stream_options={"include_usage": True})
            parts, last, final_usage = [], 0.0, None
            for event in stream:
                if on_tokens and time.time() - last > 2:
                    on_tokens(len("".join(parts).split()))
                    last = time.time()
                if getattr(event, "usage", None):
                    final_usage = event.usage
                if not event.choices:
                    continue
                choice = event.choices[0]
                if choice.delta.content:
                    parts.append(choice.delta.content)
                if choice.finish_reason == "length":
                    log.warning(f"output truncated at max_tokens={max_tokens}")
            tokens_in = getattr(final_usage, "prompt_tokens", 0) or 0
            tokens_out = getattr(final_usage, "completion_tokens", 0) or 0
            if usage is not None and final_usage is not None:
                usage.input_tokens += final_usage.prompt_tokens or 0
                usage.output_tokens += final_usage.completion_tokens or 0
            log.debug(f"llm call model={model} duration={time.time() - start:.1f}s "
                     f"in={getattr(final_usage, 'prompt_tokens', None)} out={getattr(final_usage, 'completion_tokens', None)}")
            report(True)
            return "".join(parts).strip()
        except Exception as e:
            if attempt == attempts - 1:
                report(False)
                raise
            wait = 2 ** attempt
            log.warning(f"LLM error ({e}); retrying in {wait}s")
            time.sleep(wait)
    raise RuntimeError("unreachable")
