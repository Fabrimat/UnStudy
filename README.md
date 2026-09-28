# Summarize

Web platform that turns uploaded PDFs into study summaries. Spec: `docs/superpowers/specs/2026-09-28-summarize-platform-design.md`.

## Dev setup

```bash
corepack enable
python -m venv .venv && source .venv/Scripts/activate   # macOS/Linux: .venv/bin/activate
pip install -e "apps/worker[dev]"
pnpm install
pnpm infra:up          # Postgres, RustFS (S3-compatible), Mailpit
pnpm --filter @summarize/db migrate
pnpm dev               # api :3000, web :5173, worker
```

Login emails land in Mailpit: http://localhost:8025. Give credits with `pnpm --filter @summarize/api grant you@example.com 50`.

The original CLI lives in `legacy/` (frozen reference).
