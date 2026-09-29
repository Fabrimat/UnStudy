"""python -m summarize_worker.probe [model-id ...] — one tiny streamed call per catalog model, with the worker's real
parameters (provider, token param, temperature). Needs only LLM_PROVIDERS/LLM_MODELS and the keys, not the database."""
import os
import sys
import time

from .config import ROOT_ENV, load_env, parse_models, parse_providers
from .llm import call_model, make_client


def main() -> None:
    if ROOT_ENV.exists():
        load_env(ROOT_ENV)
    providers = {p.id: p for p in parse_providers(os.environ.get("LLM_PROVIDERS"), os.environ)}
    models = parse_models(os.environ.get("LLM_MODELS"), os.environ.get("LLM_MODEL"), tuple(providers.values()))
    wanted = set(sys.argv[1:])
    clients, failed = {}, 0
    for m in models:
        if wanted and m.id not in wanted:
            continue
        p = providers[m.provider]
        client = clients.setdefault(p.id, make_client(p))
        start = time.time()
        try:
            reply = call_model(client, m.model, "Reply with the single word: ok", max_tokens=2000, attempts=1,
                               temperature=m.temperature, token_param=p.token_param)
            status = f"OK   {time.time() - start:5.1f}s  {reply[:40]!r}"
        except Exception as e:  # ponytail: the provider's message, never the key (the SDK does not echo it)
            failed += 1
            status = f"FAIL {time.time() - start:5.1f}s  {type(e).__name__}: {str(e)[:160]}"
        print(f"{m.id:<22} {p.id:<8} {m.model:<42} {status}", flush=True)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
