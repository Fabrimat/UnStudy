"""OpenAI-compatible streaming client (NVIDIA in dev, Anthropic's OpenAI-compatible endpoint in prod)."""
import time
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Callable

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
    # 300 s timeout keeps a stalled stream well inside the 10-minute heartbeat window
    return OpenAI(base_url=base_url, api_key=api_key, timeout=300)


def call_model(client, model: str, prompt: str, *, system: str = "", max_tokens: int = 32000, attempts: int = 5,
               on_tokens: Callable[[int], None] | None = None, usage: Usage | None = None) -> str:
    """Streams one completion. on_tokens(words_written) fires about every 2 s (also while the model reasons)."""
    messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}]
    for attempt in range(attempts):
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
                    print(f"warning: output truncated at max_tokens={max_tokens}")
            if usage is not None and final_usage is not None:
                usage.input_tokens += final_usage.prompt_tokens or 0
                usage.output_tokens += final_usage.completion_tokens or 0
            return "".join(parts).strip()
        except Exception as e:
            if attempt == attempts - 1:
                raise
            wait = 2 ** attempt
            print(f"LLM error ({e}); retrying in {wait}s")
            time.sleep(wait)
    raise RuntimeError("unreachable")
