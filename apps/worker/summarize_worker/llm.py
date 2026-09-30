"""OpenAI-compatible streaming client (NVIDIA in dev, Anthropic's OpenAI-compatible endpoint in prod)."""
import contextlib
import logging
import threading
import time
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Callable

from .config import Provider

log = logging.getLogger(__name__)

DEFAULT_REPLY = ("# Fake Summary\n\n**Fake Author** – Fake Source\n\n---\n\n## Introduction\n\n"
                 + "This is a generated test summary. " * 20 + "\n\n---\n\n## Conclusion\n\nEnd.")


class EmptyReply(RuntimeError):
    """The model streamed no content. truncated: the output cap ran out first (reasoning ate it), so a retry won't help."""

    def __init__(self, truncated: bool):
        super().__init__("empty reply" + (" (output cap reached before any text)" if truncated else ""))
        self.truncated = truncated


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0


class FakeClient:
    """LLM stand-in for tests and local e2e (LLM_BASE_URL=fake). Replies in order, then DEFAULT_REPLY."""

    def __init__(self, replies: list[str] | None = None):
        self.replies = list(replies or [])
        self.calls: list[list[dict]] = []
        self.kwargs: list[dict] = []  # the other create() arguments of each call (model, temperature, token param...)
        self.chat = self
        self.completions = self

    def create(self, *, messages, **kwargs):
        self.calls.append(messages)
        self.kwargs.append(kwargs)
        text = self.replies.pop(0) if self.replies else DEFAULT_REPLY
        return iter([
            SimpleNamespace(usage=None, choices=[SimpleNamespace(delta=SimpleNamespace(content=text), finish_reason="stop")]),
            SimpleNamespace(usage=SimpleNamespace(prompt_tokens=100, completion_tokens=50), choices=[]),
        ])


def make_client(provider: Provider):
    if provider.base_url == "fake":
        return FakeClient()
    from openai import OpenAI
    # 120 s timeout keeps a stalled stream well inside the 10-minute heartbeat window;
    # max_retries=0 because call_model already retries with its own backoff below.
    return OpenAI(base_url=provider.base_url, api_key=provider.api_key, timeout=120, max_retries=0)


_limiters: dict[tuple[str, int], threading.BoundedSemaphore] = {}
_limiters_lock = threading.Lock()


def limiter_for(provider: Provider) -> threading.BoundedSemaphore | None:
    """The process-wide semaphore of a provider with max_concurrency set (shared by every worker thread)."""
    if provider.max_concurrency is None:
        return None
    with _limiters_lock:
        return _limiters.setdefault((provider.id, provider.max_concurrency),
                                    threading.BoundedSemaphore(provider.max_concurrency))


def call_model(client, model: str, prompt: str, *, system: str = "", max_tokens: int = 32000, attempts: int = 5,
               on_tokens: Callable[[int], None] | None = None, usage: Usage | None = None,
               on_call: Callable[[int, int, int, bool], None] | None = None,
               temperature: float | None = 0.4, token_param: str = "max_tokens",
               limiter: threading.BoundedSemaphore | None = None) -> str:
    """Streams one completion. on_tokens(words_written) fires about every 2 s (also while the model reasons).
    on_call(input_tokens, output_tokens, duration_ms, ok) fires once when the call ends, success or final failure.
    temperature=None omits the parameter; token_param names the output cap parameter; limiter caps concurrent
    HTTP attempts per provider (held per attempt, not while backing off)."""
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
            params = {token_param: max_tokens, "stream": True, "stream_options": {"include_usage": True}}
            if temperature is not None:
                params["temperature"] = temperature
            with limiter or contextlib.nullcontext():  # ponytail: held for the HTTP attempt only, not the backoff
                stream = client.chat.completions.create(model=model, messages=messages, **params)
                parts, last, final_usage, truncated = [], 0.0, None, False
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
                        truncated = True
                        log.warning(f"output truncated at max_tokens={max_tokens}")
            tokens_in = getattr(final_usage, "prompt_tokens", 0) or 0
            tokens_out = getattr(final_usage, "completion_tokens", 0) or 0
            if usage is not None and final_usage is not None:
                usage.input_tokens += final_usage.prompt_tokens or 0
                usage.output_tokens += final_usage.completion_tokens or 0
            log.debug(f"llm call model={model} duration={time.time() - start:.1f}s "
                     f"in={getattr(final_usage, 'prompt_tokens', None)} out={getattr(final_usage, 'completion_tokens', None)}")
            text = "".join(parts).strip()
            if not text:  # never hand an empty draft downstream: the fact-check would answer "no draft provided"
                raise EmptyReply(truncated)
            report(True)
            return text
        except Exception as e:
            if attempt == attempts - 1 or (isinstance(e, EmptyReply) and e.truncated):
                report(False)
                raise
            wait = 2 ** attempt
            log.warning(f"LLM error ({e}); retrying in {wait}s")
            time.sleep(wait)
    raise RuntimeError("unreachable")
