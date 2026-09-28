"""Writes e2e/fixtures/sample.pdf: two short chapters of real text."""
from pathlib import Path

import fitz

doc = fitz.open()
for i in (1, 2):
    page = doc.new_page()
    page.insert_textbox(fitz.Rect(72, 72, 523, 770),
                        f"Chapter {i} Democracy\n\n" + "Consensus democracy shares power among many actors. " * 40,
                        fontsize=10)
out = Path(__file__).with_name("fixtures") / "sample.pdf"
out.parent.mkdir(exist_ok=True)
doc.save(out)
print(f"wrote {out}")
