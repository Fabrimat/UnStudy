# Deploying Summarize

The reference setup is **Railway (EU region) + Cloudflare R2 (EU jurisdiction) + Resend + Anthropic**. It suits a closed beta: anyone can log in, but only users you grant credits to can generate summaries.

| Piece | Service |
|---|---|
| API + web (NestJS serves the React build) | Railway service built from `apps/api/Dockerfile` |
| Worker (Python, Tesseract, pandoc) | Railway service built from `apps/worker/Dockerfile` |
| Database | Railway Postgres |
| Files | Cloudflare R2 bucket |
| Login emails | Resend (SMTP) |
| LLM | Any OpenAI-compatible endpoint; Anthropic recommended |

You need a domain of your own: Resend only sends from verified domains, and the app should live on it (for example `app.example.com`).

## 1. Cloudflare R2

1. Create a bucket (for example `summarize`) and choose the **EU** jurisdiction.
2. Create an R2 API token with *Object Read & Write* on that bucket. Note the access key ID and the secret.
3. The S3 endpoint is `https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com`.
4. Add a CORS policy to the bucket. Browsers upload directly to R2 with presigned URLs:

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
3. SMTP settings: `SMTP_URL=smtps://resend:<RESEND_API_KEY>@smtp.resend.com:465`.

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
2. Create a Railway project in the **EU West** region and add a **Postgres** database.
3. Add a service from the repo for the **API**. In *Settings → Config-as-code* set the path to `apps/api/railway.json`. Leave the root directory as the repository root: the Dockerfile builds from it.
4. Add a second service from the same repo for the **worker**, with config path `apps/worker/railway.json`.
5. Under the API service, *Networking → Custom domain*, add `app.example.com` and create the CNAME record Railway shows.
6. Set these variables. Use shared variables for the values both services need.

| Variable | API | Worker | Value |
|---|---|---|---|
| `DATABASE_URL` | ✓ | ✓ | `${{Postgres.DATABASE_URL}}` |
| `S3_ENDPOINT` | ✓ | ✓ | `https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com` |
| `S3_REGION` | ✓ | ✓ | `auto` |
| `S3_BUCKET` | ✓ | ✓ | `summarize` |
| `S3_ACCESS_KEY_ID` | ✓ | ✓ | R2 access key ID |
| `S3_SECRET_ACCESS_KEY` | ✓ | ✓ | R2 secret |
| `S3_FORCE_PATH_STYLE` | ✓ | | `true` |
| `WEB_ORIGIN` | ✓ | | `https://app.example.com` |
| `SMTP_URL` | ✓ | | see Resend |
| `MAIL_FROM` | ✓ | | `Summarize <login@example.com>` |
| `GOOGLE_CLIENT_ID` | ✓ | | leave empty to disable Google login |
| `LLM_BASE_URL` | | ✓ | see LLM |
| `LLM_API_KEY` | | ✓ | see LLM |
| `LLM_MODEL` | | ✓ | see LLM |

`NODE_ENV=production` is already set in the API image; it turns on `Secure` cookies. Database migrations run automatically before each API deploy (`preDeployCommand` in `apps/api/railway.json`).

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
