import fitz
import pytest

from summarize_worker.text import Chapter, clean_pages, drop_matter, extract_pages, inspect_pdf, ocr_dpi, split_chapters
from tests.pdfs import make_pdf


def test_extract_pages_outline_and_progress():
    pdf = make_pdf(["First page text", "Second page text"], toc=[[1, "Intro", 1], [1, "Body", 2]])
    seen = []
    pages, toc, used_ocr = extract_pages(pdf, ocr_langs=None, on_page=lambda i, n: seen.append((i, n)))
    assert [p.strip() for p in pages] == ["First page text", "Second page text"]
    assert toc == [[1, "Intro", 1], [1, "Body", 2]]
    assert used_ocr is False
    assert seen == [(1, 2), (2, 2)]


def test_inspect_pdf():
    assert inspect_pdf(make_pdf(["a", "b", "c"])) == (3, False)
    locked = make_pdf(["secret"], encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="user")
    assert inspect_pdf(locked)[1] is True
    with pytest.raises(ValueError):
        inspect_pdf(b"%PDF-1.4 garbage")


def test_split_by_outline_uses_top_level_entries():
    chapters = split_chapters(["p1", "p2", "p3", "p4"], [[1, "One", 1], [2, "Sub", 2], [1, "Two", 3]])
    assert [(c.title, c.page_from, c.page_to, c.text) for c in chapters] == [
        ("One", 1, 2, "p1\np2"),
        ("Two", 3, 4, "p3\np4"),
    ]


def test_outline_entries_on_the_same_page_are_merged():
    chapters = split_chapters(["p1", "p2"], [[1, "One", 1], [1, "One bis", 1], [1, "Two", 2]])
    assert [c.title for c in chapters] == ["One", "Two"]


def test_split_by_chapter_headings_without_outline():
    pages = ["Preface text", "Chapter 1 Origins\nalpha beta", "more alpha", "Chapter 2 Growth\ngamma"]
    chapters = split_chapters(pages, [])
    assert [(c.title, c.page_from, c.page_to) for c in chapters] == [
        ("Chapter 1 Origins", 2, 3),
        ("Chapter 2 Growth", 4, 4),
    ]


def test_unstructured_text_is_one_chapter():
    chapters = split_chapters(["just text", "more text"], [])
    assert [(c.title, c.page_from, c.page_to, c.words) for c in chapters] == [("Document", 1, 2, 4)]
    assert chapters[0].as_json() == {"title": "Document", "pageFrom": 1, "pageTo": 2, "words": 4}


def test_whole_book_without_structure_is_capped():
    chapters = split_chapters(["word " * 12500, "word " * 12500], [], max_words=15000)
    assert len(chapters) == 2 and all(c.words <= 15000 for c in chapters)
    assert sum(c.words for c in chapters) == 25000
    assert chapters[0].title == "Document (part 1/2)"


def test_empty_document_has_no_chapters():
    assert split_chapters(["", "  "], []) == []


def test_clean_pages_drops_repeated_headers_and_page_numbers():
    pages = [f"PATTERNS OF DEMOCRACY\nBody text {i}\n{i}" for i in range(1, 6)]
    assert clean_pages(pages) == [f"Body text {i}" for i in range(1, 6)]


def test_ocr_dpi_is_300_for_a_normal_page():
    assert ocr_dpi(595, 842) == 300  # A4


def test_ocr_dpi_scales_down_for_a_large_page_without_exceeding_the_pixel_cap():
    dpi = ocr_dpi(3000, 3000)
    assert 72 < dpi < 300
    assert (3000 / 72 * dpi) ** 2 <= 40_000_000


def test_ocr_dpi_never_goes_below_72_even_if_still_over_the_cap():
    assert ocr_dpi(14400, 14400) == 72


def test_ocr_is_skipped_for_a_page_too_large_to_render_safely():
    doc = fitz.open()
    doc.new_page(width=14400, height=14400)  # even at 72dpi this would be 200M+ pixels
    pdf = doc.tobytes()
    doc.close()
    pages, _, used_ocr = extract_pages(pdf, ocr_langs="eng")
    assert pages == [""] and used_ocr is False


def test_chapters_text_headers_and_separator():
    from summarize_worker.text import Chapter, chapters_text
    out = chapters_text([Chapter("One", 1, 3, "a b"), Chapter("Two", None, None, "c")])
    assert out == "=== One (pp. 1\u20133) ===\na b\n\n=== Two ===\nc"


def _chs(*spec):
    return [Chapter(t, None, None, " ".join(["word"] * n)) for t, n in spec]


def _titles(chapters):
    return [c.title for c in drop_matter(chapters)]


def test_split_chapters_does_not_drop_matter():
    pages = [" ".join(["word"] * 250), " ".join(["word"] * 150), " ".join(["word"] * 400)]
    toc = [[1, "Title", 1], [1, "Contents", 2], [1, "Chapter 2", 3]]
    assert [c.title for c in split_chapters(pages, toc)] == ["Title", "Contents", "Chapter 2"]


def test_drop_matter_front_and_back():
    assert _titles(_chs(("Patterns of Democracy", 250), ("Contents", 150), ("Chapter 2", 400), ("Chapter 3", 500))) ==         ["Chapter 2", "Chapter 3"]
    assert _titles(_chs(("Chapter 2", 400), ("Indice analitico", 900), ("Chapter 3", 400), ("Note", 50))) ==         ["Chapter 2", "Chapter 3"]


def test_drop_matter_keeps_short_abstract_conclusion_and_middle_chapters():
    assert _titles(_chs(("Abstract", 180), ("1. Introduction", 2000), ("2. Method", 2000), ("3. Conclusion", 240),
                        ("Acknowledgments", 100), ("References", 800))) ==         ["Abstract", "1. Introduction", "2. Method", "3. Conclusion"]
    assert _titles(_chs(("One", 2000), ("Interlude", 250), ("Two", 2000))) == ["One", "Interlude", "Two"]


def test_drop_matter_never_returns_empty():
    chs = _chs(("Contents", 100), ("Two", 50))
    assert drop_matter(chs) == chs


def test_drop_matter_matches_cap_renamed_parts():
    assert _titles(_chs(("Chapter 2", 400), ("Chapter 3", 400), ("Notes (part 1/2)", 900), ("Notes (part 2/2)", 900))) == \
        ["Chapter 2", "Chapter 3"]
