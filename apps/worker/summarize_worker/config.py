import json
import logging
import re
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


def parse_models(raw: str | None, fallback_model: str | None) -> tuple[tuple[str, str], ...]:
    """LLM_MODELS -> ((id, model), ...), first is the default. Absent/empty: one 'default' entry from LLM_MODEL."""
    if not raw or not raw.strip():
        if not fallback_model:
            raise ValueError("LLM_MODEL is required when LLM_MODELS is not set")
        return (("default", fallback_model),)
    try:
        items = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError("invalid LLM_MODELS: not valid JSON") from None
    if not isinstance(items, list) or not items:
        raise ValueError("invalid LLM_MODELS: expected a non-empty array")
    models, seen = [], set()
    for item in items:
        ok = (isinstance(item, dict) and isinstance(item.get("id"), str) and re.fullmatch(r"[a-z0-9-]{1,32}", item["id"])
              and isinstance(item.get("label"), str) and item["label"].strip()
              and isinstance(item.get("model"), str) and item["model"].strip()
              and isinstance(item.get("multiplier"), (int, float)) and not isinstance(item["multiplier"], bool)
              and 0 < item["multiplier"] <= 100)
        if not ok or item["id"] in seen:
            raise ValueError("invalid LLM_MODELS: bad entry or duplicate id")
        seen.add(item["id"])
        models.append((item["id"], item["model"]))
    return tuple(models)


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
    llm_model: str | None
    ocr_langs: str | None
    s3_force_path_style: bool = True  # False for virtual-hosted buckets (e.g. Railway, AWS)
    log_level: int = logging.INFO
    models: tuple[tuple[str, str], ...] = ()  # (id, provider model); empty only in tests built without a catalog

    @property
    def default_model(self) -> str:
        return self.llm_model or self.models[0][1]

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
            llm_model=e.get("LLM_MODEL") or None,
            ocr_langs=e.get("OCR_LANGS") or None,
            s3_force_path_style=e.get("S3_FORCE_PATH_STYLE", "true") == "true",
            log_level=parse_log_level(e.get("LOG_LEVEL", "info")),
            models=parse_models(e.get("LLM_MODELS"), e.get("LLM_MODEL")),
        )
