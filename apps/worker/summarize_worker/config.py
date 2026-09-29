import json
import logging
import re
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
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


ID_RE = r"[a-z0-9-]{1,32}"
TOKEN_PARAMS = ("max_tokens", "max_completion_tokens")


@dataclass(frozen=True)
class Provider:
    id: str
    kind: str
    base_url: str
    api_key: str = field(default="", repr=False)  # never in logs or reprs
    token_param: str = "max_tokens"
    max_concurrency: int | None = None


@dataclass(frozen=True)
class ModelEntry:
    id: str
    model: str
    provider: str
    temperature: float | None = 0.4  # None: do not send the parameter
    admin_only: bool = False


def parse_providers(raw: str | None, env: Mapping[str, str]) -> tuple[Provider, ...]:
    """LLM_PROVIDERS -> providers, first is the default. Absent/empty: one 'default' from LLM_BASE_URL + key."""
    if not raw or not raw.strip():
        if not env.get("LLM_BASE_URL"):
            raise ValueError("LLM_BASE_URL is required when LLM_PROVIDERS is not set")
        return (Provider("default", "openai", env["LLM_BASE_URL"], env.get("LLM_API_KEY") or env.get("NVIDIA_API_KEY", "")),)
    try:
        items = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError("invalid LLM_PROVIDERS: not valid JSON") from None
    if not isinstance(items, list) or not items:
        raise ValueError("invalid LLM_PROVIDERS: expected a non-empty array")
    providers, seen = [], set()
    for item in items:
        ok = (isinstance(item, dict) and isinstance(item.get("id"), str) and re.fullmatch(ID_RE, item["id"])
              and item.get("kind", "openai") == "openai"
              and isinstance(item.get("baseUrl"), str) and item["baseUrl"].strip()
              and (item.get("apiKeyEnv") is None or (isinstance(item["apiKeyEnv"], str) and item["apiKeyEnv"].strip()))
              and item.get("tokenParam", "max_tokens") in TOKEN_PARAMS
              and (item.get("maxConcurrency") is None
                   or (isinstance(item["maxConcurrency"], int) and not isinstance(item["maxConcurrency"], bool)
                       and 1 <= item["maxConcurrency"] <= 64)))
        if not ok or item["id"] in seen:
            raise ValueError("invalid LLM_PROVIDERS: bad entry or duplicate id")
        seen.add(item["id"])
        key = ""
        if item.get("apiKeyEnv"):
            key = env.get(item["apiKeyEnv"], "")
            if not key:
                raise ValueError(f"LLM_PROVIDERS: environment variable {item['apiKeyEnv']} is not set")
        providers.append(Provider(item["id"], "openai", item["baseUrl"], key, item.get("tokenParam", "max_tokens"),
                                  item.get("maxConcurrency")))
    return tuple(providers)


def _number(v, lo: float, hi: float | None = None) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v >= lo and (hi is None or v <= hi)


def parse_models(raw: str | None, fallback_model: str | None, providers: tuple[Provider, ...]) -> tuple[ModelEntry, ...]:
    """LLM_MODELS -> ModelEntry tuple. Absent/empty: one 'default' entry from LLM_MODEL on the first provider."""
    if not raw or not raw.strip():
        if not fallback_model:
            raise ValueError("LLM_MODEL is required when LLM_MODELS is not set")
        return (ModelEntry("default", fallback_model, providers[0].id),)
    try:
        items = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError("invalid LLM_MODELS: not valid JSON") from None
    if not isinstance(items, list) or not items:
        raise ValueError("invalid LLM_MODELS: expected a non-empty array")
    provider_ids = {p.id for p in providers}
    models, seen = [], set()
    for item in items:
        ok = (isinstance(item, dict) and isinstance(item.get("id"), str) and re.fullmatch(ID_RE, item["id"])
              and isinstance(item.get("label"), str) and item["label"].strip()
              and isinstance(item.get("model"), str) and item["model"].strip()
              and _number(item.get("multiplier"), 0) and 0 < item["multiplier"] <= 100
              and (item.get("temperature", 0.4) is None or _number(item.get("temperature", 0.4), 0, 2))
              and all(item.get(k) is None or _number(item[k], 0) for k in ("priceIn", "priceOut"))
              and isinstance(item.get("adminOnly", False), bool))
        if not ok or item["id"] in seen:
            raise ValueError("invalid LLM_MODELS: bad entry or duplicate id")
        provider = item.get("provider", providers[0].id)
        if provider not in provider_ids:
            raise ValueError(f"invalid LLM_MODELS: unknown provider {provider!r}")
        seen.add(item["id"])
        models.append(ModelEntry(item["id"], item["model"], provider, item.get("temperature", 0.4),
                                 item.get("adminOnly", False)))
    if all(m.admin_only for m in models):
        raise ValueError("invalid LLM_MODELS: at least one model must not be adminOnly")
    return tuple(models)


def parse_concurrency(raw: str | None) -> int:
    """SUMMARIZE_CONCURRENCY -> 1..16, default 1."""
    if raw is None or not raw.strip():
        return 1
    try:
        n = int(raw)
    except ValueError:
        raise ValueError(f"invalid SUMMARIZE_CONCURRENCY {raw!r}, expected an integer 1..16") from None
    if not 1 <= n <= 16:
        raise ValueError(f"invalid SUMMARIZE_CONCURRENCY {raw!r}, expected an integer 1..16")
    return n


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
    models: tuple[ModelEntry, ...] = ()  # empty only in tests built without a catalog
    providers: tuple[Provider, ...] = ()  # empty only in tests built without providers
    summarize_concurrency: int = 1

    @property
    def default_model(self) -> str:
        return self.llm_model or self.default_entry.model

    @property
    def default_entry(self) -> ModelEntry:
        return next(m for m in self.models if not m.admin_only)  # user-job default: first non-adminOnly

    def provider(self, provider_id: str) -> Provider:
        return next(p for p in self.providers if p.id == provider_id)

    @classmethod
    def from_env(cls) -> "Settings":
        if ROOT_ENV.exists():
            load_env(ROOT_ENV)
        e = os.environ
        providers = parse_providers(e.get("LLM_PROVIDERS"), e)
        return cls(
            database_url=e["DATABASE_URL"],
            s3_endpoint=e.get("S3_ENDPOINT") or None,
            s3_region=e.get("S3_REGION", "us-east-1"),
            s3_bucket=e["S3_BUCKET"],
            s3_key=e["S3_ACCESS_KEY_ID"],
            s3_secret=e["S3_SECRET_ACCESS_KEY"],
            llm_base_url=providers[0].base_url,
            llm_api_key=providers[0].api_key,
            llm_model=e.get("LLM_MODEL") or None,
            ocr_langs=e.get("OCR_LANGS") or None,
            s3_force_path_style=e.get("S3_FORCE_PATH_STYLE", "true") == "true",
            log_level=parse_log_level(e.get("LOG_LEVEL", "info")),
            models=parse_models(e.get("LLM_MODELS"), e.get("LLM_MODEL"), providers),
            providers=providers,
            summarize_concurrency=parse_concurrency(e.get("SUMMARIZE_CONCURRENCY")),
        )
