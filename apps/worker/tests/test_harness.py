import json

from summarize_worker import harness
from summarize_worker.config import ModelEntry, Provider
from summarize_worker.llm import FakeClient
from summarize_worker.pipeline import Phase
from summarize_worker.text import Chapter

CH = [Chapter("A", 1, 2, "alpha " * 300)]  # 33% -> target 99
GOOD = "# T\n\n" + "word " * 99
REVISED = "# T\n\n" + "fixed " * 99
PLAN = json.dumps({"sections": [{"heading": "Intro", "points": ["thesis"], "words": 10},
                                {"heading": "Body", "points": ["a", "b"], "words": 30}]})
ISSUES = json.dumps({"issues": [{"excerpt": "x", "problem": "wrong year", "fix": "use 1999"}]})
NONE = json.dumps({"issues": []})


def phase(client, name="m"):
    return Phase(client, ModelEntry(f"{name}-id", name, "p", 0.4), Provider("p", "openai", "fake"))


def run(replies, verify=False, **kw):
    client, recs = FakeClient(replies=replies), []
    out = harness.summarize_chapters(phase(client), CH, "SYSTEM", length_percent=33, bibliographic_line=None,
                                     verify=phase(client, "v") if verify else None, on_call=recs.append, **kw)
    return client, recs, out


def test_full_path_revises_once_then_stops():
    progress = []
    client, recs, (md, _, summaries) = run(
        [PLAN, GOOD, ISSUES, NONE, NONE, REVISED, NONE, NONE, NONE], verify=True,
        on_progress=lambda p, ph: progress.append((p, ph)))
    assert len(client.calls) == 9
    assert [r["phase"] for r in recs] == ["draft", "draft"] + ["verify"] * 3 + ["draft"] + ["verify"] * 3
    assert {r["model"] for r in recs if r["phase"] == "verify"} == {"v"}
    assert "Intro (~" in client.calls[1][1]["content"] and client.calls[1][1]["content"].index("Follow this outline") < client.calls[1][1]["content"].index("Reading to summarize")
    assert "1. \"x\": wrong year -> use 1999" in client.calls[5][1]["content"]
    assert "fixed" in md and summaries == [md.rstrip("\n")]
    assert any(ph == "Chapter 1/1: revise" for _, ph in progress) and all(0 <= p < 100 for p, _ in progress)


def test_unparsable_plan_drafts_without_outline():
    client, recs, (md, _, _) = run(["nope", GOOD] + [NONE] * 3)
    assert "Follow this outline" not in client.calls[1][1]["content"] and "word" in md
    assert len(client.calls) == 5


def test_garbage_critic_is_ignored_and_critic_falls_back_to_draft_model():
    client, recs, (md, _, _) = run([PLAN, GOOD, "garbage", ISSUES, "{broken"])
    assert len(client.calls) == 10  # round 1 revises on the coverage issue, round 2 on the default reply length
    assert {r["model"] for r in recs if r["phase"] == "verify"} == {"m"}


def test_short_revision_keeps_previous_text():
    _, _, (md, _, _) = run([PLAN, GOOD, ISSUES, NONE, NONE, "Sorry."])
    assert "word" in md and "Sorry" not in md


def test_wrong_length_triggers_revision_without_critic_issues():
    client, _, _ = run([PLAN, "# T\n\nshort"] + [NONE] * 3 + [REVISED] + [NONE] * 3)
    assert "The summary has 3 words, the target is 99" in client.calls[5][1]["content"]
    assert len(client.calls) == 9


def test_budgets_are_rescaled_to_target():
    plan = harness.parse_plan(PLAN, 99)
    assert [s["words"] for s in plan] == [25, 74] and sum(s["words"] for s in plan) == 99
    assert harness.parse_plan('```json\n{"sections":[{"heading":"a","points":[],"words":0}]}\n```', 50)[0]["words"] == 50


def test_dump_uses_placeholders():
    dump = harness.prompts_dump(phase(None), None, CH, "SYSTEM", length_percent=33, bibliographic_line="L")
    assert "=== PLAN" in dump and "=== STYLE CRITIC" in dump and "<<chapter 1 text: 300 words>>" in dump
    assert "alpha" not in dump and "<<outline from the plan" in dump
