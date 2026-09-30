import socket
import threading
import time
import zipfile
from io import BytesIO
from types import SimpleNamespace

import pytest

from summarize_worker.docx import to_docx
from summarize_worker.llm import DEFAULT_REPLY, EmptyReply, FakeClient, Usage, call_model, limiter_for, make_client
from summarize_worker.config import ModelEntry, Provider
from summarize_worker.pipeline import Phase, summarize_chapters
from summarize_worker.text import Chapter


def _phase(client, model="m", provider="p", temperature=0.4):
    return Phase(client, ModelEntry(f"{model}-id", model, provider, temperature), Provider(provider, "openai", "fake"))


class FlakyClient:
    """Fails `fail_times` calls, then streams one short reply. LLM stand-in for call_model's retry loop."""

    def __init__(self, fail_times: int):
        self.fail_times = fail_times
        self.calls = 0
        self.chat = self
        self.completions = self

    def create(self, **_):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise RuntimeError("LLM down")
        return iter([
            SimpleNamespace(usage=None, choices=[SimpleNamespace(delta=SimpleNamespace(content="hello"), finish_reason="stop")]),
            SimpleNamespace(usage=SimpleNamespace(prompt_tokens=1, completion_tokens=1), choices=[]),
        ])


def test_each_chapter_gets_a_draft_and_a_fact_check():
    client, progress, usage = FakeClient(), [], Usage()
    chapters = [Chapter("A", 9, 29, "alpha " * 300), Chapter("B", 30, 30, "beta " * 300)]
    md, warnings, summaries = summarize_chapters(_phase(client), chapters, "SYSTEM", length_percent=33, verify=_phase(client),
                                      bibliographic_line="**Lijphart** – *Patterns*",
                                      on_progress=lambda p, ph: progress.append((p, ph)), usage=usage)
    assert len(client.calls) == 4
    assert client.calls[0][0] == {"role": "system", "content": "SYSTEM"}
    assert "about 99 words (33% of the original)" in client.calls[0][1]["content"]
    assert "ORIGINAL TEXT:" in client.calls[1][1]["content"]
    assert "**Lijphart** – *Patterns*, pp. 9–29" in md and "**Lijphart** – *Patterns*, p. 30" in md
    assert md.count("# Fake Summary") == 2 and "\n\n---\n\n" in md
    assert (usage.input_tokens, usage.output_tokens) == (400, 200)
    percents = [p for p, _ in progress]
    assert percents == sorted(percents) and all(0 <= p < 100 for p in percents)
    assert any(ph == "Chapter 2/2: fact-check" for _, ph in progress)
    assert all(w.startswith("chapter ") for w in warnings)
    assert len(summaries) == 2 and "\n\n---\n\n".join(summaries) + "\n" == md


def test_a_too_short_fact_check_keeps_the_draft():
    client = FakeClient(replies=[DEFAULT_REPLY, "Sorry, I cannot help."])
    md, _, _ = summarize_chapters(_phase(client), [Chapter("A", None, None, "alpha " * 300)], "S", verify=_phase(client),
                               length_percent=33, bibliographic_line="**A** – *B*")
    assert "Fake Summary" in md and "Sorry" not in md
    assert "**A** – *B*\n" in md  # no page range known


def test_fake_client_is_selected_by_base_url():
    assert isinstance(make_client(Provider("p", "openai", "fake")), FakeClient)


def test_call_model_heartbeats_every_attempt_and_survives_retries(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda _: None)
    client = FlakyClient(fail_times=2)
    heartbeats = []
    text = call_model(client, "m", "prompt", on_tokens=heartbeats.append)
    assert text == "hello"
    assert client.calls == 3
    assert heartbeats.count(0) >= 3  # one heartbeat at the start of each of the 3 attempts


def test_draft_and_verify_hit_their_own_clients_and_record_who_ran():
    draft_client, verify_client, records = FakeClient(), FakeClient(), []
    summarize_chapters(_phase(draft_client, "dm", "pa"), [Chapter("A", None, None, "alpha " * 300)], "S",
                       length_percent=33, bibliographic_line=None, verify=_phase(verify_client, "vm", "pb"),
                       on_call=records.append)
    assert len(draft_client.calls) == 1 and len(verify_client.calls) == 1
    assert draft_client.kwargs[0]["model"] == "dm" and verify_client.kwargs[0]["model"] == "vm"
    assert [(r["phase"], r["model"], r["provider"], r["modelId"]) for r in records] == [
        ("draft", "dm", "pa", "dm-id"), ("verify", "vm", "pb", "vm-id")]


def test_no_verify_phase_means_no_fact_check_call():
    client, progress = FakeClient(), []
    summarize_chapters(_phase(client), [Chapter("A", None, None, "alpha " * 300)], "S", length_percent=33,
                       bibliographic_line=None, verify=None, on_progress=lambda p, ph: progress.append(ph))
    assert len(client.calls) == 1 and not any("fact-check" in ph for ph in progress)


def test_call_model_omits_temperature_when_none_and_sends_it_otherwise():
    client = FakeClient()
    call_model(client, "m", "p", temperature=None)
    call_model(client, "m", "p")
    assert "temperature" not in client.kwargs[0] and client.kwargs[1]["temperature"] == 0.4


def test_call_model_token_param():
    client = FakeClient()
    call_model(client, "m", "p", max_tokens=7)
    call_model(client, "m", "p", max_tokens=7, token_param="max_completion_tokens")
    assert client.kwargs[0]["max_tokens"] == 7 and "max_completion_tokens" not in client.kwargs[0]
    assert client.kwargs[1]["max_completion_tokens"] == 7 and "max_tokens" not in client.kwargs[1]


def test_provider_semaphore_bounds_concurrent_calls_across_threads():
    limiter = limiter_for(Provider("sem-test", "openai", "fake", max_concurrency=2))
    assert limiter is limiter_for(Provider("sem-test", "openai", "fake", max_concurrency=2))  # shared per process
    assert limiter_for(Provider("free", "openai", "fake")) is None
    lock, state = threading.Lock(), {"now": 0, "peak": 0}

    class Slow(FakeClient):
        def create(self, **kw):
            with lock:
                state["now"] += 1
                state["peak"] = max(state["peak"], state["now"])
            time.sleep(0.05)
            with lock:
                state["now"] -= 1
            return super().create(**kw)

    client = Slow()
    threads = [threading.Thread(target=call_model, args=(client, "m", "p"), kwargs={"limiter": limiter}) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(client.calls) == 6 and state["peak"] == 2


def test_docx_has_real_headings():
    data = to_docx("# Title\n## Part\ntext")
    assert data[:2] == b"PK"
    xml = zipfile.ZipFile(BytesIO(data)).read("word/document.xml")
    assert b"Heading1" in xml and b"Heading2" in xml


def test_docx_sandboxes_image_fetches():
    """LLM output can contain markdown image links; pandoc must never fetch them (SSRF / local file read)."""
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    port = srv.getsockname()[1]
    srv.settimeout(1)
    connections = []

    def accept_once():
        try:
            connections.append(srv.accept())
        except socket.timeout:
            pass

    t = threading.Thread(target=accept_once)
    t.start()
    try:
        data = to_docx(f"# T\n![x](http://127.0.0.1:{port}/evil.png)\n![y](/etc/passwd)\n")
    finally:
        t.join()
        srv.close()
    assert data[:2] == b"PK"
    assert connections == []  # pandoc never opened a socket to fetch the "remote" image


def test_a_raising_on_call_neither_retries_nor_changes_the_result():
    client = FakeClient(["hello"])

    def boom(*_):
        raise RuntimeError("recorder down")
    assert call_model(client, "fake", "p", on_call=boom) == "hello"
    assert len(client.calls) == 1


class _EmptyClient:
    def __init__(self, finish_reason: str):
        self.finish_reason, self.calls = finish_reason, 0
        self.chat = self.completions = self

    def create(self, **_):
        self.calls += 1
        return iter([SimpleNamespace(usage=None, choices=[SimpleNamespace(delta=SimpleNamespace(content=None),
                                                                          finish_reason=self.finish_reason)])])


def test_empty_reply_raises_and_retries_only_when_not_truncated(monkeypatch):
    monkeypatch.setattr("summarize_worker.llm.time.sleep", lambda s: None)
    empty, capped = _EmptyClient("stop"), _EmptyClient("length")
    with pytest.raises(EmptyReply):
        call_model(empty, "m", "p", attempts=3)
    with pytest.raises(EmptyReply):
        call_model(capped, "m", "p", attempts=3)
    assert (empty.calls, capped.calls) == (3, 1)


def test_lab_error_masks_keys_and_is_capped():
    from summarize_worker.db import lab_error
    text = lab_error(RuntimeError("401 bad key sk-abcdef1234567890 and Bearer nvapi-xyz " + "x" * 600))
    assert text.startswith("RuntimeError: 401 bad key *** and *** ") and "abcdef" not in text and "nvapi" not in text
    assert len(text) == 500
