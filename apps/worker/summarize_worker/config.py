import logging
import os
from dataclasses import dataclass
from pathlib import Path

ROOT_ENV = Path(__file__).resolve().parents[3] / ".env"  # repo root in development; absent in production

LOG_LEVELS = {"debug": logging.DEBUG, "info": logging.INFO, "warn": logging.WARNING,
             "warning": logging.WARNING, "error": logging.ERROR}


def load_env(path: Path) -> None:
    # ponytail: same minimal KEY=value parser as the legacy CLI; never overrides variables already set
    for line in path.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.partition("=")
        if sep and not key.strip().startswith("#"):
            os.environ.setdefault(key.strip(), value.strip().strip('"\''))


def parse_log_level(raw: str) -> int:
    try:
        return LOG_LEVELS[raw.strip().lower()]
    except KeyError:
        raise ValueError(f"invalid LOG_LEVEL {raw!r}, expected one of {sorted(LOG_LEVELS)}") from None


@dataclass(frozen=True)
class Settings:
    database_url: str
    s3_endpoint: str | None
    s3_region: str
    s3_bucket: str
    s3_key: str
    s3_secret: str
    llm_base_url: str
    llm_api_key: str
    llm_model: str
    ocr_langs: str | None
    s3_force_path_style: bool = True  # False for virtual-hosted buckets (e.g. Railway, AWS)
    log_level: int = logging.INFO

    @classmethod
    def from_env(cls) -> "Settings":
        if ROOT_ENV.exists():
            load_env(ROOT_ENV)
        e = os.environ
        return cls(
            database_url=e["DATABASE_URL"],
            s3_endpoint=e.get("S3_ENDPOINT") or None,
            s3_region=e.get("S3_REGION", "us-east-1"),
            s3_bucket=e["S3_BUCKET"],
            s3_key=e["S3_ACCESS_KEY_ID"],
            s3_secret=e["S3_SECRET_ACCESS_KEY"],
            llm_base_url=e["LLM_BASE_URL"],
            llm_api_key=e.get("LLM_API_KEY") or e.get("NVIDIA_API_KEY", ""),
            llm_model=e["LLM_MODEL"],
            ocr_langs=e.get("OCR_LANGS") or None,
            s3_force_path_style=e.get("S3_FORCE_PATH_STYLE", "true") == "true",
            log_level=parse_log_level(e.get("LOG_LEVEL", "info")),
        )
