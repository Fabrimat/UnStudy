import tempfile
from pathlib import Path

from .checks import fix_format


def to_docx(markdown: str) -> bytes:
    """Word file for Google Docs import (pandoc bundled by pypandoc_binary)."""
    import pypandoc
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "summary.docx"
        pypandoc.convert_text(fix_format(markdown, None), "docx", format="markdown", outputfile=str(out),
                              extra_args=["--sandbox"])  # LLM output can contain image links; never let pandoc fetch them
        return out.read_bytes()
