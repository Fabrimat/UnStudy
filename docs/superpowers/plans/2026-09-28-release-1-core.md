# Rilascio 1 (nucleo) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Piattaforma web funzionante senza pagamenti: un utente fa login (magic link o Google), carica dei PDF, vede la divisione in capitoli e il preventivo in crediti, avvia il riassunto, ne segue l'avanzamento in tempo reale e scarica `.md` e `.docx`. I crediti si assegnano a mano con un comando CLI.

**Architecture:** Monorepo pnpm e Turborepo. `apps/api` (NestJS) gestisce auth, upload tramite URL S3 firmati, ledger dei crediti, job e SSE. `apps/worker` (Python) è la pipeline di `riassumi_libro.py` spezzata in moduli: consuma la tabella `Job` di Postgres con `FOR UPDATE SKIP LOCKED`. `apps/web` (React + Vite) è il frontend e passa da `/api` tramite il proxy di Vite in sviluppo; in produzione lo serve la stessa API. Lo schema DB è in `packages/db` (Prisma), unica fonte di verità.

**Tech Stack:** Node 22, pnpm (via corepack), Turborepo 2, TypeScript 5 strict, NestJS 11, Prisma 6 (non 7), Jest + supertest, React 19, react-router 7, TanStack Query 5, Tailwind 4, Vite; Python 3.12, PyMuPDF, pytesseract, pypandoc_binary, psycopg 3, boto3, openai, pytest; Postgres 16, MinIO (S3 in sviluppo), Mailpit (SMTP in sviluppo), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-28-summarize-platform-design.md` (sezione 12, rilascio 1). Leggila prima di iniziare.

## Global Constraints

- Mai stampare, loggare o committare `.env` né chiavi API; i segreti arrivano solo da variabili d'ambiente.
- `legacy/` è riferimento congelato: l'unica modifica ammessa è il percorso del `.env` (Task 1).
- Nomi di tabelle e colonne = default di Prisma (`"Job"`, `"heartbeatAt"`); nell'SQL raw del worker vanno sempre tra virgolette doppie.
- Tutti gli id sono `uuid` con default `gen_random_uuid()` generato dal DB.
- Tutte le route API stanno sotto `/api`; ogni richiesta non GET/HEAD/OPTIONS deve avere `Origin` uguale a `WEB_ORIGIN`, altrimenti 403.
- Limiti: PDF ≤ 50 MB (52428800 byte), ≤ 400 pagine, ≤ 3 job `summarize` attivi per utente, ≤ 5 magic link/ora per email, ≤ 30 upload/ora per utente.
- Scadenze: magic link 15 min, sessione 30 giorni, URL di upload 15 min, URL di download 5 min.
- `credits = max(1, ceil(words / 1000))`, fissato alla creazione del job.
- Ledger: `reserve` = −credits (alla creazione), `charge` = 0 (a job `done`), `refund` = +credits (a job `failed`), `grant`/`revoke` = ±n. Saldo = somma di `amount`. Al massimo una riga per `(jobId, type)`.
- Opzioni del job: `language` ∈ `auto|en|it|nl|fr|de|es`; `fraction` ∈ `3|5|10`; `preset` ∈ `studio|schematico|abstract`; `bibliographicLine` opzionale, al massimo 300 caratteri, su una riga.
- Chiavi S3: `users/{userId}/documents/{documentId}.pdf`, `users/{userId}/results/{jobId}.md`, `users/{userId}/results/{jobId}.docx`.
- `Job.status` ∈ `queued|running|done|failed`; `Job.kind` ∈ `analyze|summarize`; `Document.status` ∈ `uploaded|analyzed|rejected`.
- Testi della UI in inglese (l'i18n arriva nel rilascio 3).
- Il worker ritenta un job al massimo 2 volte (`attempts`); un heartbeat più vecchio di 10 minuti indica un job orfano.

## Review Focus

1. **PDF solo immagini con OCR assente o che non trova testo**: il documento è rifiutato con "No text found in the PDF, even with OCR" e i crediti non vengono toccati. Test nel Task 11.
2. **PDF protetto da password**: rifiutato con "Password-protected PDF" e non con un errore generico o un retry. Test nel Task 11.
3. **Nome file non ASCII o con virgolette** (es. `Lijphart – CH 2 & 3 è.pdf`): il download funziona e il file salvato ha il nome giusto. Test nel Task 7.
4. **Libro intero senza outline né titoli "Chapter N"**: diviso in parti da ≤ 15.000 parole, non mandato come un unico prompt enorme. Test nel Task 9.
5. **Worker ucciso a metà riassunto**: il job torna in coda, oppure dopo 2 tentativi fallisce con rimborso; mai crediti persi o addebitati due volte. Test nel Task 11.

## Ordine e parallelismo

Task 1 → 2, poi due binari indipendenti: **API** 3 → 4 → 5 → 6 → 7 → 8 e **worker** 9 → 10 → 11. Poi Task 12 (web, richiede 3–8) e Task 13 (e2e, richiede tutto).

## Prerequisiti di sviluppo (una volta)

```bash
corepack enable
python -m venv .venv            # alla radice del repo
source .venv/Scripts/activate   # Git Bash su Windows; su macOS/Linux: source .venv/bin/activate
```

Tutti i comandi `pnpm` che toccano il worker vanno lanciati con la venv attiva.

---

### Task 1: Scheletro del monorepo, legacy e infrastruttura di sviluppo

**Files:**
- Move: `riassumi_libro.py`, `istruzioni_esame.md`, `test_controlli.py` → `legacy/`
- Modify: `legacy/riassumi_libro.py` (solo la lettura del `.env`), `.gitignore`
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `docker-compose.yml`, `docker/postgres-init.sql`, `.env.example`, `README.md`

**Interfaces:**
- Produces: script root `pnpm infra:up`/`infra:down`; database `summarize`, `summarize_test_api`, `summarize_test_worker`, `summarize_test_e2e`; bucket `summarize` e `summarize-test`; SMTP Mailpit su `localhost:1025` (UI e API su `:8025`); S3 MinIO su `localhost:9000` (utente `summarize`, password `summarize-secret`).

- [ ] **Step 1: Sposta i file legacy**

```bash
mkdir -p legacy
git mv riassumi_libro.py istruzioni_esame.md test_controlli.py legacy/
```

- [ ] **Step 2: Fai leggere al legacy anche il `.env` della radice**

In `legacy/riassumi_libro.py` sostituisci il blocco

```python
    env_file = Path(__file__).with_name(".env")
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            key, sep, value = line.partition("=")
            if sep and not key.strip().startswith("#"):
                os.environ.setdefault(key.strip(), value.strip().strip('"\''))
```

con

```python
    for env_file in (Path(__file__).with_name(".env"), Path(__file__).resolve().parent.parent / ".env"):
        if env_file.exists():
            for line in env_file.read_text(encoding="utf-8").splitlines():
                key, sep, value = line.partition("=")
                if sep and not key.strip().startswith("#"):
                    os.environ.setdefault(key.strip(), value.strip().strip('"\''))
```

- [ ] **Step 3: Verifica che il legacy funzioni ancora**

Run: `python legacy/test_controlli.py`
Expected: quattro righe `ok`, `ok 2`, `ok 3`, `ok 4`.

- [ ] **Step 4: Crea i file del workspace**

`package.json`:

```json
{
  "name": "summarize",
  "private": true,
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "test": "turbo run test --concurrency=1",
    "e2e": "pnpm --filter @summarize/e2e e2e",
    "infra:up": "docker compose up -d --wait postgres minio mailpit && docker compose run --rm minio-init",
    "infra:down": "docker compose down"
  },
  "devDependencies": {
    "turbo": "^2.5.0",
    "typescript": "^5.9.0"
  },
  "pnpm": {
    "onlyBuiltDependencies": ["@prisma/client", "@prisma/engines", "prisma", "esbuild", "@nestjs/core"]
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
  - e2e
```

`turbo.json`:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["^build"], "cache": false },
    "dev": { "dependsOn": ["^build"], "cache": false, "persistent": true }
  }
}
```

Poi fissa la versione di pnpm, che scrive `packageManager` nel `package.json`:

```bash
corepack use pnpm@10
```

- [ ] **Step 5: Crea l'infrastruttura Docker**

`docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: summarize
      POSTGRES_PASSWORD: summarize
      POSTGRES_DB: summarize
    ports: ["5432:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./docker/postgres-init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U summarize"]
      interval: 2s
      retries: 30
  minio:
    image: minio/minio:latest
    command: server /data --console-address :9001
    environment:
      MINIO_ROOT_USER: summarize
      MINIO_ROOT_PASSWORD: summarize-secret
    ports: ["9000:9000", "9001:9001"]
    volumes: [miniodata:/data]
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 2s
      retries: 30
  minio-init:
    image: minio/mc:latest
    depends_on:
      minio: { condition: service_healthy }
    entrypoint: >
      sh -c "mc alias set local http://minio:9000 summarize summarize-secret &&
             mc mb --ignore-existing local/summarize local/summarize-test"
  mailpit:
    image: axllent/mailpit:latest
    ports: ["1025:1025", "8025:8025"]
volumes:
  pgdata:
  miniodata:
```

`docker/postgres-init.sql`:

```sql
CREATE DATABASE summarize_test_api;
CREATE DATABASE summarize_test_worker;
CREATE DATABASE summarize_test_e2e;
```

- [ ] **Step 6: Variabili d'ambiente**

`.env.example`:

```
# Legacy CLI (legacy/riassumi_libro.py) and dev LLM key fallback
NVIDIA_API_KEY=

DATABASE_URL=postgresql://summarize:summarize@localhost:5432/summarize
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_BUCKET=summarize
S3_ACCESS_KEY_ID=summarize
S3_SECRET_ACCESS_KEY=summarize-secret
S3_FORCE_PATH_STYLE=true
SMTP_URL=smtp://localhost:1025
MAIL_FROM=Summarize <no-reply@summarize.local>
WEB_ORIGIN=http://localhost:5173
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:5173/api/auth/google/callback
LLM_BASE_URL=https://integrate.api.nvidia.com/v1
LLM_API_KEY=
LLM_MODEL=nvidia/nemotron-3-ultra-550b-a55b
OCR_LANGS=eng+ita
```

Aggiungi al `.env` esistente le chiavi che mancano, **senza stamparne il contenuto** (il comando stampa solo i nomi delle chiavi aggiunte):

```bash
node -e "const fs=require('fs');const cur=fs.existsSync('.env')?fs.readFileSync('.env','utf8'):'';const have=new Set(cur.split(/\r?\n/).map(l=>l.split('=')[0].trim()));const add=fs.readFileSync('.env.example','utf8').split(/\r?\n/).filter(l=>/^[A-Z_0-9]+=/.test(l)&&!have.has(l.split('=')[0]));fs.appendFileSync('.env','\n'+add.join('\n')+'\n');console.log('added:',add.map(l=>l.split('=')[0]).join(', '))"
```

- [ ] **Step 7: Aggiorna `.gitignore`**

Aggiungi in fondo:

```
node_modules/
dist/
.turbo/
.venv/
*.tsbuildinfo
*.egg-info/
.pytest_cache/
playwright-report/
test-results/
e2e/fixtures/
e2e/.worker.pid
```

- [ ] **Step 8: README minimo**

`README.md`:

````markdown
# Summarize

Web platform that turns uploaded PDFs into study summaries. Spec: `docs/superpowers/specs/2026-09-28-summarize-platform-design.md`.

## Dev setup

```bash
corepack enable
python -m venv .venv && source .venv/Scripts/activate   # macOS/Linux: .venv/bin/activate
pip install -e "apps/worker[dev]"
pnpm install
pnpm infra:up          # Postgres, MinIO, Mailpit
pnpm --filter @summarize/db migrate
pnpm dev               # api :3000, web :5173, worker
```

Login emails land in Mailpit: http://localhost:8025. Give credits with `pnpm --filter @summarize/api grant you@example.com 50`.

The original CLI lives in `legacy/` (frozen reference).
````

- [ ] **Step 9: Avvia l'infrastruttura e verifica**

Run: `pnpm install && pnpm infra:up && docker compose exec postgres psql -U summarize -lqt | cut -d'|' -f1`
Expected: l'installazione riesce e l'elenco contiene `summarize`, `summarize_test_api`, `summarize_test_worker`, `summarize_test_e2e`. Se il volume `pgdata` esisteva già senza lo script di init, esegui `docker compose down -v` e ripeti.

- [ ] **Step 10: Commit**

```bash
git add -A legacy package.json pnpm-workspace.yaml turbo.json docker-compose.yml docker .env.example .gitignore README.md pnpm-lock.yaml
git status --short   # .env NON deve comparire
git commit -m "chore: monorepo skeleton, dev infra, move CLI to legacy/"
```

---

### Task 2: `packages/db` — schema Prisma e prima migrazione

**Files:**
- Create: `packages/db/package.json`, `packages/db/index.js`, `packages/db/index.d.ts`, `packages/db/prisma/schema.prisma`
- Create (generato): `packages/db/prisma/migrations/<timestamp>_init/migration.sql`

**Interfaces:**
- Produces: pacchetto `@summarize/db` che riesporta `@prisma/client` (`PrismaClient`, `Prisma`, i tipi `User`, `Document`, `Job`, `AuthProvider`…). Script: `build`/`generate` (prisma generate), `migrate` (migrate dev sul DB di sviluppo), `migrate:deploy`. Per resettare un DB di test: `pnpm --filter @summarize/db exec prisma migrate reset --force --skip-seed --skip-generate` con `DATABASE_URL` impostato.

- [ ] **Step 1: Pacchetto**

`packages/db/package.json`:

```json
{
  "name": "@summarize/db",
  "private": true,
  "main": "index.js",
  "types": "index.d.ts",
  "scripts": {
    "build": "prisma generate",
    "generate": "prisma generate",
    "migrate": "dotenv -e ../../.env -- prisma migrate dev",
    "migrate:deploy": "dotenv -e ../../.env -- prisma migrate deploy"
  },
  "dependencies": {
    "@prisma/client": "^6.16.0"
  },
  "devDependencies": {
    "dotenv-cli": "^8.0.0",
    "prisma": "^6.16.0"
  }
}
```

`packages/db/index.js`:

```js
module.exports = require('@prisma/client');
```

`packages/db/index.d.ts`:

```ts
export * from '@prisma/client';
```

- [ ] **Step 2: Schema**

`packages/db/prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum AuthProvider {
  email
  google
  apple
}

enum DocumentStatus {
  uploaded
  analyzed
  rejected
}

enum JobKind {
  analyze
  summarize
}

enum JobStatus {
  queued
  running
  done
  failed
}

enum LedgerType {
  purchase
  reserve
  charge
  refund
  grant
  revoke
}

model User {
  id        String         @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  email     String         @unique
  name      String?
  createdAt DateTime       @default(now())
  deletedAt DateTime?
  accounts  AuthAccount[]
  sessions  Session[]
  documents Document[]
  jobs      Job[]
  ledger    CreditLedger[]
}

model AuthAccount {
  id                String       @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId            String       @db.Uuid
  user              User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  provider          AuthProvider
  providerAccountId String

  @@unique([provider, providerAccountId])
}

model MagicLinkToken {
  tokenHash String    @id
  email     String
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime  @default(now())

  @@index([email, createdAt])
}

/// id = sha256 of the cookie value; the raw token is never stored.
model Session {
  id        String   @id
  userId    String   @db.Uuid
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  expiresAt DateTime
  createdAt DateTime @default(now())
}

model Document {
  id            String         @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId        String         @db.Uuid
  user          User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  s3Key         String
  filename      String
  sizeBytes     Int
  pages         Int?
  words         Int?
  usedOcr       Boolean        @default(false)
  /// [{ title, pageFrom, pageTo, words }]
  chapters      Json?
  status        DocumentStatus @default(uploaded)
  rejectReason  String?
  createdAt     DateTime       @default(now())
  fileDeletedAt DateTime?
  jobs          Job[]

  @@index([userId, createdAt])
}

model Job {
  id            String         @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId        String         @db.Uuid
  user          User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  documentId    String         @db.Uuid
  document      Document       @relation(fields: [documentId], references: [id], onDelete: Cascade)
  kind          JobKind
  /// { language, fraction, preset, bibliographicLine? }
  options       Json           @default("{}")
  status        JobStatus      @default(queued)
  attempts      Int            @default(0)
  progress      Int            @default(0)
  phase         String         @default("queued")
  heartbeatAt   DateTime?
  credits       Int            @default(0)
  inputTokens   Int            @default(0)
  outputTokens  Int            @default(0)
  /// output of the automatic checks; admin only, never sent to the browser
  warnings      Json           @default("[]")
  resultMdKey   String?
  resultDocxKey String?
  /// user-safe message only
  error         String?
  createdAt     DateTime       @default(now())
  finishedAt    DateTime?
  ledger        CreditLedger[]

  @@index([status, kind, createdAt])
  @@index([userId, createdAt])
}

/// Append-only. Balance = SUM(amount). One row per (jobId, type) keeps charge/refund idempotent.
model CreditLedger {
  id            String     @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId        String     @db.Uuid
  user          User       @relation(fields: [userId], references: [id])
  type          LedgerType
  amount        Int
  jobId         String?    @db.Uuid
  job           Job?       @relation(fields: [jobId], references: [id], onDelete: SetNull)
  stripeEventId String?
  createdAt     DateTime   @default(now())

  @@unique([jobId, type])
  @@index([userId])
}
```

- [ ] **Step 3: Genera il client e crea la migrazione**

Run: `pnpm install && pnpm --filter @summarize/db migrate --name init`
Expected: viene creato `packages/db/prisma/migrations/<timestamp>_init/migration.sql` con `CREATE TABLE "User"` … `CREATE UNIQUE INDEX "CreditLedger_jobId_type_key"`, e compare "Your database is now in sync with your schema".

- [ ] **Step 4: Verifica il reset di un DB di test**

Run: `DATABASE_URL=postgresql://summarize:summarize@localhost:5432/summarize_test_api pnpm --filter @summarize/db exec prisma migrate reset --force --skip-seed --skip-generate`
Expected: "Database reset successful" e la migrazione `init` applicata.

- [ ] **Step 5: Commit**

```bash
git add packages/db pnpm-lock.yaml
git commit -m "feat(db): prisma schema for users, sessions, documents, jobs, credit ledger"
```

---

### Task 3: `apps/api` — scheletro NestJS, config, Prisma, controllo Origin, harness di test

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/tsconfig.build.json`, `apps/api/nest-cli.json`
- Create: `apps/api/src/config.ts`, `src/prisma.service.ts`, `src/prisma.module.ts`, `src/origin.middleware.ts`, `src/setup.ts`, `src/health.controller.ts`, `src/app.module.ts`, `src/main.ts`
- Test: `apps/api/test/env.ts`, `test/global-setup.ts`, `test/helpers.ts`, `test/health.spec.ts`

**Interfaces:**
- Consumes: `@summarize/db` (`PrismaClient`).
- Produces:
  - `config` (oggetto: `webOrigin`, `s3.{endpoint,region,bucket,accessKeyId,secretAccessKey,forcePathStyle}`, `smtpUrl`, `mailFrom`, `google: {clientId,clientSecret,callbackUrl} | null`);
  - `PrismaService` (estende `PrismaClient`, modulo globale);
  - `setupApp(app)`;
  - helper di test `createApp(customize?)`, `resetDb(prisma)` e `ORIGIN`.

- [ ] **Step 1: Pacchetto e tsconfig**

`apps/api/package.json`:

```json
{
  "name": "@summarize/api",
  "private": true,
  "scripts": {
    "build": "nest build",
    "dev": "nest start --watch",
    "start": "node dist/main.js",
    "test": "jest",
    "grant": "ts-node --transpile-only src/cli/grant.ts"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.700.0",
    "@aws-sdk/s3-request-presigner": "^3.700.0",
    "@nestjs/common": "^11.1.0",
    "@nestjs/core": "^11.1.0",
    "@nestjs/passport": "^11.0.0",
    "@nestjs/platform-express": "^11.1.0",
    "@nestjs/serve-static": "^5.0.0",
    "@nestjs/throttler": "^6.4.0",
    "@summarize/db": "workspace:*",
    "class-transformer": "^0.5.1",
    "class-validator": "^0.14.1",
    "cookie-parser": "^1.4.7",
    "nodemailer": "^7.0.0",
    "passport": "^0.7.0",
    "passport-google-oauth20": "^2.0.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1"
  },
  "devDependencies": {
    "@nestjs/cli": "^11.0.0",
    "@nestjs/testing": "^11.1.0",
    "@types/cookie-parser": "^1.4.8",
    "@types/express": "^5.0.0",
    "@types/jest": "^29.5.14",
    "@types/node": "^22.10.0",
    "@types/nodemailer": "^6.4.17",
    "@types/passport-google-oauth20": "^2.0.16",
    "@types/supertest": "^6.0.2",
    "jest": "^29.7.0",
    "supertest": "^7.0.0",
    "ts-jest": "^29.2.5",
    "ts-node": "^10.9.2",
    "typescript": "^5.9.0"
  },
  "jest": {
    "preset": "ts-jest",
    "testEnvironment": "node",
    "testMatch": ["<rootDir>/test/**/*.spec.ts"],
    "setupFiles": ["<rootDir>/test/env.ts"],
    "globalSetup": "<rootDir>/test/global-setup.ts",
    "maxWorkers": 1,
    "testTimeout": 20000
  }
}
```

`apps/api/tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2022",
    "strict": true,
    "strictPropertyInitialization": false,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "outDir": "dist"
  },
  "include": ["src", "test"]
}
```

`apps/api/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "rootDir": "src" },
  "include": ["src"]
}
```

`apps/api/nest-cli.json`:

```json
{
  "sourceRoot": "src",
  "compilerOptions": { "tsConfigPath": "tsconfig.build.json", "deleteOutDir": true }
}
```

- [ ] **Step 2: Scrivi il test che fallisce**

`apps/api/test/env.ts` (gira prima di ogni file di test e rende i test indipendenti dal `.env`):

```ts
process.env.DATABASE_URL = 'postgresql://summarize:summarize@localhost:5432/summarize_test_api';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.S3_ENDPOINT = 'http://localhost:9000';
process.env.S3_REGION = 'us-east-1';
process.env.S3_BUCKET = 'summarize-test';
process.env.S3_ACCESS_KEY_ID = 'summarize';
process.env.S3_SECRET_ACCESS_KEY = 'summarize-secret';
process.env.S3_FORCE_PATH_STYLE = 'true';
process.env.SMTP_URL = 'smtp://localhost:1025';
process.env.MAIL_FROM = 'Summarize <no-reply@summarize.local>';
process.env.GOOGLE_CLIENT_ID ??= '';
```

`apps/api/test/global-setup.ts`:

```ts
import { execSync } from 'node:child_process';

export default function globalSetup() {
  execSync('pnpm --filter @summarize/db exec prisma migrate reset --force --skip-seed --skip-generate', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: 'postgresql://summarize:summarize@localhost:5432/summarize_test_api' },
  });
}
```

`apps/api/test/helpers.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { setupApp } from '../src/setup';

export const ORIGIN = 'http://localhost:5173';

export async function createApp(customize: (b: TestingModuleBuilder) => TestingModuleBuilder = (b) => b) {
  const moduleRef = await customize(Test.createTestingModule({ imports: [AppModule] })).compile();
  const app = moduleRef.createNestApplication();
  setupApp(app);
  await app.init();
  return app;
}

export async function resetDb(prisma: PrismaService) {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "CreditLedger", "Job", "Document", "Session", "AuthAccount", "MagicLinkToken", "User" CASCADE',
  );
}
```

`apps/api/test/health.spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp, ORIGIN } from './helpers';

describe('health and origin check', () => {
  let app: INestApplication;
  beforeAll(async () => (app = await createApp()));
  afterAll(() => app.close());

  it('reports ok with a working database', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects mutations without the web origin', async () => {
    await request(app.getHttpServer()).post('/api/health').expect(403);
    await request(app.getHttpServer()).post('/api/health').set('Origin', 'https://evil.example').expect(403);
  });

  it('lets mutations from the web origin reach routing', async () => {
    await request(app.getHttpServer()).post('/api/health').set('Origin', ORIGIN).expect(404);
  });
});
```

- [ ] **Step 3: Verifica che fallisca**

Run: `pnpm install && pnpm --filter @summarize/api test`
Expected: FAIL con "Cannot find module '../src/app.module'".

- [ ] **Step 4: Implementa**

`apps/api/src/config.ts`:

```ts
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// pnpm runs scripts with cwd = apps/api, so the repo-root .env is two levels up.
// loadEnvFile never overrides variables that are already set (tests, e2e, production).
const envFile = resolve(process.cwd(), '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

export const config = {
  webOrigin: need('WEB_ORIGIN'),
  s3: {
    endpoint: process.env.S3_ENDPOINT || undefined,
    region: need('S3_REGION'),
    bucket: need('S3_BUCKET'),
    accessKeyId: need('S3_ACCESS_KEY_ID'),
    secretAccessKey: need('S3_SECRET_ACCESS_KEY'),
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  },
  smtpUrl: need('SMTP_URL'),
  mailFrom: need('MAIL_FROM'),
  google: process.env.GOOGLE_CLIENT_ID
    ? {
        clientId: need('GOOGLE_CLIENT_ID'),
        clientSecret: need('GOOGLE_CLIENT_SECRET'),
        callbackUrl: need('GOOGLE_CALLBACK_URL'),
      }
    : null,
};
```

`apps/api/src/prisma.service.ts`:

```ts
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@summarize/db';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
```

`apps/api/src/prisma.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
```

`apps/api/src/origin.middleware.ts`:

```ts
import { NextFunction, Request, Response } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// CSRF defence together with SameSite=Lax cookies: state-changing requests must come from our web app.
export function originCheck(allowed: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method) || req.headers.origin === allowed) return next();
    res.status(403).json({ message: 'Bad origin' });
  };
}
```

`apps/api/src/setup.ts`:

```ts
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { originCheck } from './origin.middleware';

export function setupApp(app: INestApplication) {
  app.getHttpAdapter().getInstance().set('trust proxy', 1); // real client IP behind the PaaS proxy (throttling)
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.use(originCheck(config.webOrigin));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
}
```

`apps/api/src/health.controller.ts`:

```ts
import { Controller, Get } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Controller('health')
export class HealthController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  }
}
```

`apps/api/src/app.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma.module';

@Module({
  imports: [PrismaModule, ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }])],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
```

`apps/api/src/main.ts`:

```ts
import 'reflect-metadata';
import './config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupApp } from './setup';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  setupApp(app);
  await app.listen(Number(process.env.PORT ?? 3000));
}
bootstrap();
```

- [ ] **Step 5: Verifica che passi**

Run: `pnpm --filter @summarize/api test`
Expected: PASS, 3 test in `health.spec.ts`.

- [ ] **Step 6: Verifica che il dev server parta**

Run: `pnpm --filter @summarize/api build && curl -s localhost:3000/api/health`, con `pnpm --filter @summarize/api start` avviato in un secondo terminale.
Expected: `{"ok":true}`.

- [ ] **Step 7: Commit**

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat(api): nest skeleton with config, prisma, origin check and test harness"
```

---

### Task 4: Auth con magic link, sessioni e `/api/me`

**Files:**
- Create: `apps/api/src/auth/tokens.ts`, `src/auth/mail.service.ts`, `src/auth/auth.service.ts`, `src/auth/session.guard.ts`, `src/auth/auth.dto.ts`, `src/auth/auth.controller.ts`, `src/auth/auth.module.ts`, `src/me.controller.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/api/test/helpers.ts`
- Test: `apps/api/test/auth.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `config`.
- Produces:
  - `AuthService` con `requestMagicLink(email): Promise<void>`, `verifyMagicLink(token): Promise<string>` (restituisce il token di sessione), `loginWithProvider(provider: AuthProvider, providerAccountId: string, email: string, emailVerified: boolean): Promise<User>`, `createSession(userId): Promise<string>`, `userForSession(token?): Promise<User | null>`, `logout(token?)`;
  - `SessionGuard` (mette `req.user`) e decoratore `@CurrentUser()`;
  - `SESSION_COOKIE = 'sid'` e `cookieOptions`;
  - `MailService.send(to, subject, text)`;
  - `AuthModule`, che esporta `AuthService`, `SessionGuard` e `MailService`;
  - helper di test `loginAs(app, email): Promise<{ user: User; cookie: string }>`.
- Route: `POST /api/auth/magic-link {email}` → 204 · `POST /api/auth/magic-link/verify {token}` → 204 + cookie `sid` · `POST /api/auth/logout` → 204 · `GET /api/me` → `{id, email, name}`.

- [ ] **Step 1: Scrivi il test che fallisce**

Aggiungi a `apps/api/test/helpers.ts`:

```ts
import { AuthService } from '../src/auth/auth.service';

export async function loginAs(app: INestApplication, email: string) {
  const auth = app.get(AuthService);
  const user = await auth.loginWithProvider('email', email, email, true);
  return { user, cookie: `sid=${await auth.createSession(user.id)}` };
}
```

`apps/api/test/auth.spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AuthService } from '../src/auth/auth.service';
import { MailService } from '../src/auth/mail.service';
import { PrismaService } from '../src/prisma.service';
import { createApp, ORIGIN, resetDb } from './helpers';

describe('magic link auth', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sent: { to: string; text: string }[] = [];

  beforeAll(async () => {
    app = await createApp((b) =>
      b.overrideProvider(MailService).useValue({
        send: async (to: string, _subject: string, text: string) => void sent.push({ to, text }),
      }),
    );
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    sent.length = 0;
    await resetDb(prisma);
  });

  const http = () => request(app.getHttpServer());
  const requestLink = (email: string) => http().post('/api/auth/magic-link').set('Origin', ORIGIN).send({ email });
  const verify = (token: string) => http().post('/api/auth/magic-link/verify').set('Origin', ORIGIN).send({ token });
  const tokenFromMail = () => /token=([\w-]+)/.exec(sent.at(-1)!.text)![1];
  const sidCookie = (res: request.Response) =>
    (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('sid='))!.split(';')[0];

  it('logs in with a magic link and reads /me', async () => {
    await requestLink('Ada@Example.com').expect(204);
    expect(sent[0].to).toBe('ada@example.com');
    expect(sent[0].text).toContain('http://localhost:5173/auth/verify?token=');
    const res = await verify(tokenFromMail()).expect(204);
    expect(res.headers['set-cookie'][0]).toMatch(/HttpOnly/);
    const me = await http().get('/api/me').set('Cookie', sidCookie(res)).expect(200);
    expect(me.body).toMatchObject({ email: 'ada@example.com' });
  });

  it('accepts each link only once', async () => {
    await requestLink('a@b.co').expect(204);
    const token = tokenFromMail();
    await verify(token).expect(204);
    await verify(token).expect(401);
  });

  it('rejects an expired link', async () => {
    await requestLink('a@b.co').expect(204);
    await prisma.magicLinkToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await verify(tokenFromMail()).expect(401);
  });

  it('sends at most 5 links per hour per email', async () => {
    for (let i = 0; i < 5; i++) await requestLink('a@b.co').expect(204);
    await requestLink('a@b.co').expect(429);
  });

  it('requires a session for /me and logout ends it', async () => {
    await http().get('/api/me').expect(401);
    await requestLink('a@b.co').expect(204);
    const cookie = sidCookie(await verify(tokenFromMail()).expect(204));
    await http().post('/api/auth/logout').set('Origin', ORIGIN).set('Cookie', cookie).expect(204);
    await http().get('/api/me').set('Cookie', cookie).expect(401);
  });

  it('rejects invalid input', async () => {
    await requestLink('not-an-email').expect(400);
    await verify('short').expect(400);
  });

  it('links a verified provider login to the existing user', async () => {
    const auth = app.get(AuthService);
    const byEmail = await auth.loginWithProvider('email', 'x@y.com', 'x@y.com', true);
    const byGoogle = await auth.loginWithProvider('google', 'g-123', 'X@y.com', true);
    expect(byGoogle.id).toBe(byEmail.id);
    const again = await auth.loginWithProvider('google', 'g-123', 'x@y.com', false);
    expect(again.id).toBe(byEmail.id);
    await expect(auth.loginWithProvider('google', 'g-999', 'new@y.com', false)).rejects.toThrow('Email not verified');
  });
});
```

- [ ] **Step 2: Verifica che fallisca**

Run: `pnpm --filter @summarize/api test -- auth`
Expected: FAIL con "Cannot find module '../src/auth/auth.service'".

- [ ] **Step 3: Implementa**

`apps/api/src/auth/tokens.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';

export const randomToken = () => randomBytes(32).toString('base64url');
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
```

`apps/api/src/auth/mail.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { config } from '../config';

@Injectable()
export class MailService {
  private transport = createTransport(config.smtpUrl);

  async send(to: string, subject: string, text: string) {
    await this.transport.sendMail({ from: config.mailFrom, to, subject, text });
  }
}
```

`apps/api/src/auth/auth.service.ts`:

```ts
import { HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthProvider, User } from '@summarize/db';
import { config } from '../config';
import { PrismaService } from '../prisma.service';
import { MailService } from './mail.service';
import { randomToken, sha256 } from './tokens';

const MAGIC_LINK_TTL_MS = 15 * 60_000;
const MAX_LINKS_PER_HOUR = 5;
export const SESSION_TTL_MS = 30 * 24 * 3600_000;

const normalizeEmail = (email: string) => email.trim().toLowerCase();

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private mail: MailService) {}

  async requestMagicLink(rawEmail: string) {
    const email = normalizeEmail(rawEmail);
    const recent = await this.prisma.magicLinkToken.count({
      where: { email, createdAt: { gt: new Date(Date.now() - 3600_000) } },
    });
    if (recent >= MAX_LINKS_PER_HOUR) throw new HttpException('Too many login links requested, try again later', 429);
    const token = randomToken();
    await this.prisma.magicLinkToken.create({
      data: { tokenHash: sha256(token), email, expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS) },
    });
    // The link opens a web page that POSTs the token: mail scanners that prefetch GET links cannot burn it.
    const link = `${config.webOrigin}/auth/verify?token=${token}`;
    await this.mail.send(
      email,
      'Your Summarize login link',
      `Open this link to log in (valid for 15 minutes):\n\n${link}\n\nIf you did not ask for it, ignore this email.`,
    );
  }

  async verifyMagicLink(token: string): Promise<string> {
    const tokenHash = sha256(token);
    const { count } = await this.prisma.magicLinkToken.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (count !== 1) throw new UnauthorizedException('Invalid or expired link');
    const { email } = await this.prisma.magicLinkToken.findUniqueOrThrow({ where: { tokenHash } });
    const user = await this.loginWithProvider('email', email, email, true);
    return this.createSession(user.id);
  }

  async loginWithProvider(provider: AuthProvider, providerAccountId: string, rawEmail: string, emailVerified: boolean): Promise<User> {
    const email = normalizeEmail(rawEmail);
    const account = await this.prisma.authAccount.findUnique({
      where: { provider_providerAccountId: { provider, providerAccountId } },
      include: { user: true },
    });
    if (account) return account.user;
    // Linking by email is only safe when the provider vouches for the address.
    if (!emailVerified) throw new UnauthorizedException('Email not verified by the login provider');
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.upsert({ where: { email }, update: {}, create: { email } });
      await tx.authAccount.create({ data: { userId: user.id, provider, providerAccountId } });
      return user;
    });
  }

  async createSession(userId: string): Promise<string> {
    const token = randomToken();
    await this.prisma.session.create({
      data: { id: sha256(token), userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
    });
    return token;
  }

  async userForSession(token?: string): Promise<User | null> {
    if (!token) return null;
    const session = await this.prisma.session.findUnique({ where: { id: sha256(token) }, include: { user: true } });
    if (!session || session.expiresAt < new Date() || session.user.deletedAt) return null;
    return session.user;
  }

  async logout(token?: string) {
    if (token) await this.prisma.session.deleteMany({ where: { id: sha256(token) } });
  }
}
```

`apps/api/src/auth/session.guard.ts`:

```ts
import { CanActivate, createParamDecorator, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { User } from '@summarize/db';
import { CookieOptions } from 'express';
import { AuthService, SESSION_TTL_MS } from './auth.service';

export const SESSION_COOKIE = 'sid';
export const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: SESSION_TTL_MS,
  path: '/',
};

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private auth: AuthService) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const user = await this.auth.userForSession(req.cookies?.[SESSION_COOKIE]);
    if (!user) throw new UnauthorizedException();
    req.user = user;
    return true;
  }
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().user as User);
```

`apps/api/src/auth/auth.dto.ts`:

```ts
import { IsEmail, IsString, Length, MaxLength } from 'class-validator';

export class MagicLinkDto {
  @IsEmail()
  @MaxLength(254)
  email: string;
}

export class VerifyDto {
  @IsString()
  @Length(20, 100)
  token: string;
}
```

`apps/api/src/auth/auth.controller.ts`:

```ts
import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { MagicLinkDto, VerifyDto } from './auth.dto';
import { AuthService } from './auth.service';
import { cookieOptions, SESSION_COOKIE } from './session.guard';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post('magic-link')
  @HttpCode(204)
  async requestLink(@Body() dto: MagicLinkDto) {
    await this.auth.requestMagicLink(dto.email);
  }

  @Post('magic-link/verify')
  @HttpCode(204)
  async verify(@Body() dto: VerifyDto, @Res({ passthrough: true }) res: Response) {
    res.cookie(SESSION_COOKIE, await this.auth.verifyMagicLink(dto.token), cookieOptions);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }
}
```

`apps/api/src/auth/auth.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MailService } from './mail.service';
import { SessionGuard } from './session.guard';

@Module({
  controllers: [AuthController],
  providers: [AuthService, MailService, SessionGuard],
  exports: [AuthService, MailService, SessionGuard],
})
export class AuthModule {}
```

`apps/api/src/me.controller.ts`:

```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { User } from '@summarize/db';
import { CurrentUser, SessionGuard } from './auth/session.guard';

@Controller('me')
@UseGuards(SessionGuard)
export class MeController {
  @Get()
  me(@CurrentUser() user: User) {
    return { id: user.id, email: user.email, name: user.name };
  }
}
```

In `apps/api/src/app.module.ts` aggiungi `AuthModule` agli `imports` e `MeController` ai `controllers`:

```ts
import { AuthModule } from './auth/auth.module';
import { MeController } from './me.controller';
// imports: [PrismaModule, AuthModule, ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }])],
// controllers: [HealthController, MeController],
```

- [ ] **Step 4: Verifica che passi**

Run: `pnpm --filter @summarize/api test`
Expected: PASS, tutti i test di `health.spec.ts` e `auth.spec.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): magic link login, server-side sessions, /api/me"
```

---

### Task 5: Login con Google ed elenco dei provider

**Files:**
- Create: `apps/api/src/auth/google.strategy.ts`, `apps/api/src/auth/google.controller.ts`
- Modify: `apps/api/src/auth/auth.module.ts`, `apps/api/src/auth/auth.controller.ts`
- Test: `apps/api/test/google.spec.ts`, e un caso in più in `apps/api/test/auth.spec.ts`

**Interfaces:**
- Consumes: `AuthService.loginWithProvider`, `AuthService.createSession`, `SESSION_COOKIE`, `cookieOptions`, `config.google`.
- Produces:
  - `GET /api/auth/providers` → `{ google: boolean }`;
  - `GET /api/auth/google` → 302 verso Google;
  - `GET /api/auth/google/callback` → cookie `sid` e redirect a `WEB_ORIGIN + '/'`;
  - le route Google esistono solo se `GOOGLE_CLIENT_ID` è impostato.

- [ ] **Step 1: Scrivi i test che falliscono**

In `apps/api/test/auth.spec.ts` aggiungi:

```ts
  it('lists login providers (google off without config)', async () => {
    const res = await http().get('/api/auth/providers').expect(200);
    expect(res.body).toEqual({ google: false });
    await http().get('/api/auth/google').expect(404);
  });
```

`apps/api/test/google.spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

describe('google login', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // config is read at import time, so set the env before loading the app
    process.env.GOOGLE_CLIENT_ID = 'test-client';
    process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
    process.env.GOOGLE_CALLBACK_URL = 'http://localhost:5173/api/auth/google/callback';
    const { createApp } = await import('./helpers');
    app = await createApp();
  });
  afterAll(() => app.close());

  it('advertises google and redirects to the consent screen', async () => {
    expect((await request(app.getHttpServer()).get('/api/auth/providers')).body).toEqual({ google: true });
    const res = await request(app.getHttpServer()).get('/api/auth/google').expect(302);
    expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    expect(res.headers.location).toContain('client_id=test-client');
    expect(res.headers.location).toContain(encodeURIComponent('http://localhost:5173/api/auth/google/callback'));
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm --filter @summarize/api test -- auth google`
Expected: FAIL; `/api/auth/providers` risponde 404.

- [ ] **Step 3: Implementa**

`apps/api/src/auth/google.strategy.ts`:

```ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Profile, Strategy } from 'passport-google-oauth20';
import { config } from '../config';
import { AuthService } from './auth.service';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(private auth: AuthService) {
    super({
      clientID: config.google!.clientId,
      clientSecret: config.google!.clientSecret,
      callbackURL: config.google!.callbackUrl,
      scope: ['email', 'profile'],
    });
  }

  async validate(_accessToken: string, _refreshToken: string, profile: Profile) {
    const email = profile.emails?.[0];
    if (!email) throw new UnauthorizedException('Google account has no email');
    return this.auth.loginWithProvider('google', profile.id, email.value, email.verified === true);
  }
}
```

`apps/api/src/auth/google.controller.ts`:

```ts
import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { User } from '@summarize/db';
import { Request, Response } from 'express';
import { config } from '../config';
import { AuthService } from './auth.service';
import { cookieOptions, SESSION_COOKIE } from './session.guard';

@Controller('auth/google')
export class GoogleController {
  constructor(private auth: AuthService) {}

  @Get()
  @UseGuards(AuthGuard('google'))
  start() {
    // passport redirects to Google
  }

  @Get('callback')
  @UseGuards(AuthGuard('google'))
  async callback(@Req() req: Request, @Res() res: Response) {
    res.cookie(SESSION_COOKIE, await this.auth.createSession((req.user as User).id), cookieOptions);
    res.redirect(`${config.webOrigin}/`);
  }
}
```

In `apps/api/src/auth/auth.controller.ts` aggiungi (con `Get` negli import da `@nestjs/common` e `import { config } from '../config';`):

```ts
  @Get('providers')
  providers() {
    return { google: config.google !== null };
  }
```

`apps/api/src/auth/auth.module.ts` diventa:

```ts
import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { config } from '../config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleController } from './google.controller';
import { GoogleStrategy } from './google.strategy';
import { MailService } from './mail.service';
import { SessionGuard } from './session.guard';

// Adding a provider (Apple in release 3) = one strategy + one controller registered here.
const google = config.google !== null;

@Module({
  imports: [PassportModule],
  controllers: [AuthController, ...(google ? [GoogleController] : [])],
  providers: [AuthService, MailService, SessionGuard, ...(google ? [GoogleStrategy] : [])],
  exports: [AuthService, MailService, SessionGuard],
})
export class AuthModule {}
```

- [ ] **Step 4: Verifica che passino**

Run: `pnpm --filter @summarize/api test`
Expected: PASS, compresi `google.spec.ts` e il nuovo caso in `auth.spec.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): google login and provider list"
```

---

### Task 6: Storage S3 e documenti (upload firmato, conferma, analisi in coda)

**Files:**
- Create: `apps/api/src/storage/storage.service.ts`, `src/storage/storage.module.ts`
- Create: `apps/api/src/credits/credits.ts`, `apps/api/src/jobs/job.dto.ts`
- Create: `apps/api/src/documents/documents.dto.ts`, `src/documents/documents.service.ts`, `src/documents/documents.controller.ts`, `src/documents/documents.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/documents.spec.ts`, `apps/api/test/credits.spec.ts`

**Interfaces:**
- Consumes: `SessionGuard`, `CurrentUser`, `PrismaService`, `config.s3`.
- Produces:
  - `StorageService` con `uploadUrl(key, sizeBytes): Promise<string>`, `head(key): Promise<{ size: number } | null>`, `downloadUrl(key, filename): Promise<string>` e `put(key, body: Buffer, contentType): Promise<void>`;
  - `creditsFor(words: number): number`;
  - `toJobDto(job: Job)` → `{ id, documentId, kind, options, status, progress, phase, credits, error, createdAt, finishedAt }`;
  - `toDocDto(doc)` → `{ id, filename, sizeBytes, status, rejectReason, pages, words, chapters, credits, createdAt, jobs }`.
- Route:
  - `POST /api/documents {filename, sizeBytes}` → 201 `{ document, uploadUrl }`;
  - `POST /api/documents/:id/uploaded` → 201 `document`, accoda un job `analyze`;
  - `GET /api/documents` → `document[]`, dal più recente, con i job `summarize`;
  - `GET /api/documents/:id` → `document`.

- [ ] **Step 1: Scrivi i test che falliscono**

`apps/api/test/credits.spec.ts`:

```ts
import { creditsFor } from '../src/credits/credits';

describe('creditsFor', () => {
  it('charges one credit per started 1000 words, at least one', () => {
    expect([0, 1, 999, 1000, 1001, 2500].map(creditsFor)).toEqual([1, 1, 1, 1, 2, 3]);
  });
});
```

`apps/api/test/documents.spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma.service';
import { StorageService } from '../src/storage/storage.service';
import { createApp, loginAs, ORIGIN, resetDb } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n% test file\n');

describe('documents', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());
  beforeEach(() => resetDb(prisma));

  const http = () => request(app.getHttpServer());
  const create = (cookie: string, body: object) =>
    http().post('/api/documents').set('Origin', ORIGIN).set('Cookie', cookie).send(body);
  const confirm = (cookie: string, id: string) =>
    http().post(`/api/documents/${id}/uploaded`).set('Origin', ORIGIN).set('Cookie', cookie);

  it('uploads through a signed URL and queues the analysis', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    const res = await create(cookie, { filename: 'Reading.pdf', sizeBytes: PDF.length }).expect(201);
    expect(res.body.document).toMatchObject({ filename: 'Reading.pdf', status: 'uploaded', credits: null });
    const put = await fetch(res.body.uploadUrl, { method: 'PUT', body: PDF, headers: { 'Content-Type': 'application/pdf' } });
    expect(put.status).toBe(200);
    await confirm(cookie, res.body.document.id).expect(201);
    const jobs = await prisma.job.findMany({ where: { documentId: res.body.document.id } });
    expect(jobs).toMatchObject([{ kind: 'analyze', status: 'queued', userId: user.id }]);
    await confirm(cookie, res.body.document.id).expect(409);
  });

  it('refuses to confirm before the file is uploaded', async () => {
    const { cookie } = await loginAs(app, 'u@x.com');
    const res = await create(cookie, { filename: 'a.pdf', sizeBytes: 10 }).expect(201);
    await confirm(cookie, res.body.document.id).expect(400);
  });

  it('rejects a stored file whose size differs from the declared one', async () => {
    const { cookie } = await loginAs(app, 'u@x.com');
    const res = await create(cookie, { filename: 'a.pdf', sizeBytes: 10 }).expect(201);
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: res.body.document.id } });
    await app.get(StorageService).put(doc.s3Key, Buffer.alloc(20), 'application/pdf');
    await confirm(cookie, doc.id).expect(400);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe('rejected');
  });

  it('validates filename, size and ids', async () => {
    const { cookie } = await loginAs(app, 'u@x.com');
    await create(cookie, { filename: 'a.pdf', sizeBytes: 50 * 1024 * 1024 + 1 }).expect(400);
    await create(cookie, { filename: 'notes.docx', sizeBytes: 10 }).expect(400);
    await create(cookie, { filename: 'a.pdf', sizeBytes: 0 }).expect(400);
    await http().get('/api/documents/not-a-uuid').set('Cookie', cookie).expect(400);
  });

  it('hides other users documents', async () => {
    const alice = await loginAs(app, 'alice@x.com');
    const bob = await loginAs(app, 'bob@x.com');
    const res = await create(alice.cookie, { filename: 'a.pdf', sizeBytes: 10 }).expect(201);
    await http().get(`/api/documents/${res.body.document.id}`).set('Cookie', bob.cookie).expect(404);
    await confirm(bob.cookie, res.body.document.id).expect(404);
    expect((await http().get('/api/documents').set('Cookie', bob.cookie).expect(200)).body).toEqual([]);
    expect((await http().get('/api/documents').set('Cookie', alice.cookie).expect(200)).body).toHaveLength(1);
  });

  it('limits uploads to 30 per hour', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    await prisma.document.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({ userId: user.id, filename: `${i}.pdf`, sizeBytes: 1, s3Key: `k${i}` })),
    });
    await create(cookie, { filename: 'a.pdf', sizeBytes: 10 }).expect(429);
  });

  it('requires a session', async () => {
    await http().get('/api/documents').expect(401);
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm --filter @summarize/api test -- documents credits`
Expected: FAIL con "Cannot find module '../src/credits/credits'".

- [ ] **Step 3: Implementa**

`apps/api/src/credits/credits.ts`:

```ts
export const WORDS_PER_CREDIT = 1000;

export function creditsFor(words: number): number {
  return Math.max(1, Math.ceil(words / WORDS_PER_CREDIT));
}
```

`apps/api/src/jobs/job.dto.ts`:

```ts
import { Job } from '@summarize/db';

// Never expose warnings, token counts or S3 keys to the browser.
export function toJobDto(job: Job) {
  const { id, documentId, kind, options, status, progress, phase, credits, error, createdAt, finishedAt } = job;
  return { id, documentId, kind, options, status, progress, phase, credits, error, createdAt, finishedAt };
}
```

`apps/api/src/storage/storage.service.ts`:

```ts
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { config } from '../config';

// RFC 5987 encoding; encodeURIComponent leaves ' ( ) * unescaped.
const rfc5987 = (value: string) =>
  encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

@Injectable()
export class StorageService {
  private bucket = config.s3.bucket;
  private s3 = new S3Client({
    endpoint: config.s3.endpoint,
    region: config.s3.region,
    forcePathStyle: config.s3.forcePathStyle,
    credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
  });

  // Presigned PUT (not POST: R2 has no POST policies). Content-Length is signed, and confirm re-checks it with HEAD.
  uploadUrl(key: string, sizeBytes: number) {
    return getSignedUrl(
      this.s3,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: 'application/pdf', ContentLength: sizeBytes }),
      { expiresIn: 15 * 60, signableHeaders: new Set(['content-type', 'content-length']) },
    );
  }

  async head(key: string): Promise<{ size: number } | null> {
    try {
      const res = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: res.ContentLength ?? 0 };
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  downloadUrl(key: string, filename: string) {
    const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987(filename)}`,
      }),
      { expiresIn: 5 * 60 },
    );
  }

  async put(key: string, body: Buffer, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }
}
```

`apps/api/src/storage/storage.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';

@Module({ providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
```

`apps/api/src/documents/documents.dto.ts`:

```ts
import { IsInt, IsString, Length, Matches, Max, Min } from 'class-validator';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export class CreateDocumentDto {
  @IsString()
  @Length(5, 255)
  @Matches(/\.pdf$/i, { message: 'Only PDF files are supported' })
  filename: string;

  @IsInt()
  @Min(1)
  @Max(MAX_UPLOAD_BYTES, { message: 'File larger than 50 MB' })
  sizeBytes: number;
}
```

`apps/api/src/documents/documents.service.ts`:

```ts
import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { Document, Job, User } from '@summarize/db';
import { randomUUID } from 'node:crypto';
import { creditsFor } from '../credits/credits';
import { toJobDto } from '../jobs/job.dto';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { MAX_UPLOAD_BYTES } from './documents.dto';

const MAX_UPLOADS_PER_HOUR = 30;
const withSummaries = { jobs: { where: { kind: 'summarize' as const }, orderBy: { createdAt: 'desc' as const } } };

export function toDocDto(doc: Document & { jobs?: Job[] }) {
  const { id, filename, sizeBytes, status, rejectReason, pages, words, chapters, createdAt } = doc;
  return {
    id, filename, sizeBytes, status, rejectReason, pages, words, chapters, createdAt,
    credits: words ? creditsFor(words) : null,
    jobs: (doc.jobs ?? []).map(toJobDto),
  };
}

@Injectable()
export class DocumentsService {
  constructor(private prisma: PrismaService, private storage: StorageService) {}

  async create(user: User, filename: string, sizeBytes: number) {
    const recent = await this.prisma.document.count({
      where: { userId: user.id, createdAt: { gt: new Date(Date.now() - 3600_000) } },
    });
    if (recent >= MAX_UPLOADS_PER_HOUR) throw new HttpException('Upload limit reached, try again in an hour', 429);
    const id = randomUUID();
    const s3Key = `users/${user.id}/documents/${id}.pdf`;
    const doc = await this.prisma.document.create({ data: { id, userId: user.id, filename, sizeBytes, s3Key } });
    return { document: toDocDto(doc), uploadUrl: await this.storage.uploadUrl(s3Key, sizeBytes) };
  }

  async confirmUpload(user: User, id: string) {
    const doc = await this.findOwned(user, id);
    const alreadyQueued = await this.prisma.job.count({ where: { documentId: id, kind: 'analyze' } });
    if (doc.status !== 'uploaded' || alreadyQueued) throw new ConflictException('Document already submitted');
    const head = await this.storage.head(doc.s3Key);
    if (!head) throw new BadRequestException('File not uploaded yet');
    if (head.size !== doc.sizeBytes || head.size > MAX_UPLOAD_BYTES) {
      await this.prisma.document.update({
        where: { id },
        data: { status: 'rejected', rejectReason: 'Uploaded file does not match the declared size' },
      });
      throw new BadRequestException('Uploaded file does not match the declared size');
    }
    await this.prisma.job.create({ data: { userId: user.id, documentId: id, kind: 'analyze' } });
    return toDocDto(doc);
  }

  async list(user: User) {
    const docs = await this.prisma.document.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      include: withSummaries,
    });
    return docs.map(toDocDto);
  }

  async get(user: User, id: string) {
    return toDocDto(await this.findOwned(user, id));
  }

  private async findOwned(user: User, id: string) {
    const doc = await this.prisma.document.findFirst({ where: { id, userId: user.id }, include: withSummaries });
    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }
}
```

`apps/api/src/documents/documents.controller.ts`:

```ts
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { User } from '@summarize/db';
import { CurrentUser, SessionGuard } from '../auth/session.guard';
import { CreateDocumentDto } from './documents.dto';
import { DocumentsService } from './documents.service';

@Controller('documents')
@UseGuards(SessionGuard)
export class DocumentsController {
  constructor(private documents: DocumentsService) {}

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateDocumentDto) {
    return this.documents.create(user, dto.filename, dto.sizeBytes);
  }

  @Post(':id/uploaded')
  confirm(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.confirmUpload(user, id);
  }

  @Get()
  list(@CurrentUser() user: User) {
    return this.documents.list(user);
  }

  @Get(':id')
  get(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.get(user, id);
  }
}
```

`apps/api/src/documents/documents.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

@Module({ imports: [AuthModule, StorageModule], controllers: [DocumentsController], providers: [DocumentsService] })
export class DocumentsModule {}
```

In `apps/api/src/app.module.ts` aggiungi `DocumentsModule` agli `imports`.

- [ ] **Step 4: Verifica che passino**

Run: `pnpm --filter @summarize/api test`
Expected: PASS. Se MinIO risponde 403 alla PUT del primo test, l'URL firmato e gli header inviati non coincidono (`Content-Type`, `Content-Length`): correggi `uploadUrl`, non il test.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): signed PDF uploads, document listing, analysis queueing"
```

---

### Task 7: Ledger dei crediti, creazione dei job, download, saldo e comando `grant`

**Files:**
- Create: `apps/api/src/credits/ledger.service.ts`, `src/credits/credits.module.ts`
- Create: `apps/api/src/jobs/options.ts`, `src/jobs/jobs.dto.ts`, `src/jobs/jobs.service.ts`, `src/jobs/jobs.controller.ts`, `src/jobs/jobs.module.ts`
- Create: `apps/api/src/cli/grant.ts`
- Modify: `apps/api/src/me.controller.ts`, `apps/api/src/app.module.ts`
- Test: `apps/api/test/jobs.spec.ts`

**Interfaces:**
- Consumes: `creditsFor`, `toJobDto`, `StorageService.downloadUrl`, `StorageService.put`, `SessionGuard`, `loginAs`.
- Produces:
  - `LedgerService.balance(userId, tx?)`: `Promise<number>`;
  - `JobsService.create(user, dto)`, `JobsService.get(user, id)` (restituisce il DTO; 404 se il job non è dell'utente) e `JobsService.downloadUrl(user, id, format)`;
  - costanti `LANGUAGES`, `FRACTIONS`, `PRESETS`.
- Route:
  - `POST /api/jobs {documentId, language, fraction, preset, bibliographicLine?}` → 201 job; errori: 402 `{message, needed, balance}` · 404 · 409 se il documento non è pronto · 429 oltre i 3 job attivi;
  - `GET /api/jobs/:id` → job;
  - `GET /api/jobs/:id/download?format=md|docx` → `{ url }`;
  - `GET /api/me` → `{ id, email, name, balance }`.
- CLI: `pnpm --filter @summarize/api grant <email> <credits>` (un numero negativo registra un `revoke`).

- [ ] **Step 1: Scrivi il test che fallisce**

`apps/api/test/jobs.spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma.service';
import { StorageService } from '../src/storage/storage.service';
import { createApp, loginAs, ORIGIN, resetDb } from './helpers';

const OPTIONS = { language: 'auto', fraction: 3, preset: 'studio' };

describe('jobs and credits', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());
  beforeEach(() => resetDb(prisma));

  const http = () => request(app.getHttpServer());
  const start = (cookie: string, body: object) => http().post('/api/jobs').set('Origin', ORIGIN).set('Cookie', cookie).send(body);
  const grant = (userId: string, amount: number) => prisma.creditLedger.create({ data: { userId, type: 'grant', amount } });
  const analyzedDoc = (userId: string, words = 2500, filename = 'reading.pdf') =>
    prisma.document.create({
      data: {
        userId, filename, sizeBytes: 100, s3Key: `users/${userId}/documents/x.pdf`, status: 'analyzed', pages: 10, words,
        chapters: [{ title: 'Document', pageFrom: 1, pageTo: 10, words }],
      },
    });
  const balance = async (cookie: string) => (await http().get('/api/me').set('Cookie', cookie).expect(200)).body.balance;

  it('refuses to start without enough credits', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    const doc = await analyzedDoc(user.id);
    const res = await start(cookie, { documentId: doc.id, ...OPTIONS }).expect(402);
    expect(res.body).toMatchObject({ needed: 3, balance: 0 });
  });

  it('reserves the quoted credits when a job starts', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    await grant(user.id, 10);
    const doc = await analyzedDoc(user.id, 2500);
    const res = await start(cookie, { documentId: doc.id, ...OPTIONS, bibliographicLine: '**A** – *B*' }).expect(201);
    expect(res.body).toMatchObject({ kind: 'summarize', status: 'queued', credits: 3, options: { ...OPTIONS, bibliographicLine: '**A** – *B*' } });
    expect(res.body.warnings).toBeUndefined();
    expect(await balance(cookie)).toBe(7);
    expect(await prisma.creditLedger.findMany({ where: { jobId: res.body.id } })).toMatchObject([{ type: 'reserve', amount: -3 }]);
  });

  it('never lets two parallel starts overspend', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    await grant(user.id, 3);
    const doc = await analyzedDoc(user.id, 2500);
    const results = await Promise.all([start(cookie, { documentId: doc.id, ...OPTIONS }), start(cookie, { documentId: doc.id, ...OPTIONS })]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 402]);
    expect(await balance(cookie)).toBe(0);
  });

  it('allows at most 3 active summaries', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    await grant(user.id, 100);
    const doc = await analyzedDoc(user.id, 500);
    for (let i = 0; i < 3; i++) await start(cookie, { documentId: doc.id, ...OPTIONS }).expect(201);
    await start(cookie, { documentId: doc.id, ...OPTIONS }).expect(429);
  });

  it('checks document state, ownership and options', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    const bob = await loginAs(app, 'bob@x.com');
    await grant(user.id, 100);
    const doc = await analyzedDoc(user.id);
    const pending = await prisma.document.create({ data: { userId: user.id, filename: 'p.pdf', sizeBytes: 1, s3Key: 'k' } });
    await start(cookie, { documentId: pending.id, ...OPTIONS }).expect(409);
    await start(bob.cookie, { documentId: doc.id, ...OPTIONS }).expect(404);
    await start(cookie, { documentId: doc.id, ...OPTIONS, fraction: 4 }).expect(400);
    await start(cookie, { documentId: doc.id, ...OPTIONS, preset: 'poem' }).expect(400);
    await start(cookie, { documentId: doc.id, ...OPTIONS, bibliographicLine: 'a\nb' }).expect(400);
    const job = await start(cookie, { documentId: doc.id, ...OPTIONS }).expect(201);
    await http().get(`/api/jobs/${job.body.id}`).set('Cookie', bob.cookie).expect(404);
    await http().get(`/api/jobs/${job.body.id}`).set('Cookie', cookie).expect(200);
  });

  it('serves downloads only when done, with a unicode-safe filename', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    await grant(user.id, 10);
    const doc = await analyzedDoc(user.id, 500, 'Lijphart – CH 2 & 3 "è".pdf');
    const job = (await start(cookie, { documentId: doc.id, ...OPTIONS }).expect(201)).body;
    await http().get(`/api/jobs/${job.id}/download?format=md`).set('Cookie', cookie).expect(404);
    await http().get(`/api/jobs/${job.id}/download?format=pdf`).set('Cookie', cookie).expect(400);

    const key = `users/${user.id}/results/${job.id}.md`;
    await app.get(StorageService).put(key, Buffer.from('# Summary\n'), 'text/markdown');
    await prisma.job.update({ where: { id: job.id }, data: { status: 'done', resultMdKey: key } });
    const { url } = (await http().get(`/api/jobs/${job.id}/download?format=md`).set('Cookie', cookie).expect(200)).body;
    const file = await fetch(url);
    expect(await file.text()).toBe('# Summary\n');
    const disposition = file.headers.get('content-disposition')!;
    expect(decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(disposition)![1])).toBe('Lijphart – CH 2 & 3 "è" - Summary.md');
  });
});
```

- [ ] **Step 2: Verifica che fallisca**

Run: `pnpm --filter @summarize/api test -- jobs`
Expected: FAIL; `POST /api/jobs` risponde 404.

- [ ] **Step 3: Implementa**

`apps/api/src/credits/ledger.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Prisma } from '@summarize/db';
import { PrismaService } from '../prisma.service';

@Injectable()
export class LedgerService {
  constructor(private prisma: PrismaService) {}

  // Balance = SUM(amount): reserve is negative, charge is 0, refund gives the reserve back.
  async balance(userId: string, tx: Prisma.TransactionClient = this.prisma): Promise<number> {
    const { _sum } = await tx.creditLedger.aggregate({ where: { userId }, _sum: { amount: true } });
    return _sum.amount ?? 0;
  }
}
```

`apps/api/src/credits/credits.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';

@Module({ providers: [LedgerService], exports: [LedgerService] })
export class CreditsModule {}
```

`apps/api/src/jobs/options.ts`:

```ts
// Must match apps/worker/summarize_worker/prompts.py
export const LANGUAGES = ['auto', 'en', 'it', 'nl', 'fr', 'de', 'es'] as const;
export const FRACTIONS = [3, 5, 10] as const;
export const PRESETS = ['studio', 'schematico', 'abstract'] as const;
export const MAX_ACTIVE_SUMMARIES = 3;
```

`apps/api/src/jobs/jobs.dto.ts`:

```ts
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { FRACTIONS, LANGUAGES, PRESETS } from './options';

export class CreateJobDto {
  @IsUUID()
  documentId: string;

  @IsIn(LANGUAGES)
  language: (typeof LANGUAGES)[number];

  @IsIn(FRACTIONS)
  fraction: (typeof FRACTIONS)[number];

  @IsIn(PRESETS)
  preset: (typeof PRESETS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(300)
  @Matches(/^[^\r\n]*$/, { message: 'bibliographicLine must be a single line' })
  bibliographicLine?: string;
}
```

`apps/api/src/jobs/jobs.service.ts`:

```ts
import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { User } from '@summarize/db';
import { creditsFor } from '../credits/credits';
import { LedgerService } from '../credits/ledger.service';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { toJobDto } from './job.dto';
import { CreateJobDto } from './jobs.dto';
import { MAX_ACTIVE_SUMMARIES } from './options';

@Injectable()
export class JobsService {
  constructor(private prisma: PrismaService, private ledger: LedgerService, private storage: StorageService) {}

  create(user: User, dto: CreateJobDto) {
    const { documentId, ...options } = dto;
    return this.prisma.$transaction(async (tx) => {
      // Row lock on the user serialises concurrent starts, so the balance check below cannot race.
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id}::uuid FOR UPDATE`;
      const doc = await tx.document.findFirst({ where: { id: documentId, userId: user.id } });
      if (!doc) throw new NotFoundException('Document not found');
      if (doc.status !== 'analyzed' || !doc.words || doc.fileDeletedAt) throw new ConflictException('Document is not ready');
      const active = await tx.job.count({
        where: { userId: user.id, kind: 'summarize', status: { in: ['queued', 'running'] } },
      });
      if (active >= MAX_ACTIVE_SUMMARIES) throw new HttpException(`You already have ${MAX_ACTIVE_SUMMARIES} summaries in progress`, 429);
      const credits = creditsFor(doc.words);
      const balance = await this.ledger.balance(user.id, tx);
      if (balance < credits) throw new HttpException({ message: 'Not enough credits', needed: credits, balance }, 402);
      const job = await tx.job.create({ data: { userId: user.id, documentId, kind: 'summarize', options, credits } });
      await tx.creditLedger.create({ data: { userId: user.id, type: 'reserve', amount: -credits, jobId: job.id } });
      return toJobDto(job);
    });
  }

  async get(user: User, id: string) {
    return toJobDto(await this.findOwned(user, id));
  }

  async downloadUrl(user: User, id: string, format: string) {
    if (format !== 'md' && format !== 'docx') throw new BadRequestException('format must be md or docx');
    const job = await this.findOwned(user, id);
    const key = format === 'md' ? job.resultMdKey : job.resultDocxKey;
    if (job.status !== 'done' || !key) throw new NotFoundException('Summary not ready');
    const base = job.document.filename.replace(/\.pdf$/i, '');
    return { url: await this.storage.downloadUrl(key, `${base} - Summary.${format}`) };
  }

  private async findOwned(user: User, id: string) {
    const job = await this.prisma.job.findFirst({ where: { id, userId: user.id }, include: { document: true } });
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }
}
```

`apps/api/src/jobs/jobs.controller.ts`:

```ts
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { User } from '@summarize/db';
import { CurrentUser, SessionGuard } from '../auth/session.guard';
import { CreateJobDto } from './jobs.dto';
import { JobsService } from './jobs.service';

@Controller('jobs')
@UseGuards(SessionGuard)
export class JobsController {
  constructor(private jobs: JobsService) {}

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateJobDto) {
    return this.jobs.create(user, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.get(user, id);
  }

  @Get(':id/download')
  download(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string, @Query('format') format: string) {
    return this.jobs.downloadUrl(user, id, format);
  }
}
```

`apps/api/src/jobs/jobs.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CreditsModule } from '../credits/credits.module';
import { StorageModule } from '../storage/storage.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

@Module({ imports: [AuthModule, CreditsModule, StorageModule], controllers: [JobsController], providers: [JobsService] })
export class JobsModule {}
```

`apps/api/src/me.controller.ts` diventa:

```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { User } from '@summarize/db';
import { CurrentUser, SessionGuard } from './auth/session.guard';
import { LedgerService } from './credits/ledger.service';

@Controller('me')
@UseGuards(SessionGuard)
export class MeController {
  constructor(private ledger: LedgerService) {}

  @Get()
  async me(@CurrentUser() user: User) {
    return { id: user.id, email: user.email, name: user.name, balance: await this.ledger.balance(user.id) };
  }
}
```

In `apps/api/src/app.module.ts` aggiungi `CreditsModule` e `JobsModule` agli `imports`.

`apps/api/src/cli/grant.ts`:

```ts
// Usage: pnpm --filter @summarize/api grant <email> <credits>   (negative = revoke)
import '../config';
import { PrismaClient } from '@summarize/db';

async function main() {
  const [rawEmail, rawAmount] = process.argv.slice(2);
  const amount = Number(rawAmount);
  if (!rawEmail || !Number.isInteger(amount) || amount === 0) {
    console.error('Usage: grant <email> <credits>');
    process.exit(1);
  }
  const email = rawEmail.trim().toLowerCase();
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.upsert({ where: { email }, update: {}, create: { email } });
    await prisma.creditLedger.create({ data: { userId: user.id, type: amount > 0 ? 'grant' : 'revoke', amount } });
    const { _sum } = await prisma.creditLedger.aggregate({ where: { userId: user.id }, _sum: { amount: true } });
    console.log(`${email}: ${amount > 0 ? '+' : ''}${amount} credits, balance ${_sum.amount ?? 0}`);
  } finally {
    await prisma.$disconnect();
  }
}
main();
```

- [ ] **Step 4: Verifica che passi**

Run: `pnpm --filter @summarize/api test`
Expected: PASS, tutti i file di test.

- [ ] **Step 5: Verifica la CLI sul DB di sviluppo**

Run: `pnpm --filter @summarize/api grant dev@example.com 5`
Expected: `dev@example.com: +5 credits, balance 5`.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat(api): credit ledger, job creation with reservation, downloads, grant CLI"
```

---

### Task 8: Avanzamento del job via SSE

**Files:**
- Modify: `apps/api/src/jobs/jobs.controller.ts`
- Test: `apps/api/test/events.spec.ts`

**Interfaces:**
- Consumes: `JobsService.get(user, id)`.
- Produces: `GET /api/jobs/:id/events` → `text/event-stream`. Ogni evento è `data: <JSON del job DTO>\n\n`. Si invia solo quando il DTO cambia e lo stream si chiude dopo il primo evento con `status` `done` o `failed`. Se il job non è dell'utente la risposta è 404, prima di aprire lo stream.

- [ ] **Step 1: Scrivi il test che fallisce**

`apps/api/test/events.spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma.service';
import { createApp, loginAs, resetDb } from './helpers';

const collect = (res: any, cb: (err: Error | null, body: string) => void) => {
  let body = '';
  res.on('data', (chunk: Buffer) => (body += chunk));
  res.on('end', () => cb(null, body));
};

describe('job events', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());
  beforeEach(() => resetDb(prisma));

  async function queuedJob(userId: string) {
    const doc = await prisma.document.create({ data: { userId, filename: 'a.pdf', sizeBytes: 1, s3Key: 'k', status: 'analyzed', words: 10 } });
    return prisma.job.create({ data: { userId, documentId: doc.id, kind: 'summarize', credits: 1 } });
  }

  it('streams changes until the job finishes', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    const job = await queuedJob(user.id);
    setTimeout(() => prisma.job.update({ where: { id: job.id }, data: { status: 'running', progress: 40, phase: 'Chapter 1/1: draft' } }).then(), 500);
    setTimeout(() => prisma.job.update({ where: { id: job.id }, data: { status: 'done', progress: 100, phase: 'done' } }).then(), 3000);

    const res = await request(app.getHttpServer())
      .get(`/api/jobs/${job.id}/events`)
      .set('Cookie', cookie)
      .buffer(true)
      .parse(collect)
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);

    const events = (res.body as string).split('\n\n').filter(Boolean).map((e) => JSON.parse(e.replace(/^data: /, '')));
    expect(events.map((e) => e.status)).toEqual(['queued', 'running', 'done']);
    expect(events[1]).toMatchObject({ progress: 40, phase: 'Chapter 1/1: draft' });
  }, 15_000);

  it('returns 404 for someone else job', async () => {
    const alice = await loginAs(app, 'alice@x.com');
    const bob = await loginAs(app, 'bob@x.com');
    const job = await queuedJob(alice.user.id);
    await request(app.getHttpServer()).get(`/api/jobs/${job.id}/events`).set('Cookie', bob.cookie).expect(404);
  });
});
```

- [ ] **Step 2: Verifica che fallisca**

Run: `pnpm --filter @summarize/api test -- events`
Expected: FAIL con "expected 200, got 404", perché la route non esiste ancora.

- [ ] **Step 3: Implementa**

In `apps/api/src/jobs/jobs.controller.ts` aggiungi `Res` agli import di `@nestjs/common` e `import { Response } from 'express';`, poi il metodo:

```ts
  // ponytail: one DB poll every 2 s per open stream; switch to LISTEN/NOTIFY if many viewers watch at once.
  @Get(':id/events')
  async events(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const first = await this.jobs.get(user, id); // throws 404 before any header is sent
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    let last = '';
    const send = (job: typeof first) => {
      const data = JSON.stringify(job);
      if (data !== last) res.write(`data: ${data}\n\n`);
      last = data;
      return job.status === 'done' || job.status === 'failed';
    };
    if (send(first)) return res.end();
    const timer = setInterval(async () => {
      try {
        if (send(await this.jobs.get(user, id))) {
          clearInterval(timer);
          res.end();
        }
      } catch {
        clearInterval(timer);
        res.end();
      }
    }, 2000);
    res.on('close', () => clearInterval(timer));
  }
```

L'ordine dei metodi nella classe non conta: `:id/events` ha due segmenti e non entra in conflitto con `:id`.

- [ ] **Step 4: Verifica che passi**

Run: `pnpm --filter @summarize/api test`
Expected: PASS, tutti i file di test.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): server-sent job progress events"
```

---

### Task 9: Worker — pacchetto Python, estrazione del testo e divisione in capitoli

**Files:**
- Create: `apps/worker/package.json`, `apps/worker/pyproject.toml`, `apps/worker/summarize_worker/__init__.py`, `apps/worker/summarize_worker/text.py`
- Test: `apps/worker/tests/__init__.py`, `apps/worker/tests/pdfs.py`, `apps/worker/tests/test_text.py`

**Interfaces:**
- Consumes: nessuna. Porta `estrai_testo`, `pulisci_pagine` e `suddividi_in_capitoli` da `legacy/riassumi_libro.py`.
- Produces:
  - `Chapter(title: str, page_from: int | None, page_to: int | None, text: str)` con la property `words: int` e `as_json() -> dict` (`{"title", "pageFrom", "pageTo", "words"}`);
  - `inspect_pdf(pdf: bytes) -> tuple[int, bool]`, che restituisce (pagine, serve password) e solleva `ValueError` se il file non è leggibile;
  - `extract_pages(pdf: bytes, ocr_langs: str | None, on_page: Callable[[int, int], None] | None = None) -> tuple[list[str], list[list], bool]`, che restituisce (testo per pagina, outline di `get_toc()`, OCR usato);
  - `clean_pages(pages: list[str]) -> list[str]`;
  - `split_chapters(pages: list[str], toc: list, max_words: int = 15000) -> list[Chapter]`;
  - helper di test `tests.pdfs.make_pdf(pages: list[str], toc=None, **save_options) -> bytes`.

- [ ] **Step 1: Pacchetto**

`apps/worker/package.json` (serve solo a far girare i test da turbo; la venv deve essere attiva):

```json
{
  "name": "@summarize/worker",
  "private": true,
  "scripts": {
    "test": "python -m pytest -q",
    "dev": "python -m summarize_worker"
  }
}
```

`apps/worker/pyproject.toml`:

```toml
[project]
name = "summarize-worker"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "openai>=1.50",
  "pymupdf>=1.24",
  "pytesseract>=0.3.10",
  "pillow>=10",
  "pypandoc_binary>=1.13",
  "psycopg[binary]>=3.2",
  "boto3>=1.35",
]

[project.optional-dependencies]
dev = ["pytest>=8"]

[build-system]
requires = ["setuptools>=69"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
include = ["summarize_worker*"]

[tool.setuptools.package-data]
summarize_worker = ["presets/*.md"]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]
```

`apps/worker/summarize_worker/__init__.py`: file vuoto. Anche `apps/worker/tests/__init__.py`: file vuoto.

Run: `pip install -e "apps/worker[dev]"`
Expected: "Successfully installed summarize-worker-0.1.0" e le dipendenze.

- [ ] **Step 2: Scrivi il test che fallisce**

`apps/worker/tests/pdfs.py`:

```python
import fitz


def make_pdf(pages: list[str], toc=None, **save_options) -> bytes:
    """Small real PDF with one text block per page; save_options go to Document.tobytes (e.g. encryption)."""
    doc = fitz.open()
    for text in pages:
        page = doc.new_page()
        page.insert_textbox(fitz.Rect(72, 72, 523, 770), text, fontsize=10)
    if toc:
        doc.set_toc(toc)
    data = doc.tobytes(**save_options)
    doc.close()
    return data
```

`apps/worker/tests/test_text.py`:

```python
import fitz
import pytest

from summarize_worker.text import clean_pages, extract_pages, inspect_pdf, split_chapters
from tests.pdfs import make_pdf


def test_extract_pages_outline_and_progress():
    pdf = make_pdf(["First page text", "Second page text"], toc=[[1, "Intro", 1], [1, "Body", 2]])
    seen = []
    pages, toc, used_ocr = extract_pages(pdf, ocr_langs=None, on_page=lambda i, n: seen.append((i, n)))
    assert [p.strip() for p in pages] == ["First page text", "Second page text"]
    assert toc == [[1, "Intro", 1], [1, "Body", 2]]
    assert used_ocr is False
    assert seen == [(1, 2), (2, 2)]


def test_inspect_pdf():
    assert inspect_pdf(make_pdf(["a", "b", "c"])) == (3, False)
    locked = make_pdf(["secret"], encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="user")
    assert inspect_pdf(locked)[1] is True
    with pytest.raises(ValueError):
        inspect_pdf(b"%PDF-1.4 garbage")


def test_split_by_outline_uses_top_level_entries():
    chapters = split_chapters(["p1", "p2", "p3", "p4"], [[1, "One", 1], [2, "Sub", 2], [1, "Two", 3]])
    assert [(c.title, c.page_from, c.page_to, c.text) for c in chapters] == [
        ("One", 1, 2, "p1\np2"),
        ("Two", 3, 4, "p3\np4"),
    ]


def test_outline_entries_on_the_same_page_are_merged():
    chapters = split_chapters(["p1", "p2"], [[1, "One", 1], [1, "One bis", 1], [1, "Two", 2]])
    assert [c.title for c in chapters] == ["One", "Two"]


def test_split_by_chapter_headings_without_outline():
    pages = ["Preface text", "Chapter 1 Origins\nalpha beta", "more alpha", "Chapter 2 Growth\ngamma"]
    chapters = split_chapters(pages, [])
    assert [(c.title, c.page_from, c.page_to) for c in chapters] == [
        ("Chapter 1 Origins", 2, 3),
        ("Chapter 2 Growth", 4, 4),
    ]


def test_unstructured_text_is_one_chapter():
    chapters = split_chapters(["just text", "more text"], [])
    assert [(c.title, c.page_from, c.page_to, c.words) for c in chapters] == [("Document", 1, 2, 4)]
    assert chapters[0].as_json() == {"title": "Document", "pageFrom": 1, "pageTo": 2, "words": 4}


def test_whole_book_without_structure_is_capped():
    chapters = split_chapters(["word " * 12500, "word " * 12500], [], max_words=15000)
    assert len(chapters) == 2 and all(c.words <= 15000 for c in chapters)
    assert sum(c.words for c in chapters) == 25000
    assert chapters[0].title == "Document (part 1/2)"


def test_empty_document_has_no_chapters():
    assert split_chapters(["", "  "], []) == []


def test_clean_pages_drops_repeated_headers_and_page_numbers():
    pages = [f"PATTERNS OF DEMOCRACY\nBody text {i}\n{i}" for i in range(1, 6)]
    assert clean_pages(pages) == [f"Body text {i}" for i in range(1, 6)]
```

- [ ] **Step 3: Verifica che fallisca**

Run: `cd apps/worker && python -m pytest tests/test_text.py -q`
Expected: FAIL con "ModuleNotFoundError: No module named 'summarize_worker.text'".

- [ ] **Step 4: Implementa**

`apps/worker/summarize_worker/text.py`:

```python
"""PDF text extraction and chapter splitting (ported from legacy/riassumi_libro.py)."""
import re
from dataclasses import dataclass
from typing import Callable

import fitz  # PyMuPDF

CHAPTER_HEADING = re.compile(r"^\s*(cap(itolo)?\.?\s*\d+|chapter\s*\d+|parte\s+[ivxlcdm\d]+)\b", re.IGNORECASE)


@dataclass
class Chapter:
    title: str
    page_from: int | None  # 1-based, inclusive
    page_to: int | None
    text: str

    @property
    def words(self) -> int:
        return len(self.text.split())

    def as_json(self) -> dict:
        return {"title": self.title, "pageFrom": self.page_from, "pageTo": self.page_to, "words": self.words}


def inspect_pdf(pdf: bytes) -> tuple[int, bool]:
    """Page count and whether a password is needed. Raises ValueError if the PDF cannot be opened."""
    try:
        doc = fitz.open(stream=pdf, filetype="pdf")
    except Exception as e:
        raise ValueError(f"unreadable PDF: {e}") from e
    try:
        return doc.page_count, doc.needs_pass
    finally:
        doc.close()


def extract_pages(pdf: bytes, ocr_langs: str | None,
                  on_page: Callable[[int, int], None] | None = None) -> tuple[list[str], list[list], bool]:
    """Text per page (OCR fallback on near-empty pages), the PDF outline, and whether OCR was used."""
    doc = fitz.open(stream=pdf, filetype="pdf")
    try:
        pages, used_ocr = [], False
        for i, page in enumerate(doc, 1):
            text = page.get_text("text")
            if ocr_langs and len(text.strip()) < 40:  # probably a scanned page
                ocr = _ocr(page, ocr_langs)
                if len(ocr.strip()) > len(text.strip()):
                    text, used_ocr = ocr, True
            pages.append(text)
            if on_page:
                on_page(i, doc.page_count)
        return pages, doc.get_toc(), used_ocr
    finally:
        doc.close()


def _ocr(page, langs: str) -> str:
    try:
        import pytesseract
        from PIL import Image
        pix = page.get_pixmap(dpi=300)  # rendered by PyMuPDF: no poppler needed
        return pytesseract.image_to_string(Image.frombytes("RGB", (pix.width, pix.height), pix.samples), lang=langs)
    except Exception as e:  # tesseract missing or failing: keep the text layer
        print(f"OCR failed on page {page.number + 1}: {e}")
        return ""


def clean_pages(pages: list[str]) -> list[str]:
    """Drops lines repeated on many pages (running headers/footers) and isolated page numbers."""
    counts: dict[str, int] = {}
    for text in pages:
        for line in {l.strip() for l in text.splitlines() if l.strip()}:
            counts[line] = counts.get(line, 0) + 1
    threshold = max(3, int(len(pages) * 0.4))
    repeated = {l for l, c in counts.items() if c >= threshold and len(l) < 80}
    cleaned = []
    for text in pages:
        lines = [l for l in text.splitlines()
                 if l.strip() not in repeated and not re.fullmatch(r"[\d ivxlcdmIVXLCDM\-–—]{1,6}", l.strip())]
        cleaned.append("\n".join(lines))
    return cleaned


def split_chapters(pages: list[str], toc: list, max_words: int = 15000) -> list[Chapter]:
    """Outline first, then 'Chapter N' headings, else the whole text; long chapters are cut to max_words."""
    chapters = _by_outline(pages, toc) or _by_headings(pages) or _whole(pages)
    return _cap(chapters, max_words)


def _by_outline(pages: list[str], toc: list) -> list[Chapter]:
    starts, seen = [], set()
    for level, title, page in toc:
        if level == 1 and 1 <= page <= len(pages) and page not in seen:
            starts.append((title.strip() or f"Part {len(starts) + 1}", page))
            seen.add(page)
    starts.sort(key=lambda s: s[1])
    if len(starts) < 2:
        return []
    # ponytail: pages before the first entry (cover, contents) are dropped, like the legacy CLI.
    chapters = []
    for i, (title, first) in enumerate(starts):
        last = starts[i + 1][1] - 1 if i + 1 < len(starts) else len(pages)
        chapters.append(Chapter(title, first, last, "\n".join(pages[first - 1:last]).strip()))
    return [c for c in chapters if c.text]


def _by_headings(pages: list[str]) -> list[Chapter]:
    lines = [(p, line) for p, text in enumerate(pages, 1) for line in text.splitlines()]
    starts = [i for i, (_, line) in enumerate(lines) if CHAPTER_HEADING.match(line)]
    if len(starts) < 2:
        return []
    chapters = []
    for k, start in enumerate(starts):
        end = starts[k + 1] if k + 1 < len(starts) else len(lines)
        block = lines[start:end]
        text = "\n".join(line for _, line in block).strip()
        chapters.append(Chapter(block[0][1].strip()[:120], block[0][0], block[-1][0], text))
    return [c for c in chapters if c.text]


def _whole(pages: list[str]) -> list[Chapter]:
    text = "\n".join(pages).strip()
    return [Chapter("Document", 1, len(pages), text)] if text else []


def _cap(chapters: list[Chapter], max_words: int) -> list[Chapter]:
    out = []
    for c in chapters:
        words = c.text.split()
        if len(words) <= max_words:
            out.append(c)
            continue
        parts = -(-len(words) // max_words)
        size = -(-len(words) // parts)
        for k in range(parts):
            out.append(Chapter(f"{c.title} (part {k + 1}/{parts})", c.page_from, c.page_to,
                               " ".join(words[k * size:(k + 1) * size])))
    return out
```

- [ ] **Step 5: Verifica che passi**

Run: `cd apps/worker && python -m pytest tests/test_text.py -q`
Expected: PASS, 9 test. Se `inspect_pdf(b"%PDF-1.4 garbage")` non solleva eccezioni perché PyMuPDF ripara il file e lo apre con 0 pagine, aggiungi in `inspect_pdf` il controllo `if doc.page_count == 0: raise ValueError("PDF has no pages")`.

- [ ] **Step 6: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): python package with PDF extraction and chapter splitting"
```

---

### Task 10: Worker — controlli, preset, client LLM, pipeline di riassunto e docx

**Files:**
- Create: `apps/worker/summarize_worker/checks.py`, `prompts.py`, `llm.py`, `pipeline.py`, `docx.py`
- Create: `apps/worker/summarize_worker/presets/studio.md`, `presets/schematico.md`, `presets/abstract.md`
- Test: `apps/worker/tests/test_checks.py`, `tests/test_prompts.py`, `tests/test_pipeline.py`

**Interfaces:**
- Consumes: `Chapter` (Task 9). Porta `normalizza`, `controlli`, `sistema_formato`, `chiama_modello`, `ISTRUZIONI_VERIFICA`, `riassumi_con_istruzioni` e `salva_docx` da `legacy/riassumi_libro.py`.
- Produces:
  - in `checks.py`: `normalize(text)`, `run_checks(summary, original, fraction=3) -> list[str]` e `fix_format(text, header: str | None) -> str`;
  - in `prompts.py`: `PRESETS`, `LANGUAGE_NAMES`, `FRACTION_NAMES`, `VERIFY_INSTRUCTIONS` e `render_instructions(preset, language, fraction) -> str`;
  - in `llm.py`: `Usage(input_tokens=0, output_tokens=0)`, `make_client(base_url, api_key)` (con `"fake"` restituisce un `FakeClient`), `FakeClient(replies: list[str] | None = None)` con l'attributo `.calls`, `DEFAULT_REPLY` e `call_model(client, model, prompt, *, system="", max_tokens=32000, attempts=5, on_tokens=None, usage=None) -> str`;
  - in `pipeline.py`: `summarize_chapters(client, model, chapters, instructions, *, fraction, bibliographic_line, verify=True, on_progress=None, usage=None) -> tuple[str, list[str]]`, dove `on_progress(percent: int, phase: str)` riceve percent tra 0 e 99 e phase del tipo `"Chapter 1/2: draft"` o `"Chapter 1/2: fact-check"`;
  - in `docx.py`: `to_docx(markdown) -> bytes`.

- [ ] **Step 1: Scrivi i test che falliscono**

`apps/worker/tests/test_checks.py` (porta di `legacy/test_controlli.py`):

```python
from summarize_worker.checks import fix_format, run_checks

ORIGINAL = "The EU is highly uni- ﬁed and “confederal” rather than federal. " * 40


def test_verbatim_quote_passes_only_length_flagged():
    ok = 'The EU is "highly unified and “confederal”" in structure.'
    assert [p.split()[0] for p in run_checks(ok, ORIGINAL)] == ["length"]


def test_invented_quote_and_leftover_brackets_are_flagged():
    problems = run_checks('A "wrong winner" case [Yale].', ORIGINAL)
    assert any("wrong winner" in p for p in problems) and any("[Yale]" in p for p in problems)


def test_fix_format_header_and_spacing():
    draft = "# Title\n**[Author]** – in [x], pp. [1]\n---\n## Intro  \ntext"
    assert fix_format(draft, "**A** – *B*, pp. 9–29") == "# Title\n\n**A** – *B*, pp. 9–29\n\n---\n\n## Intro\n\ntext"


def test_page_header_and_split_ligature_do_not_break_quotes():
    pdf = "Switzerland “most clearly typiﬁ es the traits characteristic of liberal \nCONSENSUS MODEL OF DEMOCRACY  45\ncorporatism.” " * 50
    assert not any("quote" in p for p in run_checks('It "most clearly typifies the traits characteristic of **liberal corporatism**."', pdf))
    assert any("quote" in p for p in run_checks('It "clearly embodies a wholly different model of pluralist politics".', pdf))


def test_mixed_quote_styles_are_not_paired():
    mixed = 'A "most clearly typifies the traits" claim and then “democratic drift” here.'
    assert not any("quote" in p for p in run_checks(mixed, "most clearly typifies the traits and democratic drift " * 60))


def test_all_caps_heading_becomes_title_case():
    assert fix_format("# THE CONSEQUENCES OF DEMOCRATIZATION\n## Introduction\ntext", None) == \
        "# The Consequences of Democratization\n\n## Introduction\n\ntext"


def test_length_target_follows_fraction():
    original = "word " * 1000
    assert run_checks("x " * 200, original, fraction=5) == []
    assert [p.split()[0] for p in run_checks("x " * 200, original, fraction=3)] == ["length"]
```

`apps/worker/tests/test_prompts.py`:

```python
import pytest

from summarize_worker.prompts import PRESETS, render_instructions


@pytest.mark.parametrize("preset", PRESETS)
def test_every_preset_renders_without_placeholders(preset):
    text = render_instructions(preset, "it", 5)
    assert "{" not in text and "}" not in text
    assert "Italian" in text and "one fifth" in text


def test_auto_language_follows_the_reading():
    assert "the same language as the reading" in render_instructions("studio", "auto", 3)


def test_unknown_values_are_rejected():
    with pytest.raises(ValueError):
        render_instructions("poem", "en", 3)
    with pytest.raises(KeyError):
        render_instructions("studio", "xx", 3)
```

`apps/worker/tests/test_pipeline.py`:

```python
import zipfile
from io import BytesIO

from summarize_worker.docx import to_docx
from summarize_worker.llm import DEFAULT_REPLY, FakeClient, Usage, make_client
from summarize_worker.pipeline import summarize_chapters
from summarize_worker.text import Chapter


def test_each_chapter_gets_a_draft_and_a_fact_check():
    client, progress, usage = FakeClient(), [], Usage()
    chapters = [Chapter("A", 9, 29, "alpha " * 300), Chapter("B", 30, 30, "beta " * 300)]
    md, warnings = summarize_chapters(client, "m", chapters, "SYSTEM", fraction=3,
                                      bibliographic_line="**Lijphart** – *Patterns*",
                                      on_progress=lambda p, ph: progress.append((p, ph)), usage=usage)
    assert len(client.calls) == 4
    assert client.calls[0][0] == {"role": "system", "content": "SYSTEM"}
    assert "about 100 words (one third of the original)" in client.calls[0][1]["content"]
    assert "ORIGINAL TEXT:" in client.calls[1][1]["content"]
    assert "**Lijphart** – *Patterns*, pp. 9–29" in md and "**Lijphart** – *Patterns*, p. 30" in md
    assert md.count("# Fake Summary") == 2 and "\n\n---\n\n" in md
    assert (usage.input_tokens, usage.output_tokens) == (400, 200)
    percents = [p for p, _ in progress]
    assert percents == sorted(percents) and all(0 <= p < 100 for p in percents)
    assert any(ph == "Chapter 2/2: fact-check" for _, ph in progress)
    assert all(w.startswith("chapter ") for w in warnings)


def test_a_too_short_fact_check_keeps_the_draft():
    client = FakeClient(replies=[DEFAULT_REPLY, "Sorry, I cannot help."])
    md, _ = summarize_chapters(client, "m", [Chapter("A", None, None, "alpha " * 300)], "S",
                               fraction=3, bibliographic_line="**A** – *B*")
    assert "Fake Summary" in md and "Sorry" not in md
    assert "**A** – *B*\n" in md  # no page range known


def test_fake_client_is_selected_by_base_url():
    assert isinstance(make_client("fake", ""), FakeClient)


def test_docx_has_real_headings():
    data = to_docx("# Title\n## Part\ntext")
    assert data[:2] == b"PK"
    xml = zipfile.ZipFile(BytesIO(data)).read("word/document.xml")
    assert b"Heading1" in xml and b"Heading2" in xml
```

- [ ] **Step 2: Verifica che falliscano**

Run: `cd apps/worker && python -m pytest -q`
Expected: FAIL con "ModuleNotFoundError: No module named 'summarize_worker.checks'".

- [ ] **Step 3: Implementa `checks.py`**

`apps/worker/summarize_worker/checks.py` porta la logica di `legacy/riassumi_libro.py` senza cambiarla, salvo i nomi, i messaggi in inglese e il parametro `fraction`:

```python
"""Model-free checks and formatting (ported unchanged in logic from legacy/riassumi_libro.py)."""
import re

SMALL_WORDS = {"a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "vs"}


def normalize(text: str) -> str:
    # PDF text for comparisons: ligatures, hyphenated line breaks, quotes, whitespace.
    text = text.replace("ﬁ", "fi").replace("ﬂ", "fl").replace("ﬀ", "ff")
    text = re.sub(r"(\w)-\s+(\w)", r"\1\2", text)
    text = text.translate(str.maketrans("“”‘’–—", "\"\"''--"))
    return re.sub(r"\s+", " ", text).lower()


def _letters(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", normalize(s))


def run_checks(summary: str, original: str, fraction: int = 3) -> list[str]:
    """Quotes not found in the original, leftover [placeholders], length off target. Never blocks delivery."""
    problems = []
    # running headers like "CONSENSUS MODEL OF DEMOCRACY  45" split quotes across pages: drop them first
    original = re.sub(r"^(?:\d+\s+)?[A-Z][A-Z ,:;'’\-–]{3,}(?:\s+\d+)?\s*$", " ", original, flags=re.M)
    source = _letters(original)
    # curly and straight quotes are matched separately: mixing them pairs one style's opening with the other's closing
    quotes = re.findall(r"“([^“”\n]{8,400}?)”", summary) + re.findall(r"\"([^\"\n]{8,400}?)\"", summary)
    for quote in quotes:
        # ponytail: 5-word chunks, letters only; tolerates page breaks, split ligatures and [editorial] inserts.
        # 80% threshold: a near-verbatim paraphrase can slip through.
        words = re.sub(r"\*\*|[\[\]]", " ", quote).split()
        chunks = [c for c in (_letters(" ".join(words[j:j + 5])) for j in range(0, len(words), 5)) if c]
        if chunks and sum(c in source for c in chunks) < 0.8 * len(chunks):
            problems.append(f"quote not found in the text: \"{quote}\"")
    outside_quotes = re.sub(r"“[^“”\n]*”|\"[^\"\n]*\"", "", summary)  # [..] inside quotes are legitimate inserts
    for leftover in re.findall(r"\[[^\]]*\]", outside_quotes):
        problems.append(f"square brackets left: {leftover}")
    words, target = len(summary.split()), len(original.split()) // fraction
    if not 0.75 * target <= words <= 1.25 * target:
        problems.append(f"length {words} words, target ~{target}")
    return problems


def fix_format(text: str, header: str | None) -> str:
    text = re.sub(r"\n*^---[ \t]*$\n*", "\n\n---\n\n", text, flags=re.M)  # avoid setext headings
    text = re.sub(r"[ \t]+$", "", text, flags=re.M)
    text = re.sub(r"\n*^(#{1,6} .*)$\n*", r"\n\n\1\n\n", text, flags=re.M)  # pandoc needs blank lines around headings

    def title_case(m):  # ALL CAPS headings copied from the PDF -> Title Case
        words = m.group(2).lower().split()
        return m.group(1) + " ".join(w if j and w in SMALL_WORDS else w[:1].upper() + w[1:] for j, w in enumerate(words))

    text = re.sub(r"^(#{1,6} )([^a-z\n]*[A-Z]{3}[^a-z\n]*)$", title_case, text, flags=re.M)
    text = re.sub(r"\n{3,}", "\n\n", text)
    if header:  # the bibliographic line is imposed, not guessed by the model
        text = re.sub(r"^\*\*.*$", lambda _: header, text, count=1, flags=re.M)
    return text.strip()
```

- [ ] **Step 4: Implementa i preset e `prompts.py`**

`apps/worker/summarize_worker/presets/studio.md` è `legacy/istruzioni_esame.md` generalizzato. Le uniche differenze: la prima frase non cita più VUB e l'esame, e compaiono `{language}` e `{fraction}`:

```markdown
You are writing study summaries for a university student preparing an exam. The user message contains the full text of ONE chapter/article. Output ONLY the summary in Markdown, nothing else.

WHAT TO PRODUCE
- A real summary, not a transcription: rework and synthesize the text to about {fraction} of the original length, while staying detailed enough for a university exam.
- Language: {language}.
- Discursive form in continuous paragraphs. NO bullet points, NO numbered lists, NO tables.

STRUCTURE (always follow this schema exactly)
# [Chapter/article number and title]
**[Author]** – in [editor/journal], *[volume title]*, [publisher], pp. [xx–xx]
---
## Introduction
One paragraph with the thesis and central themes of the reading.
---
## [Section 1 with the original title]
### [Any subsections with the original titles]
Discursive paragraphs: usually one per main idea or concept.
---
## [Following sections, in the same order as the text]
---
## Conclusion
One paragraph with the author's conclusions or final perspectives.

CONTENT RULES
- Keep the original section titles and their order.
- Use the author's terminology and key expressions and put them in **bold** (concepts, typologies, definitions, important proper names).
- Always include: the central thesis, definitions, typologies and classifications, conceptual distinctions, cited authors with year (e.g. Linz 1970) and their theories, and the most representative examples.
- If the text contains a typology or a figure, describe it in a short paragraph at the start of the section where it appears.
- Integrate boxes and key points into the text of the corresponding section, concisely, without separate boxes. You may close a section with a sentence recapping the key points ("The key points of this section are...").
- Reduce or remove secondary examples, non-essential dates and minor historical details.
- Exclude end-of-chapter questions, bibliography, web links, indexes, footnotes, and country fact sheets that only contain data.
- Names, dates, numbers and quotations must match the original text exactly. Never invent facts or citations.
- Quotation marks may only enclose words that appear verbatim in the original text. Never put paraphrases or labels of your own in quotation marks.
- Write section headings in title case, with the same wording as the original (not ALL CAPS).
- When the author numbers elements (e.g. "1. Concentration of executive power..."), keep exactly the author's numbering and grouping (e.g. "6–10." if the author groups them).
- If the user message gives a bibliographic line, copy it exactly, with no square brackets and no changes.
```

`apps/worker/summarize_worker/presets/schematico.md`:

```markdown
You are writing structured study notes for a university student preparing an exam. The user message contains the full text of ONE chapter/article. Output ONLY the notes in Markdown, nothing else.

WHAT TO PRODUCE
- Structured notes at about {fraction} of the original length, detailed enough for a university exam.
- Language: {language}.
- Short bullet points grouped under headings, one idea per bullet. Sub-bullets are allowed for examples. NO tables.

STRUCTURE (always follow this schema exactly)
# [Chapter/article number and title]
**[Author]** – in [editor/journal], *[volume title]*, [publisher], pp. [xx–xx]
---
## Key Idea
One or two sentences with the thesis of the reading.
---
## [Section 1 with the original title]
- Bullet points with the concepts of the section.
---
## [Following sections, in the same order as the text]
---
## Takeaways
- Three to six bullets with what to remember for the exam.

CONTENT RULES
- Keep the original section titles and their order.
- Put the author's key terms in **bold** (concepts, typologies, definitions, important proper names).
- Always include: the central thesis, definitions, typologies and classifications, conceptual distinctions, cited authors with year (e.g. Linz 1970) and the most representative examples.
- Exclude end-of-chapter questions, bibliography, web links, indexes and footnotes.
- Names, dates, numbers and quotations must match the original text exactly. Never invent facts or citations.
- Quotation marks may only enclose words that appear verbatim in the original text.
- Write section headings in title case, with the same wording as the original (not ALL CAPS).
- If the user message gives a bibliographic line, copy it exactly, with no square brackets and no changes.
```

`apps/worker/summarize_worker/presets/abstract.md`:

```markdown
You are writing an abstract of ONE chapter/article for a university student. The user message contains the full text. Output ONLY the abstract in Markdown, nothing else.

WHAT TO PRODUCE
- A compact abstract at about {fraction} of the original length.
- Language: {language}.
- One to four paragraphs of continuous prose covering the thesis, the argument, the main evidence and the conclusion. NO headings other than the title, NO bullet points, NO tables.

STRUCTURE (always follow this schema exactly)
# [Chapter/article number and title]
**[Author]** – in [editor/journal], *[volume title]*, [publisher], pp. [xx–xx]
---
[The abstract paragraphs]

CONTENT RULES
- Put the author's key terms in **bold**.
- Names, dates, numbers and quotations must match the original text exactly. Never invent facts or citations.
- Quotation marks may only enclose words that appear verbatim in the original text.
- If the user message gives a bibliographic line, copy it exactly, with no square brackets and no changes.
```

`apps/worker/summarize_worker/prompts.py`:

```python
from importlib.resources import files

# Must match apps/api/src/jobs/options.ts
PRESETS = ("studio", "schematico", "abstract")
LANGUAGE_NAMES = {"en": "English", "it": "Italian", "nl": "Dutch", "fr": "French", "de": "German", "es": "Spanish"}
FRACTION_NAMES = {3: "one third", 5: "one fifth", 10: "one tenth"}

VERIFY_INSTRUCTIONS = """You are a meticulous fact-checker. The user message contains the ORIGINAL TEXT of a reading and a DRAFT SUMMARY of it.
Return the corrected summary in Markdown, and NOTHING else (no comments, no list of changes).
- Check every name, year, number, percentage, seat count, date, citation (Author year) and quotation against the original; fix wrong ones.
- Delete any claim, term or quotation that is not supported by the original (invented facts, content only found in footnotes).
- Quotation marks may only enclose words that appear verbatim in the original.
- Check that attributions are correct (who said what, which year) and that comparisons are not reversed.
- Keep the language, structure, headings, bold terms, length and style unchanged: correct, do not rewrite."""


def render_instructions(preset: str, language: str, fraction: int) -> str:
    if preset not in PRESETS:
        raise ValueError(f"unknown preset {preset!r}")
    template = files("summarize_worker").joinpath(f"presets/{preset}.md").read_text(encoding="utf-8")
    language_text = "the same language as the reading" if language == "auto" else LANGUAGE_NAMES[language]
    return template.replace("{language}", language_text).replace("{fraction}", FRACTION_NAMES[fraction])
```

- [ ] **Step 5: Implementa `llm.py`**

`apps/worker/summarize_worker/llm.py`:

```python
"""OpenAI-compatible streaming client (NVIDIA in dev, Anthropic's OpenAI-compatible endpoint in prod)."""
import time
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Callable

DEFAULT_REPLY = ("# Fake Summary\n\n**Fake Author** – Fake Source\n\n---\n\n## Introduction\n\n"
                 + "This is a generated test summary. " * 20 + "\n\n---\n\n## Conclusion\n\nEnd.")


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0


class FakeClient:
    """LLM stand-in for tests and local e2e (LLM_BASE_URL=fake). Replies in order, then DEFAULT_REPLY."""

    def __init__(self, replies: list[str] | None = None):
        self.replies = list(replies or [])
        self.calls: list[list[dict]] = []
        self.chat = self
        self.completions = self

    def create(self, *, messages, **_):
        self.calls.append(messages)
        text = self.replies.pop(0) if self.replies else DEFAULT_REPLY
        return iter([
            SimpleNamespace(usage=None, choices=[SimpleNamespace(delta=SimpleNamespace(content=text), finish_reason="stop")]),
            SimpleNamespace(usage=SimpleNamespace(prompt_tokens=100, completion_tokens=50), choices=[]),
        ])


def make_client(base_url: str, api_key: str):
    if base_url == "fake":
        return FakeClient()
    from openai import OpenAI
    # 300 s timeout keeps a stalled stream well inside the 10-minute heartbeat window
    return OpenAI(base_url=base_url, api_key=api_key, timeout=300)


def call_model(client, model: str, prompt: str, *, system: str = "", max_tokens: int = 32000, attempts: int = 5,
               on_tokens: Callable[[int], None] | None = None, usage: Usage | None = None) -> str:
    """Streams one completion. on_tokens(words_written) fires about every 2 s (also while the model reasons)."""
    messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}]
    for attempt in range(attempts):
        try:
            stream = client.chat.completions.create(model=model, messages=messages, max_tokens=max_tokens,
                                                    temperature=0.4, stream=True,
                                                    stream_options={"include_usage": True})
            parts, last, final_usage = [], 0.0, None
            for event in stream:
                if on_tokens and time.time() - last > 2:
                    on_tokens(len("".join(parts).split()))
                    last = time.time()
                if getattr(event, "usage", None):
                    final_usage = event.usage
                if not event.choices:
                    continue
                choice = event.choices[0]
                if choice.delta.content:
                    parts.append(choice.delta.content)
                if choice.finish_reason == "length":
                    print(f"warning: output truncated at max_tokens={max_tokens}")
            if usage is not None and final_usage is not None:
                usage.input_tokens += final_usage.prompt_tokens or 0
                usage.output_tokens += final_usage.completion_tokens or 0
            return "".join(parts).strip()
        except Exception as e:
            if attempt == attempts - 1:
                raise
            wait = 2 ** attempt
            print(f"LLM error ({e}); retrying in {wait}s")
            time.sleep(wait)
    raise RuntimeError("unreachable")
```

- [ ] **Step 6: Implementa `pipeline.py` e `docx.py`**

`apps/worker/summarize_worker/pipeline.py`:

```python
"""Draft -> fact-check -> format -> checks, one chapter at a time (from legacy riassumi_con_istruzioni)."""
from typing import Callable

from .checks import fix_format, run_checks
from .llm import Usage, call_model
from .prompts import FRACTION_NAMES, VERIFY_INSTRUCTIONS
from .text import Chapter


def _header(line: str | None, chapter: Chapter) -> str | None:
    if not line:
        return None
    if not chapter.page_from:
        return line
    if chapter.page_from == chapter.page_to:
        return f"{line}, p. {chapter.page_from}"
    return f"{line}, pp. {chapter.page_from}–{chapter.page_to}"


def summarize_chapters(client, model: str, chapters: list[Chapter], instructions: str, *, fraction: int,
                       bibliographic_line: str | None, verify: bool = True,
                       on_progress: Callable[[int, str], None] | None = None,
                       usage: Usage | None = None) -> tuple[str, list[str]]:
    """Returns the whole Markdown and the check warnings. on_progress(percent 0-99, phase)."""
    phases = 2 if verify else 1
    steps = len(chapters) * phases
    summaries, warnings = [], []

    def progress(step: int, phase: str, expected_words: int):
        # ponytail: estimated from words written vs expected; reasoning time is not measurable
        def update(written: int):
            if on_progress:
                share = min(written / max(expected_words, 1), 0.99)
                on_progress(int((step + share) / steps * 100), phase)
        return update

    for i, chapter in enumerate(chapters):
        label = f"Chapter {i + 1}/{len(chapters)}"
        header = _header(bibliographic_line, chapter)
        target = chapter.words // fraction
        prompt = f"Target length: about {target} words ({FRACTION_NAMES[fraction]} of the original).\n\n"
        if header:
            prompt += f"Use exactly this bibliographic line under the title:\n{header}\n\n"
        prompt += f"Reading to summarize:\n\n{chapter.text}"
        step = i * phases
        text = fix_format(call_model(client, model, prompt, system=instructions, usage=usage,
                                     on_tokens=progress(step, f"{label}: draft", target)), header)
        if verify:
            checked = call_model(client, model,
                                 f"ORIGINAL TEXT:\n\n{chapter.text}\n\n=====\n\nDRAFT SUMMARY:\n\n{text}",
                                 system=VERIFY_INSTRUCTIONS, usage=usage,
                                 on_tokens=progress(step + 1, f"{label}: fact-check", len(text.split())))
            # ponytail: a much shorter answer is a refusal or a truncation, so the draft is kept
            if len(checked.split()) > 0.7 * len(text.split()):
                text = fix_format(checked, header)
        warnings += [f"chapter {i + 1}: {w}" for w in run_checks(text, chapter.text, fraction)]
        summaries.append(text)
    return "\n\n---\n\n".join(summaries) + "\n", warnings
```

`apps/worker/summarize_worker/docx.py`:

```python
import tempfile
from pathlib import Path

from .checks import fix_format


def to_docx(markdown: str) -> bytes:
    """Word file for Google Docs import (pandoc bundled by pypandoc_binary)."""
    import pypandoc
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "summary.docx"
        pypandoc.convert_text(fix_format(markdown, None), "docx", format="markdown", outputfile=str(out))
        return out.read_bytes()
```

- [ ] **Step 7: Verifica che passino**

Run: `cd apps/worker && python -m pytest -q`
Expected: PASS, tutti i test di `test_text.py`, `test_checks.py`, `test_prompts.py` e `test_pipeline.py`.

- [ ] **Step 8: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): checks, presets, streaming LLM client, summary pipeline, docx export"
```

---

### Task 11: Worker — coda Postgres, storage, handler, retry e recupero dei job orfani

**Files:**
- Create: `apps/worker/summarize_worker/config.py`, `db.py`, `storage.py`, `handlers.py`, `__main__.py`
- Test: `apps/worker/tests/conftest.py`, `apps/worker/tests/test_runtime.py`

**Interfaces:**
- Consumes:
  - Task 9: `inspect_pdf`, `extract_pages`, `clean_pages`, `split_chapters`;
  - Task 10: `render_instructions`, `summarize_chapters`, `Usage`, `make_client`, `FakeClient`, `to_docx`;
  - lo schema del Task 2.
- Produces:
  - `Settings.from_env()`;
  - `Storage(settings)` con `.get(key) -> bytes`, `.put(key, body, content_type)` e `.size(key) -> int`;
  - in `db.py`: `claim(conn, kind) -> dict | None`, `progress(conn, job_id, percent, phase)`, `get_document(conn, id)`, `finish_analyze(...)`, `reject_document(conn, job, reason)`, `finish_summary(...)`, `fail_or_retry(conn, job)`, `recover_stale(conn, stale_after="10 minutes") -> int` e le costanti `MAX_ATTEMPTS = 2`, `SUMMARY_ERROR` e `ANALYZE_ERROR`;
  - in `handlers.py`: `process(conn, storage, settings, client, job)` e i motivi di rifiuto (vedi sotto);
  - l'entrypoint `python -m summarize_worker`, con due thread: `analyze` e `summarize`.
- Motivi di rifiuto, testi esatti mostrati all'utente:
  - `"Not a PDF file"`;
  - `"File larger than 50 MB"`;
  - `"Not a readable PDF file"`;
  - `"Password-protected PDF"`;
  - `"More than 400 pages"`;
  - `"No text found in the PDF, even with OCR"`.

- [ ] **Step 1: Scrivi il test che fallisce**

`apps/worker/tests/conftest.py`:

```python
import os
import subprocess

import psycopg
import pytest
from psycopg.rows import dict_row

from summarize_worker.config import Settings
from summarize_worker.storage import Storage

TEST_DB = "postgresql://summarize:summarize@localhost:5432/summarize_test_worker"


@pytest.fixture(scope="session")
def migrated():
    subprocess.run("pnpm --filter @summarize/db exec prisma migrate reset --force --skip-seed --skip-generate",
                   shell=True, check=True, env={**os.environ, "DATABASE_URL": TEST_DB})


@pytest.fixture
def settings():
    return Settings(database_url=TEST_DB, s3_endpoint="http://localhost:9000", s3_region="us-east-1",
                    s3_bucket="summarize-test", s3_key="summarize", s3_secret="summarize-secret",
                    llm_base_url="fake", llm_api_key="", llm_model="fake", ocr_langs=None)


@pytest.fixture
def conn(migrated, settings):
    c = psycopg.connect(settings.database_url, autocommit=True, row_factory=dict_row)
    c.execute('TRUNCATE "CreditLedger", "Job", "Document", "Session", "AuthAccount", "MagicLinkToken", "User" CASCADE')
    yield c
    c.close()


@pytest.fixture
def storage(settings):
    return Storage(settings)
```

`apps/worker/tests/test_runtime.py`:

```python
from uuid import uuid4

import fitz
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from summarize_worker import db
from summarize_worker.handlers import process
from summarize_worker.llm import FakeClient
from tests.pdfs import make_pdf

OPTIONS = {"language": "auto", "fraction": 3, "preset": "studio"}
TEXT_PDF = make_pdf(["Chapter 1 Origins\n" + "Democracy shares power. " * 30,
                     "Chapter 2 Growth\n" + "Consensus spreads power. " * 30])


class BrokenClient:
    def __init__(self):
        self.chat = self
        self.completions = self

    def create(self, **_):
        raise RuntimeError("LLM down")


def seed(conn, storage, pdf: bytes, *, kind="analyze", doc_status="uploaded", credits=0, attempts=0):
    user = conn.execute('INSERT INTO "User" (email) VALUES (%s) RETURNING id', (f"{uuid4().hex}@x.com",)).fetchone()["id"]
    doc_id = uuid4()
    key = f"users/{user}/documents/{doc_id}.pdf"
    storage.put(key, pdf, "application/pdf")
    conn.execute('INSERT INTO "Document" (id, "userId", "s3Key", filename, "sizeBytes", status) '
                 'VALUES (%s, %s, %s, %s, %s, %s::"DocumentStatus")', (doc_id, user, key, "t.pdf", len(pdf), doc_status))
    job_id = conn.execute('INSERT INTO "Job" ("userId", "documentId", kind, options, credits, attempts) '
                          'VALUES (%s, %s, %s::"JobKind", %s, %s, %s) RETURNING id',
                          (user, doc_id, kind, Jsonb(OPTIONS if kind == "summarize" else {}), credits, attempts)).fetchone()["id"]
    if credits:
        conn.execute("""INSERT INTO "CreditLedger" ("userId", type, amount) VALUES (%s, 'grant', %s)""", (user, credits))
        conn.execute("""INSERT INTO "CreditLedger" ("userId", type, amount, "jobId") VALUES (%s, 'reserve', %s, %s)""",
                     (user, -credits, job_id))
    return user, doc_id, job_id


def job(conn, job_id):
    return conn.execute('SELECT * FROM "Job" WHERE id = %s', (job_id,)).fetchone()


def document(conn, doc_id):
    return conn.execute('SELECT * FROM "Document" WHERE id = %s', (doc_id,)).fetchone()


def balance(conn, user):
    return conn.execute('SELECT COALESCE(SUM(amount), 0) AS b FROM "CreditLedger" WHERE "userId" = %s', (user,)).fetchone()["b"]


def run_one(conn, storage, settings, kind, client=None):
    process(conn, storage, settings, client or FakeClient(), db.claim(conn, kind))


def test_claim_takes_each_job_once(conn, storage, settings):
    seed(conn, storage, TEXT_PDF)
    other = psycopg.connect(settings.database_url, autocommit=True, row_factory=dict_row)
    assert db.claim(conn, "analyze")["status"] == "running"
    assert db.claim(other, "analyze") is None
    assert db.claim(conn, "summarize") is None
    other.close()


def test_analyze_stores_words_and_chapters(conn, storage, settings):
    _, doc_id, job_id = seed(conn, storage, TEXT_PDF)
    run_one(conn, storage, settings, "analyze")
    doc = document(conn, doc_id)
    assert doc["status"] == "analyzed" and doc["pages"] == 2 and doc["words"] > 100
    assert [c["title"] for c in doc["chapters"]] == ["Chapter 1 Origins", "Chapter 2 Growth"]
    assert job(conn, job_id)["status"] == "done"


def test_analyze_rejects_bad_files(conn, storage, settings):
    cases = {
        b"hello, not a pdf": "Not a PDF file",
        make_pdf(["", ""]): "No text found in the PDF, even with OCR",
        make_pdf(["secret"], encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="o", user_pw="u"): "Password-protected PDF",
        make_pdf(["x"] * 401): "More than 400 pages",
    }
    for pdf, reason in cases.items():
        user, doc_id, job_id = seed(conn, storage, pdf)
        run_one(conn, storage, settings, "analyze")
        assert (document(conn, doc_id)["status"], document(conn, doc_id)["rejectReason"]) == ("rejected", reason)
        assert job(conn, job_id)["status"] == "done"
        assert balance(conn, user) == 0


def test_summary_is_uploaded_and_charged(conn, storage, settings):
    user, _, job_id = seed(conn, storage, TEXT_PDF, kind="summarize", doc_status="analyzed", credits=3)
    run_one(conn, storage, settings, "summarize")
    row = job(conn, job_id)
    assert (row["status"], row["progress"], row["phase"]) == ("done", 100, "done")
    assert row["inputTokens"] > 0 and row["outputTokens"] > 0
    assert storage.get(row["resultMdKey"]).startswith(b"# ")
    assert storage.get(row["resultDocxKey"])[:2] == b"PK"
    types = sorted(r["type"] for r in conn.execute('SELECT type FROM "CreditLedger" WHERE "userId" = %s', (user,)))
    assert types == ["charge", "grant", "reserve"]
    assert balance(conn, user) == 0


def test_finishing_twice_charges_once(conn, storage, settings):
    user, _, job_id = seed(conn, storage, TEXT_PDF, kind="summarize", doc_status="analyzed", credits=3)
    claimed = db.claim(conn, "summarize")
    for _ in range(2):
        db.finish_summary(conn, claimed, md_key="a.md", docx_key="a.docx", warnings=[], input_tokens=1, output_tokens=1)
    charges = conn.execute("""SELECT count(*) AS n FROM "CreditLedger" WHERE "jobId" = %s AND type = 'charge'""", (job_id,)).fetchone()
    assert charges["n"] == 1


def test_failed_summary_retries_once_then_refunds(conn, storage, settings, monkeypatch):
    monkeypatch.setattr("time.sleep", lambda _: None)
    user, _, job_id = seed(conn, storage, TEXT_PDF, kind="summarize", doc_status="analyzed", credits=3)
    run_one(conn, storage, settings, "summarize", BrokenClient())
    assert job(conn, job_id)["status"] == "queued"
    run_one(conn, storage, settings, "summarize", BrokenClient())
    row = job(conn, job_id)
    assert (row["status"], row["error"]) == ("failed", db.SUMMARY_ERROR)
    assert balance(conn, user) == 3


def test_stale_jobs_are_requeued_or_refunded(conn, storage, settings):
    _, _, retry_id = seed(conn, storage, TEXT_PDF, kind="summarize", doc_status="analyzed", credits=2, attempts=1)
    user_b, _, dead_id = seed(conn, storage, TEXT_PDF, kind="summarize", doc_status="analyzed", credits=2, attempts=2)
    conn.execute("""UPDATE "Job" SET status = 'running', "heartbeatAt" = now() - interval '20 minutes'""")
    assert db.recover_stale(conn) == 2
    assert job(conn, retry_id)["status"] == "queued"
    assert job(conn, dead_id)["status"] == "failed" and balance(conn, user_b) == 2


def test_fresh_running_jobs_are_left_alone(conn, storage, settings):
    _, _, job_id = seed(conn, storage, TEXT_PDF, kind="summarize", doc_status="analyzed", credits=2)
    db.claim(conn, "summarize")
    assert db.recover_stale(conn) == 0
    assert job(conn, job_id)["status"] == "running"
```

- [ ] **Step 2: Verifica che fallisca**

Run: `cd apps/worker && python -m pytest tests/test_runtime.py -q`
Expected: FAIL con "ModuleNotFoundError: No module named 'summarize_worker.config'".

- [ ] **Step 3: Implementa `config.py` e `storage.py`**

`apps/worker/summarize_worker/config.py`:

```python
import os
from dataclasses import dataclass
from pathlib import Path

ROOT_ENV = Path(__file__).resolve().parents[3] / ".env"  # repo root in development; absent in production


def load_env(path: Path) -> None:
    # ponytail: same minimal KEY=value parser as the legacy CLI; never overrides variables already set
    for line in path.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.partition("=")
        if sep and not key.strip().startswith("#"):
            os.environ.setdefault(key.strip(), value.strip().strip('"\''))


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
        )
```

`apps/worker/summarize_worker/storage.py`:

```python
import boto3
from botocore.config import Config

from .config import Settings


class Storage:
    def __init__(self, settings: Settings):
        self.bucket = settings.s3_bucket
        self.s3 = boto3.client("s3", endpoint_url=settings.s3_endpoint, region_name=settings.s3_region,
                               aws_access_key_id=settings.s3_key, aws_secret_access_key=settings.s3_secret,
                               config=Config(s3={"addressing_style": "path"}))

    def get(self, key: str) -> bytes:
        return self.s3.get_object(Bucket=self.bucket, Key=key)["Body"].read()

    def put(self, key: str, body: bytes, content_type: str) -> None:
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=body, ContentType=content_type)

    def size(self, key: str) -> int:
        return self.s3.head_object(Bucket=self.bucket, Key=key)["ContentLength"]
```

- [ ] **Step 4: Implementa `db.py`**

`apps/worker/summarize_worker/db.py`:

```python
"""Job queue on the Prisma-owned schema. Identifiers are quoted: Prisma keeps PascalCase/camelCase names."""
from psycopg.types.json import Jsonb

MAX_ATTEMPTS = 2
SUMMARY_ERROR = "Summary generation failed. Your credits have been refunded."
ANALYZE_ERROR = "Could not read this PDF."


def claim(conn, kind: str) -> dict | None:
    return conn.execute(
        """UPDATE "Job" SET status = 'running', attempts = attempts + 1, "heartbeatAt" = now(), phase = 'starting'
           WHERE id = (SELECT id FROM "Job" WHERE status = 'queued' AND kind = %s::"JobKind"
                       ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1)
           RETURNING *""", (kind,)).fetchone()


def progress(conn, job_id, percent: int, phase: str) -> None:
    conn.execute("""UPDATE "Job" SET progress = %s, phase = %s, "heartbeatAt" = now()
                    WHERE id = %s AND status = 'running'""", (percent, phase, job_id))


def get_document(conn, doc_id) -> dict:
    return conn.execute('SELECT * FROM "Document" WHERE id = %s', (doc_id,)).fetchone()


def _done(conn, job_id, phase: str = "done") -> None:
    conn.execute("""UPDATE "Job" SET status = 'done', progress = 100, phase = %s, "finishedAt" = now()
                    WHERE id = %s AND status = 'running'""", (phase, job_id))


def finish_analyze(conn, job: dict, *, pages: int, words: int, used_ocr: bool, chapters: list[dict]) -> None:
    with conn.transaction():
        conn.execute("""UPDATE "Document" SET status = 'analyzed', pages = %s, words = %s, "usedOcr" = %s, chapters = %s
                        WHERE id = %s""", (pages, words, used_ocr, Jsonb(chapters), job["documentId"]))
        _done(conn, job["id"])


def reject_document(conn, job: dict, reason: str) -> None:
    with conn.transaction():
        conn.execute("""UPDATE "Document" SET status = 'rejected', "rejectReason" = %s WHERE id = %s""",
                     (reason, job["documentId"]))
        _done(conn, job["id"], phase="rejected")


def finish_summary(conn, job: dict, *, md_key: str, docx_key: str, warnings: list[str],
                   input_tokens: int, output_tokens: int) -> None:
    with conn.transaction():
        row = conn.execute(
            """UPDATE "Job" SET status = 'done', progress = 100, phase = 'done', "finishedAt" = now(),
                      "resultMdKey" = %s, "resultDocxKey" = %s, warnings = %s, "inputTokens" = %s, "outputTokens" = %s
               WHERE id = %s AND status = 'running' RETURNING id""",
            (md_key, docx_key, Jsonb(warnings), input_tokens, output_tokens, job["id"])).fetchone()
        if row:  # the unique (jobId, type) index makes a second charge impossible anyway
            conn.execute("""INSERT INTO "CreditLedger" ("userId", type, amount, "jobId")
                            VALUES (%s, 'charge', 0, %s) ON CONFLICT DO NOTHING""", (job["userId"], job["id"]))


def _fail(conn, job_id) -> None:
    row = conn.execute(
        """UPDATE "Job" SET status = 'failed', phase = 'failed', "finishedAt" = now(),
                  error = CASE WHEN kind = 'summarize' THEN %s ELSE %s END
           WHERE id = %s AND status IN ('running', 'queued')
           RETURNING id, "userId", "documentId", kind, credits""", (SUMMARY_ERROR, ANALYZE_ERROR, job_id)).fetchone()
    if not row:
        return
    if row["kind"] == "summarize" and row["credits"] > 0:
        conn.execute("""INSERT INTO "CreditLedger" ("userId", type, amount, "jobId")
                        VALUES (%s, 'refund', %s, %s) ON CONFLICT DO NOTHING""", (row["userId"], row["credits"], job_id))
    if row["kind"] == "analyze":
        conn.execute("""UPDATE "Document" SET status = 'rejected', "rejectReason" = %s
                        WHERE id = %s AND status = 'uploaded'""", (ANALYZE_ERROR, row["documentId"]))


def fail_or_retry(conn, job: dict) -> None:
    """After an exception: requeue while attempts remain, else fail (refunding summaries)."""
    with conn.transaction():
        if job["attempts"] < MAX_ATTEMPTS:
            conn.execute("""UPDATE "Job" SET status = 'queued', phase = 'retrying'
                            WHERE id = %s AND status = 'running'""", (job["id"],))
        else:
            _fail(conn, job["id"])


def recover_stale(conn, stale_after: str = "10 minutes") -> int:
    """Jobs whose worker died (no heartbeat): requeue or fail+refund. Returns how many were handled."""
    with conn.transaction():
        stale = conn.execute("""SELECT id, attempts FROM "Job"
                                WHERE status = 'running' AND "heartbeatAt" < now() - %s::interval
                                FOR UPDATE SKIP LOCKED""", (stale_after,)).fetchall()
        for row in stale:
            if row["attempts"] < MAX_ATTEMPTS:
                conn.execute("""UPDATE "Job" SET status = 'queued', phase = 'retrying' WHERE id = %s""", (row["id"],))
            else:
                _fail(conn, row["id"])
    return len(stale)
```

- [ ] **Step 5: Implementa `handlers.py` e `__main__.py`**

`apps/worker/summarize_worker/handlers.py`:

```python
import traceback

from . import db
from .docx import to_docx
from .llm import Usage
from .pipeline import summarize_chapters
from .prompts import render_instructions
from .text import Chapter, clean_pages, extract_pages, inspect_pdf, split_chapters

MAX_BYTES = 50 * 1024 * 1024
MAX_PAGES = 400
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


class Rejected(Exception):
    """The file itself is unusable; the message is shown to the user."""


def load_pdf(storage, doc: dict) -> bytes:
    if storage.size(doc["s3Key"]) > MAX_BYTES:
        raise Rejected("File larger than 50 MB")
    pdf = storage.get(doc["s3Key"])
    if not pdf.startswith(b"%PDF-"):
        raise Rejected("Not a PDF file")
    return pdf


def read_chapters(pdf: bytes, ocr_langs: str | None, on_page=None) -> tuple[list[Chapter], int, bool]:
    try:
        pages_count, needs_pass = inspect_pdf(pdf)
    except ValueError:
        raise Rejected("Not a readable PDF file")
    if needs_pass:
        raise Rejected("Password-protected PDF")
    if pages_count > MAX_PAGES:
        raise Rejected("More than 400 pages")
    pages, toc, used_ocr = extract_pages(pdf, ocr_langs, on_page)
    chapters = split_chapters(clean_pages(pages), toc)
    if not chapters:
        raise Rejected("No text found in the PDF, even with OCR")
    return chapters, pages_count, used_ocr


def _page_heartbeat(conn, job_id, analyze: bool):
    # extraction with OCR can outlast the 10-minute stale window, so every page counts as a heartbeat
    def on_page(i: int, n: int):
        if i % 10 == 0 or i == n:
            db.progress(conn, job_id, int(i / n * 99) if analyze else 0, f"Reading page {i}/{n}")
    return on_page


def handle_analyze(conn, storage, settings, job: dict) -> None:
    doc = db.get_document(conn, job["documentId"])
    try:
        chapters, pages, used_ocr = read_chapters(load_pdf(storage, doc), settings.ocr_langs,
                                                  _page_heartbeat(conn, job["id"], analyze=True))
    except Rejected as e:
        db.reject_document(conn, job, str(e))
        return
    db.finish_analyze(conn, job, pages=pages, words=sum(c.words for c in chapters), used_ocr=used_ocr,
                      chapters=[c.as_json() for c in chapters])


def handle_summarize(conn, storage, settings, client, job: dict) -> None:
    doc = db.get_document(conn, job["documentId"])
    chapters, _, _ = read_chapters(load_pdf(storage, doc), settings.ocr_langs,
                                   _page_heartbeat(conn, job["id"], analyze=False))
    opts = job["options"]
    usage = Usage()
    markdown, warnings = summarize_chapters(
        client, settings.llm_model, chapters, render_instructions(opts["preset"], opts["language"], opts["fraction"]),
        fraction=opts["fraction"], bibliographic_line=opts.get("bibliographicLine"),
        on_progress=lambda percent, phase: db.progress(conn, job["id"], percent, phase), usage=usage)
    db.progress(conn, job["id"], 99, "Saving")
    prefix = f"users/{job['userId']}/results/{job['id']}"
    storage.put(f"{prefix}.md", markdown.encode("utf-8"), "text/markdown; charset=utf-8")
    storage.put(f"{prefix}.docx", to_docx(markdown), DOCX_MIME)
    db.finish_summary(conn, job, md_key=f"{prefix}.md", docx_key=f"{prefix}.docx", warnings=warnings,
                      input_tokens=usage.input_tokens, output_tokens=usage.output_tokens)


def process(conn, storage, settings, client, job: dict) -> None:
    try:
        if job["kind"] == "analyze":
            handle_analyze(conn, storage, settings, job)
        else:
            handle_summarize(conn, storage, settings, client, job)
    except Exception:
        traceback.print_exc()  # details stay in the worker log; the user sees db.SUMMARY_ERROR / ANALYZE_ERROR
        db.fail_or_retry(conn, job)
```

`apps/worker/summarize_worker/__main__.py`:

```python
"""python -m summarize_worker — one thread per job kind, so a new upload is analysed while a long summary runs."""
import threading
import time
import traceback

import psycopg
from psycopg.rows import dict_row

from . import db
from .config import Settings
from .handlers import process
from .llm import make_client
from .storage import Storage

POLL_SECONDS = 2
RECOVERY_EVERY = 300


def run(kind: str, settings: Settings, stop: threading.Event) -> None:
    storage, client = Storage(settings), make_client(settings.llm_base_url, settings.llm_api_key)
    conn, last_recovery = None, 0.0
    while not stop.is_set():
        try:
            if conn is None or conn.closed:
                conn = psycopg.connect(settings.database_url, autocommit=True, row_factory=dict_row)
            if kind == "analyze" and time.time() - last_recovery > RECOVERY_EVERY:
                if n := db.recover_stale(conn):
                    print(f"recovered {n} stale job(s)")
                last_recovery = time.time()
            job = db.claim(conn, kind)
            if job is None:
                stop.wait(POLL_SECONDS)
                continue
            print(f"{kind}: job {job['id']} (attempt {job['attempts']})")
            process(conn, storage, settings, client, job)
        except psycopg.OperationalError:
            traceback.print_exc()  # database restarted: reconnect after a pause
            conn = None
            stop.wait(5)


def main() -> None:
    settings = Settings.from_env()
    stop = threading.Event()
    threads = [threading.Thread(target=run, args=(kind, settings, stop), daemon=True) for kind in ("analyze", "summarize")]
    for t in threads:
        t.start()
    print(f"worker started (model {settings.llm_model})")
    try:
        while any(t.is_alive() for t in threads):
            stop.wait(1)
    except KeyboardInterrupt:
        stop.set()  # a job interrupted mid-run is picked up again by recover_stale


if __name__ == "__main__":
    main()
```

- [ ] **Step 6: Verifica che passi**

Run: `cd apps/worker && python -m pytest -q`
Expected: PASS, tutti i test del worker. `test_runtime.py` richiede `pnpm infra:up`.

- [ ] **Step 7: Prova il worker a mano con l'LLM finto**

Run: `LLM_BASE_URL=fake LLM_MODEL=fake python -m summarize_worker`, poi Ctrl-C.
Expected: `worker started (model fake)`, nessun errore di connessione.

- [ ] **Step 8: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): postgres job queue, S3 storage, analyze/summarize handlers, retries and stale recovery"
```

---

### Task 12: `apps/web` — frontend React, e l'API che lo serve in produzione

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`
- Create: `apps/web/src/main.tsx`, `src/index.css`, `src/api.ts`, `src/App.tsx`
- Create: `apps/web/src/pages/Login.tsx`, `src/pages/Verify.tsx`, `src/pages/Dashboard.tsx`, `src/pages/DocumentPage.tsx`, `src/pages/JobPage.tsx`
- Modify: `apps/api/src/app.module.ts` (static serving)

**Interfaces:**
- Consumes: tutte le route `/api/*` dei Task 4–8.
- Produces, cioè le etichette esatte su cui si basa l'e2e del Task 13:
  - campo con label `Email`;
  - pulsante `Send login link`;
  - testo `Check your inbox`;
  - `data-testid="balance"` con il testo `{n} credits`;
  - link con il nome del file sulla dashboard;
  - pulsante `Start summary`;
  - testo `Done`;
  - pulsanti `Download .md` e `Download .docx`.
- Il dev server gira su `:5173` e fa da proxy per `/api` verso `API_URL` (default `http://localhost:3000`).

- [ ] **Step 1: Pacchetto e configurazione**

`apps/web/package.json`:

```json
{
  "name": "@summarize/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.60.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router": "^7.1.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.9.0",
    "vite": "^7.0.0"
  }
}
```

`apps/web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

`apps/web/vite.config.ts`:

```ts
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // same-origin /api in dev: session cookies and the Origin check work exactly as in production
  server: { port: 5173, proxy: { '/api': process.env.API_URL ?? 'http://localhost:3000' } },
});
```

`apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Summarize</title>
  </head>
  <body class="bg-gray-50 text-gray-900">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/index.css`:

```css
@import "tailwindcss";
```

- [ ] **Step 2: Client API e tipi**

`apps/web/src/api.ts`:

```ts
import { useQuery } from '@tanstack/react-query';

export type Me = { id: string; email: string; name: string | null; balance: number };
export type Chapter = { title: string; pageFrom: number | null; pageTo: number | null; words: number };
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
export type Job = {
  id: string; documentId: string; kind: 'analyze' | 'summarize'; options: Record<string, unknown>;
  status: JobStatus; progress: number; phase: string; credits: number; error: string | null;
  createdAt: string; finishedAt: string | null;
};
export type Doc = {
  id: string; filename: string; sizeBytes: number; status: 'uploaded' | 'analyzed' | 'rejected';
  rejectReason: string | null; pages: number | null; words: number | null; chapters: Chapter[] | null;
  credits: number | null; createdAt: string; jobs: Job[];
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: any) {
    super(message);
  }
}

export async function api<T = void>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = Array.isArray(body?.message) ? body.message.join(', ') : body?.message ?? res.statusText;
    throw new ApiError(res.status, message, body);
  }
  return body as T;
}

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });

export async function uploadFile(file: File) {
  const { document, uploadUrl } = await api<{ document: Doc; uploadUrl: string }>('/documents', {
    method: 'POST',
    body: JSON.stringify({ filename: file.name, sizeBytes: file.size }),
  });
  const put = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': 'application/pdf' } });
  if (!put.ok) throw new Error(`Upload failed (${put.status})`);
  await api(`/documents/${document.id}/uploaded`, { method: 'POST' });
}
```

- [ ] **Step 3: Entry, routing e layout**

`apps/web/src/main.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from './App';
import './index.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
```

`apps/web/src/App.tsx`:

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router';
import { api, Me, useMe } from './api';
import Dashboard from './pages/Dashboard';
import DocumentPage from './pages/DocumentPage';
import JobPage from './pages/JobPage';
import Login from './pages/Login';
import Verify from './pages/Verify';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/auth/verify" element={<Verify />} />
      <Route element={<RequireUser />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/documents/:id" element={<DocumentPage />} />
        <Route path="/jobs/:id" element={<JobPage />} />
      </Route>
    </Routes>
  );
}

function RequireUser() {
  const me = useMe();
  if (me.isPending) return <p className="p-8">Loading…</p>;
  if (me.error) return <Navigate to="/login" replace />;
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <Header me={me.data} />
      <Outlet />
    </div>
  );
}

function Header({ me }: { me: Me }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    qc.clear();
    navigate('/login');
  }
  return (
    <header className="flex items-center justify-between border-b pb-3">
      <Link to="/" className="text-lg font-semibold">Summarize</Link>
      <div className="flex items-center gap-4 text-sm">
        <span data-testid="balance" className="rounded bg-gray-200 px-2 py-1">{me.balance} credits</span>
        <span>{me.email}</span>
        <button onClick={logout} className="underline">Log out</button>
      </div>
    </header>
  );
}
```

- [ ] **Step 4: Login e verifica del link**

`apps/web/src/pages/Login.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { api } from '../api';

export default function Login() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<{ google: boolean }>('/auth/providers') });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api('/auth/magic-link', { method: 'POST', body: JSON.stringify({ email }) });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main className="mx-auto mt-24 max-w-sm space-y-4 p-6">
      <h1 className="text-2xl font-semibold">Log in to Summarize</h1>
      {sent ? (
        <p>Check your inbox: we sent a login link to {email}. It is valid for 15 minutes.</p>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <label className="block">
            Email
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full rounded border bg-white p-2" />
          </label>
          <button className="w-full rounded bg-black p-2 text-white">Send login link</button>
          {error && <p className="text-red-600">{error}</p>}
        </form>
      )}
      {providers.data?.google && (
        <a href="/api/auth/google" className="block rounded border bg-white p-2 text-center">Continue with Google</a>
      )}
    </main>
  );
}
```

`apps/web/src/pages/Verify.tsx`:

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api } from '../api';

export default function Verify() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice and the token is single-use
    started.current = true;
    api('/auth/magic-link/verify', { method: 'POST', body: JSON.stringify({ token: params.get('token') ?? '' }) })
      .then(() => qc.invalidateQueries({ queryKey: ['me'] }))
      .then(() => navigate('/', { replace: true }))
      .catch(() => setError('This login link is invalid or has expired.'));
  }, [params, navigate, qc]);

  return (
    <main className="mx-auto mt-24 max-w-sm space-y-3 p-6">
      {error ? (
        <>
          <p>{error}</p>
          <Link to="/login" className="underline">Request a new link</Link>
        </>
      ) : (
        <p>Logging in…</p>
      )}
    </main>
  );
}
```

- [ ] **Step 5: Dashboard con upload**

`apps/web/src/pages/Dashboard.tsx`:

```tsx
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, Doc, uploadFile } from '../api';

const busy = (d: Doc) => d.status === 'uploaded' || d.jobs.some((j) => j.status === 'queued' || j.status === 'running');

function docStatus(d: Doc) {
  if (d.status === 'uploaded') return 'Analyzing…';
  if (d.status === 'rejected') return `Rejected: ${d.rejectReason}`;
  const job = d.jobs[0];
  if (!job) return `${d.pages} pages · ${d.credits} credits`;
  if (job.status === 'done') return 'Done';
  if (job.status === 'failed') return 'Failed';
  return `${job.progress}%`;
}

export default function Dashboard() {
  const qc = useQueryClient();
  const [errors, setErrors] = useState<string[]>([]);
  const docs = useQuery({
    queryKey: ['documents'],
    queryFn: () => api<Doc[]>('/documents'),
    refetchInterval: (q) => (q.state.data?.some(busy) ? 3000 : false),
  });

  async function upload(files: FileList | null) {
    for (const file of Array.from(files ?? [])) {
      try {
        await uploadFile(file);
      } catch (e) {
        setErrors((list) => [...list, `${file.name}: ${(e as Error).message}`]);
      }
      await qc.invalidateQueries({ queryKey: ['documents'] });
    }
  }

  return (
    <section className="space-y-6">
      <label
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          upload(e.dataTransfer.files);
        }}
        className="block cursor-pointer rounded-lg border-2 border-dashed bg-white p-10 text-center"
      >
        Drop PDFs here or click to choose (max 50 MB, 400 pages each)
        <input type="file" accept="application/pdf" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
      </label>
      {errors.map((e) => <p key={e} className="text-red-600">{e}</p>)}
      <ul className="divide-y rounded border bg-white">
        {docs.data?.length === 0 && <li className="p-3 text-gray-500">No documents yet.</li>}
        {docs.data?.map((d) => (
          <li key={d.id} className="flex justify-between gap-4 p-3">
            <Link to={`/documents/${d.id}`} className="truncate underline">{d.filename}</Link>
            <span className="shrink-0 text-sm text-gray-600">{docStatus(d)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 6: Pagina del documento (preventivo e opzioni)**

`apps/web/src/pages/DocumentPage.tsx`:

```tsx
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError, Doc, Job, useMe } from '../api';

const LANGUAGES = [['auto', 'Same as the document'], ['en', 'English'], ['it', 'Italian'], ['nl', 'Dutch'], ['fr', 'French'], ['de', 'German'], ['es', 'Spanish']] as const;
const FRACTIONS = [[3, '1/3 of the original'], [5, '1/5 of the original'], [10, '1/10 of the original']] as const;
const PRESETS = [['studio', 'Study summary (continuous prose)'], ['schematico', 'Structured notes (bullet points)'], ['abstract', 'Short abstract']] as const;

function Select<T extends string | number>(props: { label: string; value: T; onChange: (v: T) => void; options: readonly (readonly [T, string])[] }) {
  return (
    <label className="block">
      {props.label}
      <select
        className="mt-1 w-full rounded border bg-white p-2"
        value={props.value}
        onChange={(e) => props.onChange((typeof props.value === 'number' ? Number(e.target.value) : e.target.value) as T)}
      >
        {props.options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    </label>
  );
}

function errorText(e: Error) {
  if (e instanceof ApiError && e.status === 402) {
    return `Not enough credits: this document needs ${e.body.needed}, you have ${e.body.balance}. Credit purchases are coming soon.`;
  }
  return e.message;
}

export default function DocumentPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const me = useMe();
  const [language, setLanguage] = useState<string>('auto');
  const [fraction, setFraction] = useState<number>(3);
  const [preset, setPreset] = useState<string>('studio');
  const [bibliographicLine, setBibliographicLine] = useState('');
  const doc = useQuery({
    queryKey: ['documents', id],
    queryFn: () => api<Doc>(`/documents/${id}`),
    refetchInterval: (q) => (q.state.data?.status === 'uploaded' ? 2000 : false),
  });
  const start = useMutation({
    mutationFn: () =>
      api<Job>('/jobs', {
        method: 'POST',
        body: JSON.stringify({
          documentId: id, language, fraction, preset,
          ...(bibliographicLine.trim() ? { bibliographicLine: bibliographicLine.trim() } : {}),
        }),
      }),
    onSuccess: (job) => navigate(`/jobs/${job.id}`),
  });

  if (doc.error) return <p className="text-red-600">{doc.error.message}</p>;
  if (!doc.data) return <p>Loading…</p>;
  const d = doc.data;
  if (d.status === 'uploaded') return <p>Analyzing {d.filename}…</p>;
  if (d.status === 'rejected') return <p>{d.filename} was rejected: {d.rejectReason}</p>;

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">{d.filename}</h1>
      <p className="text-sm text-gray-600">{d.pages} pages · {d.words} words · {d.chapters?.length} part(s)</p>
      <ol className="list-decimal space-y-1 pl-6 text-sm">
        {d.chapters?.map((c, i) => (
          <li key={i}>{c.title}{c.pageFrom ? ` (pp. ${c.pageFrom}–${c.pageTo})` : ''} · {c.words} words</li>
        ))}
      </ol>
      <div className="grid gap-3 sm:grid-cols-3">
        <Select label="Language" value={language} onChange={setLanguage} options={LANGUAGES} />
        <Select label="Length" value={fraction} onChange={setFraction} options={FRACTIONS} />
        <Select label="Style" value={preset} onChange={setPreset} options={PRESETS} />
      </div>
      <label className="block">
        Bibliographic line (optional)
        <input
          maxLength={300}
          value={bibliographicLine}
          onChange={(e) => setBibliographicLine(e.target.value)}
          placeholder="**Arend Lijphart** – *Patterns of Democracy*, Yale University Press, 2012"
          className="mt-1 w-full rounded border bg-white p-2"
        />
      </label>
      <p>Cost: <strong>{d.credits} credits</strong> · Your balance: {me.data?.balance} credits</p>
      <button disabled={start.isPending} onClick={() => start.mutate()} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">
        Start summary
      </button>
      {start.error && <p className="text-red-600">{errorText(start.error)}</p>}
      {d.jobs.length > 0 && (
        <ul className="space-y-1 text-sm">
          {d.jobs.map((j) => (
            <li key={j.id}>
              <Link className="underline" to={`/jobs/${j.id}`}>Summary of {new Date(j.createdAt).toLocaleString()}</Link> — {j.status}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 7: Pagina del job (avanzamento e download)**

`apps/web/src/pages/JobPage.tsx`:

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, Job } from '../api';

export default function JobPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const [job, setJob] = useState<Job | null>(null);

  useEffect(() => {
    const source = new EventSource(`/api/jobs/${id}/events`);
    source.onmessage = (e) => {
      const next: Job = JSON.parse(e.data);
      setJob(next);
      if (next.status === 'done' || next.status === 'failed') {
        source.close(); // close before the browser auto-reconnects to a finished stream
        qc.invalidateQueries({ queryKey: ['me'] });
        qc.invalidateQueries({ queryKey: ['documents'] });
      }
    };
    return () => source.close();
  }, [id, qc]);

  async function download(format: 'md' | 'docx') {
    const { url } = await api<{ url: string }>(`/jobs/${id}/download?format=${format}`);
    window.location.href = url;
  }

  if (!job) return <p>Loading…</p>;
  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Summary</h1>
      {job.status === 'done' && (
        <>
          <p className="font-medium text-green-700">Done</p>
          <div className="flex gap-3">
            <button onClick={() => download('md')} className="rounded bg-black px-4 py-2 text-white">Download .md</button>
            <button onClick={() => download('docx')} className="rounded bg-black px-4 py-2 text-white">Download .docx</button>
          </div>
        </>
      )}
      {job.status === 'failed' && <p className="text-red-600">{job.error}</p>}
      {(job.status === 'queued' || job.status === 'running') && (
        <>
          <div className="h-3 w-full rounded bg-gray-200">
            <div className="h-3 rounded bg-black transition-all" style={{ width: `${job.progress}%` }} />
          </div>
          <p className="text-sm text-gray-600">{job.progress}% · {job.status === 'queued' ? 'Waiting in queue' : job.phase}</p>
        </>
      )}
      <Link to="/" className="underline">Back to documents</Link>
    </section>
  );
}
```

- [ ] **Step 8: L'API serve la build del web in produzione**

In `apps/api/src/app.module.ts`:

```ts
import { ServeStaticModule } from '@nestjs/serve-static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const webDist = join(process.cwd(), '../web/dist');
// imports: [..., ...(existsSync(webDist) ? [ServeStaticModule.forRoot({ rootPath: webDist, exclude: ['/api/{*path}'] })] : [])]
```

- [ ] **Step 9: Verifica build e type check**

Run: `pnpm install && pnpm --filter @summarize/web build && pnpm --filter @summarize/api test`
Expected: `vite build` crea `apps/web/dist/index.html` senza errori TypeScript e i test API passano ancora.

- [ ] **Step 10: Smoke test manuale**

Run in tre terminali: `pnpm --filter @summarize/api dev`, `pnpm --filter @summarize/web dev` e `LLM_BASE_URL=fake LLM_MODEL=fake python -m summarize_worker`. Poi apri http://localhost:5173.
Expected: login con un'email, link da http://localhost:8025, `pnpm --filter @summarize/api grant <email> 20`, ricarica e il saldo mostra `20 credits`. Carica un PDF: "Analyzing…" e poi le pagine. Apri il documento, premi `Start summary`, la barra avanza fino a `Done` e il `.md` si scarica.

- [ ] **Step 11: Commit**

```bash
git add apps/web apps/api pnpm-lock.yaml
git commit -m "feat(web): login, upload dashboard, quote and options, live job progress, downloads"
```

---

### Task 13: E2E con Playwright — il percorso completo

**Files:**
- Create: `e2e/package.json`, `e2e/playwright.config.ts`, `e2e/global-setup.ts`, `e2e/global-teardown.ts`, `e2e/make_fixture.py`, `e2e/tests/happy-path.spec.ts`

**Interfaces:**
- Consumes:
  - le etichette UI del Task 12;
  - il comando `grant` (Task 7);
  - `LLM_BASE_URL=fake` (Task 10);
  - l'API di Mailpit: `GET /api/v1/search?query=to:<email>` e `GET /api/v1/message/<ID>` → `{ Text }`.
- Produces: `pnpm e2e`. Gira su porte separate (API `:3100`, web `:5174`), con il DB `summarize_test_e2e` e il bucket `summarize-test`, quindi non tocca i dati di sviluppo.

- [ ] **Step 1: Pacchetto e configurazione**

`e2e/package.json`:

```json
{
  "name": "@summarize/e2e",
  "private": true,
  "scripts": {
    "e2e": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "^1.55.0",
    "@types/node": "^22.10.0"
  }
}
```

`e2e/playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export const E2E_DB = 'postgresql://summarize:summarize@localhost:5432/summarize_test_e2e';
export const E2E_ENV = {
  DATABASE_URL: E2E_DB,
  S3_BUCKET: 'summarize-test',
  WEB_ORIGIN: 'http://localhost:5174',
  PORT: '3100',
  API_URL: 'http://localhost:3100',
  GOOGLE_CLIENT_ID: '',
  LLM_BASE_URL: 'fake',
  LLM_MODEL: 'fake',
};

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  workers: 1,
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  use: { baseURL: 'http://localhost:5174', trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'pnpm --filter @summarize/api dev',
      url: 'http://localhost:3100/api/health',
      env: E2E_ENV,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'pnpm --filter @summarize/web dev --port 5174 --strictPort',
      url: 'http://localhost:5174',
      env: E2E_ENV,
      reuseExistingServer: false,
    },
  ],
});
```

`e2e/make_fixture.py`:

```python
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
```

`e2e/global-setup.ts`:

```ts
import { execSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { E2E_DB, E2E_ENV } from './playwright.config';

const python = process.env.PYTHON ?? 'python';

export default async function globalSetup() {
  execSync('pnpm --filter @summarize/db exec prisma migrate reset --force --skip-seed --skip-generate', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: E2E_DB },
  });
  execSync(`${python} ${resolve(__dirname, 'make_fixture.py')}`, { stdio: 'inherit' });
  const worker = spawn(python, ['-m', 'summarize_worker'], {
    cwd: resolve(__dirname, '../apps/worker'),
    env: { ...process.env, ...E2E_ENV },
    stdio: 'inherit',
  });
  writeFileSync(resolve(__dirname, '.worker.pid'), String(worker.pid));
}
```

`e2e/global-teardown.ts`:

```ts
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

export default async function globalTeardown() {
  const pidFile = resolve(__dirname, '.worker.pid');
  if (!existsSync(pidFile)) return;
  try {
    process.kill(Number(readFileSync(pidFile, 'utf8')));
  } catch {
    // already gone
  }
  rmSync(pidFile);
}
```

- [ ] **Step 2: Scrivi il test**

`e2e/tests/happy-path.spec.ts`:

```ts
import { APIRequestContext, expect, test } from '@playwright/test';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { E2E_ENV } from '../playwright.config';

async function loginLink(request: APIRequestContext, email: string) {
  for (let i = 0; i < 40; i++) {
    const search = await (await request.get(`http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
    if (search.messages?.length) {
      const message = await (await request.get(`http://localhost:8025/api/v1/message/${search.messages[0].ID}`)).json();
      return /(http\S+token=[\w-]+)/.exec(message.Text)![1];
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no login email for ${email}`);
}

test('login, upload, summarize and download', async ({ page, request }) => {
  const email = `e2e-${Date.now()}@example.com`;
  execSync(`pnpm --filter @summarize/api grant ${email} 50`, { env: { ...process.env, ...E2E_ENV }, stdio: 'inherit' });

  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send login link' }).click();
  await expect(page.getByText('Check your inbox')).toBeVisible();

  await page.goto(await loginLink(request, email));
  await expect(page.getByTestId('balance')).toHaveText('50 credits');

  await page.locator('input[type=file]').setInputFiles(resolve(__dirname, '../fixtures/sample.pdf'));
  await page.getByRole('link', { name: 'sample.pdf' }).click();
  await expect(page.getByRole('button', { name: 'Start summary' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Cost: 1 credits')).toBeVisible();
  await page.getByRole('button', { name: 'Start summary' }).click();

  await expect(page.getByText('Done')).toBeVisible({ timeout: 60_000 });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download .md' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('sample - Summary.md');
  expect(readFileSync(await download.path(), 'utf8')).toContain('# Fake Summary');
  await expect(page.getByTestId('balance')).toHaveText('49 credits');
});
```

- [ ] **Step 3: Installa il browser ed esegui**

Run: `pnpm install && pnpm --filter @summarize/e2e exec playwright install chromium && pnpm infra:up && pnpm e2e`
Expected: `1 passed`. Se fallisce, apri la trace con `pnpm --filter @summarize/e2e exec playwright show-trace test-results/**/trace.zip`. Se si ferma su `Start summary`, il worker non è partito: controlla l'output di `python -m summarize_worker` nel log.

- [ ] **Step 4: Esegui tutta la suite**

Run: `pnpm test && python legacy/test_controlli.py`
Expected: passano i test di api e worker, e il legacy stampa `ok` … `ok 4`.

- [ ] **Step 5: Commit**

```bash
git add e2e pnpm-lock.yaml
git commit -m "test(e2e): full login-upload-summarize-download path with fake LLM"
```

---

## Fuori da questo piano (rilasci 2 e 3 dello spec)

Stripe Checkout, webhook e `StripeEvent`; Sign in with Apple; email all'utente quando un job fallisce definitivamente (spec §10; nel rilascio 1 l'errore e il rimborso si vedono solo nella UI); eliminazione dell'account; lifecycle rule a 30 giorni; pagine legali; i18n; Dockerfile e deploy su Railway e R2; taratura del prezzo per credito dai token misurati.
