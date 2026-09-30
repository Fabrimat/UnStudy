import pytest

from summarize_worker.config import ModelEntry, Provider
from summarize_worker.judge import evaluate, judge_prompt, parse_scores
from summarize_worker.llm import FakeClient, Usage
from summarize_worker.pipeline import Phase
from summarize_worker.text import Chapter

GOOD = '{"accuracy": 8, "coverage": 6, "concision": 7, "structure": 9, "issues": ["missing section 2"]}'


def _phase(client):
    return Phase(client, ModelEntry("judge-id", "jm", "p", None), Provider("p", "openai", "fake"))


def test_parse_fenced_and_prose():
    assert parse_scores(f"```json\n{GOOD}\n```")["accuracy"] == 8
    assert parse_scores(f"Sure! Here you go: {GOOD} Hope it helps.")["issues"] == ["missing section 2"]


def test_parse_clamps_and_truncates():
    out = parse_scores('{"accuracy": 15, "coverage": 0, "concision": 7.6, "structure": 3, "issues": ["x"]}'.replace('["x"]', str(["a" * 400] * 7).replace("'", '"')))
    assert (out["accuracy"], out["coverage"], out["concision"]) == (10, 1, 8)
    assert len(out["issues"]) == 5 and all(len(i) == 300 for i in out["issues"])


@pytest.mark.parametrize("text", ["nope", "{broken", "[1, 2]", '{"accuracy": 5}', '{"accuracy": "x", "coverage": 1, "concision": 1, "structure": 1}'])
def test_parse_garbage_raises(text):
    with pytest.raises(ValueError):
        parse_scores(text)


def test_prompt_has_counts():
    p = judge_prompt("orig", "a b c", 50)
    assert "about 50 words" in p and "3 words" in p and "orig" in p


CHAPTERS = [Chapter("A", None, None, "x " * 300), Chapter("B", None, None, "y " * 100)]


def test_evaluate_weights_by_source_words_and_records_calls():
    second = '{"accuracy": 4, "coverage": 2, "concision": 3, "structure": 5, "issues": []}'
    client, records, usage = FakeClient([GOOD, second]), [], Usage()
    ev = evaluate(_phase(client), CHAPTERS, ["s1", "s2"], 20, usage=usage, on_call=records.append)
    assert ev["error"] is None and ev["judge"] == "judge-id"
    assert ev["scores"] == {"accuracy": 7.0, "coverage": 5.0, "concision": 6.0, "structure": 8.0}  # 3:1 weights
    assert ev["overall"] == 6.5
    assert [c["index"] for c in ev["chapters"]] == [0, 1] and ev["chapters"][1]["scores"]["accuracy"] == 4
    assert [r["phase"] for r in records] == ["judge", "judge"] and usage.input_tokens == 200


def test_evaluate_one_failing_chapter_is_excluded():
    ev = evaluate(_phase(FakeClient([GOOD, "garbage"])), CHAPTERS, ["s1", "s2"], 20)
    assert ev["scores"]["accuracy"] == 8.0 and ev["error"] is None
    assert ev["chapters"][1]["scores"] is None and ev["chapters"][1]["issues"][0].startswith("judge failed")


def test_evaluate_all_failing_sets_error():
    ev = evaluate(_phase(FakeClient(["no", "nope"])), CHAPTERS, ["s1", "s2"], 20)
    assert (ev["overall"], ev["scores"], ev["error"]) == (None, None, "judge failed") and len(ev["chapters"]) == 2


def test_evaluate_survives_call_errors(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda _: None)

    class Down(FakeClient):
        def create(self, **kw):
            raise RuntimeError("down")
    ev = evaluate(_phase(Down()), CHAPTERS[:1], ["s1"], 20)
    assert ev["error"] == "judge failed" and "down" in ev["chapters"][0]["issues"][0]

def test_evaluate_heartbeats_while_calling():
    beats = []
    evaluate(_phase(FakeClient([GOOD])), CHAPTERS[:1], ["s1"], 20, on_progress=lambda i, n: beats.append((i, n)))
    assert len(beats) >= 2 and set(beats) == {(1, 1)}  # once up front, once per attempt (on_tokens(0))

