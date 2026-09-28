"""PDF text extraction and chapter splitting (ported from legacy/riassumi_libro.py)."""
import re
from dataclasses import dataclass
from typing import Callable

import fitz  # PyMuPDF

CHAPTER_HEADING = re.compile(r"^\s*(cap(itolo)?\.?\s*\d+|chapter\s*\d+|parte\s+[ivxlcdm\d]+)\b", re.IGNORECASE)


@dataclass
class Chapter:
    title: str
    page_from: int | None  # 1-based, inclusive
    page_to: int | None
    text: str

    @property
    def words(self) -> int:
        return len(self.text.split())

    def as_json(self) -> dict:
        return {"title": self.title, "pageFrom": self.page_from, "pageTo": self.page_to, "words": self.words}


def inspect_pdf(pdf: bytes) -> tuple[int, bool]:
    """Page count and whether a password is needed. Raises ValueError if the PDF cannot be opened."""
    try:
        doc = fitz.open(stream=pdf, filetype="pdf")
    except Exception as e:
        raise ValueError(f"unreadable PDF: {e}") from e
    try:
        return doc.page_count, bool(doc.needs_pass)
    finally:
        doc.close()


def extract_pages(pdf: bytes, ocr_langs: str | None,
                  on_page: Callable[[int, int], None] | None = None) -> tuple[list[str], list[list], bool]:
    """Text per page (OCR fallback on near-empty pages), the PDF outline, and whether OCR was used."""
    doc = fitz.open(stream=pdf, filetype="pdf")
    try:
        pages, used_ocr = [], False
        for i, page in enumerate(doc, 1):
            text = page.get_text("text")
            if ocr_langs and len(text.strip()) < 40:  # probably a scanned page
                ocr = _ocr(page, ocr_langs)
                if len(ocr.strip()) > len(text.strip()):
                    text, used_ocr = ocr, True
            pages.append(text)
            if on_page:
                on_page(i, doc.page_count)
        return pages, doc.get_toc(), used_ocr
    finally:
        doc.close()


def _ocr(page, langs: str) -> str:
    try:
        import pytesseract
        from PIL import Image
        pix = page.get_pixmap(dpi=300)  # rendered by PyMuPDF: no poppler needed
        return pytesseract.image_to_string(Image.frombytes("RGB", (pix.width, pix.height), pix.samples), lang=langs)
    except Exception as e:  # tesseract missing or failing: keep the text layer
        print(f"OCR failed on page {page.number + 1}: {e}")
        return ""


def clean_pages(pages: list[str]) -> list[str]:
    """Drops lines repeated on many pages (running headers/footers) and isolated page numbers."""
    counts: dict[str, int] = {}
    for text in pages:
        for line in {l.strip() for l in text.splitlines() if l.strip()}:
            counts[line] = counts.get(line, 0) + 1
    threshold = max(3, int(len(pages) * 0.4))
    repeated = {l for l, c in counts.items() if c >= threshold and len(l) < 80}
    cleaned = []
    for text in pages:
        lines = [l for l in text.splitlines()
                 if l.strip() not in repeated and not re.fullmatch(r"[\d ivxlcdmIVXLCDM\-–—]{1,6}", l.strip())]
        cleaned.append("\n".join(lines))
    return cleaned


def split_chapters(pages: list[str], toc: list, max_words: int = 15000) -> list[Chapter]:
    """Outline first, then 'Chapter N' headings, else the whole text; long chapters are cut to max_words."""
    chapters = _by_outline(pages, toc) or _by_headings(pages) or _whole(pages)
    return _cap(chapters, max_words)


def _by_outline(pages: list[str], toc: list) -> list[Chapter]:
    starts, seen = [], set()
    for level, title, page in toc:
        if level == 1 and 1 <= page <= len(pages) and page not in seen:
            starts.append((title.strip() or f"Part {len(starts) + 1}", page))
            seen.add(page)
    starts.sort(key=lambda s: s[1])
    if len(starts) < 2:
        return []
    # ponytail: pages before the first entry (cover, contents) are dropped, like the legacy CLI.
    chapters = []
    for i, (title, first) in enumerate(starts):
        last = starts[i + 1][1] - 1 if i + 1 < len(starts) else len(pages)
        chapters.append(Chapter(title, first, last, "\n".join(pages[first - 1:last]).strip()))
    return [c for c in chapters if c.text]


def _by_headings(pages: list[str]) -> list[Chapter]:
    lines = [(p, line) for p, text in enumerate(pages, 1) for line in text.splitlines()]
    starts = [i for i, (_, line) in enumerate(lines) if CHAPTER_HEADING.match(line)]
    if len(starts) < 2:
        return []
    chapters = []
    for k, start in enumerate(starts):
        end = starts[k + 1] if k + 1 < len(starts) else len(lines)
        block = lines[start:end]
        text = "\n".join(line for _, line in block).strip()
        chapters.append(Chapter(block[0][1].strip()[:120], block[0][0], block[-1][0], text))
    return [c for c in chapters if c.text]


def _whole(pages: list[str]) -> list[Chapter]:
    text = "\n".join(pages).strip()
    return [Chapter("Document", 1, len(pages), text)] if text else []


def _cap(chapters: list[Chapter], max_words: int) -> list[Chapter]:
    out = []
    for c in chapters:
        words = c.text.split()
        if len(words) <= max_words:
            out.append(c)
            continue
        parts = -(-len(words) // max_words)
        size = -(-len(words) // parts)
        for k in range(parts):
            out.append(Chapter(f"{c.title} (part {k + 1}/{parts})", c.page_from, c.page_to,
                               " ".join(words[k * size:(k + 1) * size])))
    return out
