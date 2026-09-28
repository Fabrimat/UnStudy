import zipfile
from io import BytesIO

from summarize_worker.docx import to_docx
from summarize_worker.llm import DEFAULT_REPLY, FakeClient, Usage, make_client
from summarize_worker.pipeline import summarize_chapters
from summarize_worker.text import Chapter


def test_each_chapter_gets_a_draft_and_a_fact_check():
    client, progress, usage = FakeClient(), [], Usage()
    chapters = [Chapter("A", 9, 29, "alpha " * 300), Chapter("B", 30, 30, "beta " * 300)]
    md, warnings = summarize_chapters(client, "m", chapters, "SYSTEM", fraction=3,
                                      bibliographic_line="**Lijphart** – *Patterns*",
                                      on_progress=lambda p, ph: progress.append((p, ph)), usage=usage)
    assert len(client.calls) == 4
    assert client.calls[0][0] == {"role": "system", "content": "SYSTEM"}
    assert "about 100 words (one third of the original)" in client.calls[0][1]["content"]
    assert "ORIGINAL TEXT:" in client.calls[1][1]["content"]
    assert "**Lijphart** – *Patterns*, pp. 9–29" in md and "**Lijphart** – *Patterns*, p. 30" in md
    assert md.count("# Fake Summary") == 2 and "\n\n---\n\n" in md
    assert (usage.input_tokens, usage.output_tokens) == (400, 200)
    percents = [p for p, _ in progress]
    assert percents == sorted(percents) and all(0 <= p < 100 for p in percents)
    assert any(ph == "Chapter 2/2: fact-check" for _, ph in progress)
    assert all(w.startswith("chapter ") for w in warnings)


def test_a_too_short_fact_check_keeps_the_draft():
    client = FakeClient(replies=[DEFAULT_REPLY, "Sorry, I cannot help."])
    md, _ = summarize_chapters(client, "m", [Chapter("A", None, None, "alpha " * 300)], "S",
                               fraction=3, bibliographic_line="**A** – *B*")
    assert "Fake Summary" in md and "Sorry" not in md
    assert "**A** – *B*\n" in md  # no page range known


def test_fake_client_is_selected_by_base_url():
    assert isinstance(make_client("fake", ""), FakeClient)


def test_docx_has_real_headings():
    data = to_docx("# Title\n## Part\ntext")
    assert data[:2] == b"PK"
    xml = zipfile.ZipFile(BytesIO(data)).read("word/document.xml")
    assert b"Heading1" in xml and b"Heading2" in xml
