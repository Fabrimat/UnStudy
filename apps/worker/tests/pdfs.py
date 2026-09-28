import fitz


def make_pdf(pages: list[str], toc=None, **save_options) -> bytes:
    """Small real PDF with one text block per page; save_options go to Document.tobytes (e.g. encryption)."""
    doc = fitz.open()
    for text in pages:
        page = doc.new_page()
        page.insert_textbox(fitz.Rect(72, 72, 523, 770), text, fontsize=10)
    if toc:
        doc.set_toc(toc)
    data = doc.tobytes(**save_options)
    doc.close()
    return data
