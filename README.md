# Summarize

Upload the PDFs you have to study and get back faithful summaries, ready to open in Google Docs or any word processor.

Summarize splits each document into chapters, asks an LLM for a draft, then runs a second **fact-check pass** against the original text. Model-free checks follow: quotations must appear verbatim in the source, placeholders must be gone and the length must be on target. Results come as Markdown and `.docx`.

## Features

- Magic-link and Google login, with server-side sessions.
- Direct browser uploads to S3-compatible storage (Cloudflare R2, MinIO, RustFS…).
- Text extraction with PyMuPDF, with OCR through Tesseract for scanned pages.
- Chapter detection from the PDF outline or "Chapter N" headings. Long parts are capped at 15,000 words.
- Three styles: continuous study summary, structured notes and short abstract. Summaries can be in 1/3, 1/5 or 1/10 of the original length and in seven languages.
- Live progress over Server-Sent Events.
- Prepaid credits kept in an append-only ledger: reserved when a job starts, charged when it succeeds, refunded when it fails.
- Postgres-backed job queue (`FOR UPDATE SKIP LOCKED`), with no Redis. It retries, recovers stale jobs and fences superseded workers.
- Works with any OpenAI-compatible LLM endpoint.

## Architecture

```
apps/web        React + Vite + TanStack Query + Tailwind
apps/api        NestJS: auth, documents, jobs, credits, SSE; serves the web build in production
apps/worker     Python: PDF extraction, OCR, summarization pipeline, docx export
packages/db     Prisma schema and migrations (single source of truth)
e2e/            Playwright end-to-end test (fake LLM)
legacy/         The original command-line script the platform grew from
```

The API and the worker only share the database and the bucket. The API enqueues rows in `Job`; the worker claims them, writes progress back and uploads the results.

## Development

Requirements: Node 22, Python 3.12, Docker.

```bash
corepack enable                 # provides pnpm (may need an admin shell on Windows)
python -m venv .venv && source .venv/bin/activate   # Windows Git Bash: .venv/Scripts/activate
pip install -e "apps/worker[dev]"
pnpm install
cp .env.example .env            # then fill in LLM_API_KEY (or NVIDIA_API_KEY)
pnpm infra:up                   # Postgres, RustFS (S3-compatible), Mailpit
pnpm --filter @summarize/db migrate
pnpm dev                        # api :3000, web :5173, worker
```

- Open http://localhost:5173 and log in. Login emails land in Mailpit at http://localhost:8025.
- Give yourself credits with `pnpm --filter @summarize/api grant you@example.com 50`.
- To try everything without an LLM key, start the worker with `LLM_BASE_URL=fake`.

### Tests

```bash
pnpm test                                         # api (Jest) + worker (pytest); needs `pnpm infra:up`
PYTHON=$(pwd)/.venv/bin/python pnpm e2e           # Playwright: login → upload → summary → download
```

## Deployment

See [docs/deploy.md](docs/deploy.md) for a step-by-step guide (Railway, Cloudflare R2, Resend, Anthropic). Both services ship with a Dockerfile.

## Design documents

The product spec and the implementation plan of the first release are in [docs/superpowers](docs/superpowers) (in Italian).

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
