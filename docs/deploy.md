# Deploying Summarize

The reference setup is **Railway (EU region, with a Railway storage bucket) + Resend + Anthropic**. Cloudflare R2 or any other S3-compatible storage works as well. It suits a closed beta: anyone can log in, but only users you grant credits to can generate summaries.

| Piece | Service |
|---|---|
| API + web (NestJS serves the React build) | Railway service built from `apps/api/Dockerfile` |
| Worker (Python, Tesseract, pandoc) | Railway service built from `apps/worker/Dockerfile` |
| Database | Railway Postgres |
| Files | Railway bucket in `ams` (or Cloudflare R2 with EU jurisdiction) |
| Login emails | Resend (SMTP) |
| LLM | Any OpenAI-compatible endpoint; Anthropic recommended |

You need a domain of your own: Resend only sends from verified domains, and the app should live on it (for example `app.example.com`).

## 1. Storage

**Railway bucket (simplest).** In the project, *Create → Bucket*, region **Amsterdam (ams)**. Reference its credentials from both services (see the variables table). Railway buckets use virtual-hosted URLs, so set `S3_FORCE_PATH_STYLE=false`. Set `S3_CORS_ORIGIN` on the API to your web origin: the API applies the CORS rule to the bucket at startup.

**Cloudflare R2 (alternative).**

1. Create a bucket (for example `summarize`) and choose the **EU** jurisdiction.
2. Create an R2 API token with *Object Read & Write* on that bucket. Note the access key ID and the secret.
3. The S3 endpoint is `https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com`.
4. Set `S3_CORS_ORIGIN` on the API so it applies the CORS rule at startup, or add a CORS policy to the bucket by hand. Browsers upload directly to R2 with presigned URLs:

```json
[
  {
    "AllowedOrigins": ["https://app.example.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type", "content-length"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

5. Optional: add a lifecycle rule that deletes objects under `users/` older than 30 days, if you don't want to keep uploaded PDFs.

## 2. Resend

1. Add your domain and create the DNS records Resend shows you (SPF and DKIM).
2. Create an API key with sending access.
3. Set `RESEND_API_KEY` on the API: email then goes through Resend's HTTPS API. Railway's Free, Trial and Hobby plans block outbound SMTP, so plain `SMTP_URL` only works on Pro (or on other hosts).
4. You can use the domain that already receives your mail (for example on Fastmail): Resend only adds a `resend._domainkey` DKIM record and MX/SPF records on the `send.` subdomain, so your inbox is untouched.

## 3. LLM

Create an Anthropic API key. The worker talks to Anthropic's OpenAI-compatible endpoint:

```
LLM_BASE_URL=https://api.anthropic.com/v1/
LLM_API_KEY=<ANTHROPIC_API_KEY>
LLM_MODEL=claude-sonnet-5
```

Any other OpenAI-compatible provider works too. Check that its terms allow use in a public service.

## 4. Railway

1. Push the repository to GitHub.
2. Create a Railway project, add a **Postgres** database and the bucket from step 1.
3. Add two empty services, `api` and `worker`, and connect both to the GitHub repo (branch `main`). Leave the root directory as the repository root: the Dockerfiles build from it.
4. In each service's *Settings*:
   - **api**: Dockerfile path `apps/api/Dockerfile`; pre-deploy command `sh -c "cd /app && pnpm --filter @summarize/db exec prisma migrate deploy"`; healthcheck path `/api/health`; restart policy *On failure*.
   - **worker**: Dockerfile path `apps/worker/Dockerfile`; restart policy *On failure*.
   - **Region**: move `api`, `worker` and `Postgres` to **EU West (Amsterdam)** (new services start in the US).
5. Under the API service, *Networking*, generate a Railway domain or add your own (for example `app.example.com`), with target port `3000`.
6. Set these variables (`files` is the bucket's name in these references):

| Variable | API | Worker | Value |
|---|---|---|---|
| `PORT` | ✓ | | `3000` |
| `DATABASE_URL` | ✓ | ✓ | `${{Postgres.DATABASE_URL}}` |
| `S3_ENDPOINT` | ✓ | ✓ | `${{files.ENDPOINT}}` (R2: `https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com`) |
| `S3_REGION` | ✓ | ✓ | `${{files.REGION}}` (R2: `auto`) |
| `S3_BUCKET` | ✓ | ✓ | `${{files.BUCKET}}` |
| `S3_ACCESS_KEY_ID` | ✓ | ✓ | `${{files.ACCESS_KEY_ID}}` |
| `S3_SECRET_ACCESS_KEY` | ✓ | ✓ | `${{files.SECRET_ACCESS_KEY}}` |
| `S3_FORCE_PATH_STYLE` | ✓ | ✓ | `false` for Railway buckets, `true` for R2 |
| `S3_CORS_ORIGIN` | ✓ | | same as `WEB_ORIGIN` |
| `WEB_ORIGIN` | ✓ | | `https://app.example.com` |
| `RESEND_API_KEY` | ✓ | | see Resend (or `SMTP_URL` on plans that allow SMTP) |
| `MAIL_FROM` | ✓ | | `Summarize <login@example.com>` |
| `GOOGLE_CLIENT_ID` | ✓ | | leave empty to disable Google login |
| `LLM_BASE_URL` | | ✓ | see LLM |
| `LLM_API_KEY` | | ✓ | see LLM |
| `LLM_MODEL` | | ✓ | see LLM |

`NODE_ENV=production` is already set in the API image; it turns on `Secure` cookies. Database migrations run automatically before each API deploy (the pre-deploy command).

### Google login (optional)

Create an OAuth client ("Web application") in Google Cloud, with authorised redirect URI `https://app.example.com/api/auth/google/callback`. Then set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_CALLBACK_URL` to that URI on the API service. Test the whole flow by hand before inviting users.

## 5. First run

1. Open `https://app.example.com`, log in with your email and click the link you receive.
2. Give yourself credits from the API service shell (*Railway → API service → ⋯ → Shell*):

```bash
cd /app && pnpm --filter @summarize/api grant you@example.com 50
```

3. Upload a chapter and start a summary. When it finishes, the job's `inputTokens` and `outputTokens` columns show what one document really costs. Use them to price credits.

## Before inviting people

- Add terms of use in which users confirm they have the right to use the files they upload, and a privacy notice listing the sub-processors (Railway, Cloudflare, Resend, your LLM provider).
- Credits are only granted by hand in this release (`grant` CLI); online payments are planned for a later release.
