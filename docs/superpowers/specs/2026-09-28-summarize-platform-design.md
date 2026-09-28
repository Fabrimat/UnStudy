# Summarize — piattaforma web per riassunti di studio

Data: 2026-09-28 · Stato: design approvato in chat, in revisione come spec

## 1. Obiettivo

Trasformare `riassumi_libro.py` in un **SaaS pubblico**: un utente si registra, carica i PDF di cui vuole un riassunto, vede un preventivo in crediti, paga con Stripe e scarica il riassunto in `.md` e `.docx`. La qualità della pipeline attuale (bozza → verifica → controlli automatici → formato) è il punto di forza del prodotto e non deve peggiorare.

**Successo (MVP):** un utente sconosciuto completa login → acquisto crediti → upload → riassunto scaricato senza intervento manuale; nessun credito perso o accreditato due volte; dati in UE.

**Decisioni prese dall'utente:** SaaS pubblico · riassunti configurabili (lingua, lunghezza, preset) · crediti prepagati · LLM dietro config, default Claude in produzione · PaaS gestito in UE · Stripe · login con magic link + Google + Apple, estendibile · stack NestJS + React in monorepo · pipeline che resta in Python.

**Fuori scope MVP:** abbonamenti, Mollie, istruzioni libere dell'utente, modifica manuale della divisione in capitoli, formati diversi dal PDF, pannello admin (si usano query SQL e dashboard Stripe), condivisione dei riassunti.

## 2. Architettura

```
apps/web           React + Vite + TanStack Query + Tailwind
apps/api           NestJS: auth, documents, jobs, credits, billing, SSE
apps/worker        Python: pipeline di riassunto (da riassumi_libro.py)
packages/db        schema Prisma (unica fonte di verità dello schema) + migrazioni
legacy/            riassumi_libro.py, istruzioni_esame.md, test_controlli.py (CLI attuale)
```

- Monorepo con **pnpm workspaces + Turborepo** per le parti TypeScript; il worker ha il proprio `pyproject.toml` ed è invocato da Turborepo tramite script.
- **Infrastruttura, tutta in UE:** Railway (region EU) con Postgres gestito; Cloudflare R2 con giurisdizione EU (S3-compatibile, niente costi di egress); email transazionali con Resend; Stripe. Sono tutti sostituibili da config: il codice parla S3 e SMTP/HTTP standard.
- **Niente Redis:** la coda è la tabella `Job` in Postgres.
- Il worker è un container Docker con Python, Tesseract e pandoc.

### Flusso

1. Il browser chiede a `api` un URL di upload firmato (PUT, 15 minuti, chiave `users/{userId}/documents/{documentId}.pdf`) e carica direttamente su S3.
2. Il browser conferma l'upload; `api` accoda un job di **analisi** (`kind=analyze`). Il worker estrae il testo e l'eventuale outline, conta pagine e parole, determina la divisione in capitoli e scrive tutto su `Document`. Il preventivo in crediti viene calcolato da `api` quando lo mostra.
3. L'utente sceglie le opzioni e conferma. In **una transazione** `api` verifica il saldo, scrive una riga `reserve` nel ledger e crea il `Job` (`kind=summarize`, `status=queued`).
4. Il worker prende il job con `SELECT … FOR UPDATE SKIP LOCKED`, lo elabora capitolo per capitolo e aggiorna `progress`, `phase` e `heartbeat`.
5. `api` espone `GET /jobs/:id/events` (SSE) che legge lo stato del job da Postgres ogni 2 secondi e invia le variazioni.
6. A fine job il worker carica `.md` e `.docx` su S3 e, nella stessa transazione in cui imposta `status=done`, scrive la riga `charge`. Se il job fallisce definitivamente scrive `status=failed` e la riga `refund`.
7. Il download avviene con URL GET firmati e validi 5 minuti, emessi solo al proprietario.

## 3. Modello dati (Prisma)

- **User**: id, email (unique, verificata), name, createdAt, deletedAt.
- **AuthAccount**: userId, provider (`email` | `google` | `apple`), providerAccountId; unique(provider, providerAccountId). Aggiungere un provider significa aggiungere un valore e una strategia Passport.
- **MagicLinkToken**: tokenHash (unique), email, expiresAt, usedAt.
- **Session**: id (casuale, 256 bit), userId, expiresAt, createdAt. Sessioni in Postgres: il logout le invalida lato server.
- **Document**: id, userId, s3Key, filename, pages, words, usedOcr, chapters (JSON: `[{title, pageFrom, pageTo, words}]`), status (`uploaded` | `analyzed` | `rejected`), rejectReason, createdAt, fileDeletedAt.
- **Job**: id, userId, documentId, kind (`analyze` | `summarize`), options (JSON: `{language, fraction, preset, bibliographicLine?}`), status (`queued` | `running` | `done` | `failed`), attempts, progress (0–100), phase, heartbeatAt, credits, inputTokens, outputTokens, warnings (JSON, output di `controlli()`), resultMdKey, resultDocxKey, error, createdAt, finishedAt.
- **CreditLedger**: id, userId, type (`purchase` | `reserve` | `charge` | `refund` | `grant` | `revoke`), amount (con segno), jobId?, stripeEventId?, createdAt. **Registro solo in append**, senza colonna saldo. Definizioni:
  - saldo disponibile = Σ amount di `purchase`, `grant`, `refund`, `revoke` e `reserve`;
  - `reserve` vale −credits;
  - `charge` vale 0 e registra soltanto la conclusione (i crediti sono già stati scalati dalla riserva);
  - `refund` vale +credits.
- **StripeEvent**: id (= `event.id` di Stripe, PK), type, processedAt.

I **preset** stanno nel codice del worker (file di istruzioni), non nel DB.

## 4. Pipeline (apps/worker)

Si parte da `riassumi_libro.py` e lo si divide in moduli; la logica resta invariata salvo quanto indicato qui.

- **Coda:** ciclo di polling ogni 2 secondi. Il job viene preso con `UPDATE … SET status='running', attempts=attempts+1, heartbeat_at=now() WHERE id = (SELECT id FROM job WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`.
- **Heartbeat e recupero:** il worker aggiorna `heartbeatAt` a ogni cambio di fase e almeno ogni 60 secondi. All'avvio e ogni 5 minuti rimette in `queued` i job `running` con heartbeat più vecchio di 10 minuti e `attempts < 2`; quelli con `attempts >= 2` vanno in `failed` con rimborso.
- **Estrazione:** PyMuPDF e, per le pagine senza testo, OCR con pytesseract (come oggi). Il tipo di file si verifica dai magic byte (`%PDF-`). Documento rifiutato, senza crediti riservati, se: non è un PDF, supera 50 MB o 400 pagine, oppure il testo estratto è vuoto anche dopo l'OCR.
- **Capitoli:** se il PDF ha un outline (`doc.get_toc()`) si usano le voci di primo livello con le rispettive pagine; altrimenti si divide a blocchi di parole come fa `suddividi_in_capitoli`. Le pagine di ogni capitolo sostituiscono l'attuale `--pagine`.
- **Istruzioni:** `presets/{studio,schematico,abstract}.md` sono template con `{language}` e `{fraction}`. `studio.md` è l'attuale `istruzioni_esame.md` con quei due valori parametrizzati. `schematico` ammette i punti elenco; `abstract` produce un solo blocco breve per capitolo. `bibliographicLine`, se presente, prende il posto dell'attuale `--fonte`.
- **Chiamate LLM:** client `openai` con `LLM_BASE_URL`, `LLM_API_KEY` e `LLM_MODEL` da variabili d'ambiente. In produzione l'endpoint compatibile OpenAI di Anthropic con Claude Sonnet; in sviluppo NVIDIA (`nvidia/nemotron-3-ultra-550b-a55b`). Restano il retry con backoff, la regola di verifica (bozza scartata se sotto il 70% delle parole) e l'avviso su `finish_reason == "length"`. Si registrano i token di input e di output leggendo `usage` dallo stream.
- **Avanzamento:** la callback attuale `stato()` scrive `progress` e `phase` sul job invece che su `progresso.txt`.
- **Controlli e formato:** `controlli()` e `sistema_formato()` restano invariati; gli avvisi finiscono in `Job.warnings` e non bloccano la consegna. Il controllo sulla lunghezza usa la `fraction` scelta al posto del fisso 1/3.
- **Output:** `.md` e `.docx` (pandoc, come `salva_docx`) su S3 in `users/{userId}/results/{jobId}.{md,docx}`. Il testo estratto non viene mai salvato.

## 5. Crediti e prezzi

- `credits = ceil(words / 1000)`, con un minimo di 1. Calcolato da `api` alla creazione del job e **fisso**: è esattamente l'importo riservato ed eventualmente rimborsato, senza conguagli.
- Il prezzo in euro dei pacchetti è configurato come Stripe Price; gli ID dei Price stanno nelle variabili d'ambiente. Il valore si fissa dopo aver misurato i token reali su alcuni documenti (`Job.inputTokens` e `Job.outputTokens`).
- **Concorrenza:** la creazione del job blocca la riga `User` (`SELECT … FOR UPDATE`) prima di calcolare il saldo, così due richieste parallele non possono andare entrambe sotto zero.
- Al massimo 3 job `summarize` attivi (`queued` o `running`) per utente, verificato nella stessa transazione.
- `grant` e `revoke` servono al supporto e alle prove; nell'MVP si fanno via SQL o con un comando CLI in `api`.

## 6. Auth

- **Passport** in NestJS con tre strategie:
  - **Magic link:** token di 32 byte casuali, in DB solo l'hash SHA-256, monouso, valido 15 minuti, inviato tramite il provider email.
  - **Google:** OIDC.
  - **Apple:** Sign in with Apple; il nome arriva solo al primo login e va salvato subito.
- **Collegamento degli account:** un login con un'email già verificata di un `User` esistente aggiunge un `AuthAccount` allo stesso utente. Le email relay private di Apple restano utenti separati.
- **Sessione:** cookie `sid` `httpOnly`, `Secure`, `SameSite=Lax`, valido 30 giorni. Protezione CSRF: `SameSite=Lax` più il controllo dell'header `Origin` sulle richieste che modificano dati.
- **Rate limit** (`@nestjs/throttler`): richiesta del magic link 5/ora per email e IP; upload 30/ora per utente.
- Ogni query su `Document` e `Job` è filtrata per `userId` della sessione; un id non proprio restituisce 404.

## 7. Stripe

- **Checkout Session** in modalità `payment`, con `client_reference_id = userId` e i crediti del pacchetto nei `metadata`. Stripe Tax attivo, fatture automatiche attive. Nessun dato di carta passa dai nostri server.
- **Solo il webhook accredita** i crediti, mai il redirect di successo. `POST /billing/webhook` verifica la firma sul raw body. Per `checkout.session.completed` con `payment_status=paid`, in una transazione, inserisce `StripeEvent` e la riga `purchase`: un evento ripetuto urta il vincolo PK, la transazione fa rollback e si risponde 200.
- `charge.refunded`: riga `revoke` per i crediti del pacchetto. Il saldo può diventare negativo; con saldo negativo non si possono creare job.
- I rimborsi si fanno dal dashboard Stripe.

## 8. GDPR e legale

- Tutti i dati in UE (DB, bucket, region del PaaS).
- **Retention:** i PDF caricati vengono cancellati 30 giorni dopo l'upload con una lifecycle rule sul prefisso `users/*/documents/`; `Document.fileDeletedAt` viene impostato alla prima lettura che trova il file mancante. I riassunti restano finché l'utente non li cancella. Il testo estratto non viene mai salvato.
- **Eliminazione dell'account:** cancella gli oggetti S3 dell'utente, `Document`, `Job`, `Session` e `AuthAccount`; anonimizza `User` (email sostituita da un hash, `deletedAt` valorizzato). `CreditLedger` e `StripeEvent` restano per gli obblighi fiscali.
- **Pagine richieste prima del lancio:** privacy policy con l'elenco dei sub-processor (LLM provider, Stripe, hosting, storage, email) e ToS. I ToS includono la dichiarazione dell'utente di avere diritto a usare il materiale caricato per studio personale; i riassunti sono privati e non condivisibili. DPA con ogni sub-processor. **Parere legale sul copyright prima del lancio pubblico.**

## 9. Frontend (apps/web)

Pagine:
- login (email più pulsanti Google e Apple);
- dashboard con saldo crediti e lista di documenti e job;
- upload con drag & drop e più file;
- preventivo e opzioni (lingua, lunghezza 1/3, 1/5 o 1/10, preset, riga bibliografica opzionale), con la divisione in capitoli in sola lettura;
- dettaglio del job con barra di avanzamento via SSE, fase corrente e download;
- acquisto crediti, che fa il redirect al Checkout;
- account con eliminazione.

UI in inglese e italiano (i18n con `react-i18next`).

## 10. Errori

| Caso | Comportamento |
|---|---|
| Upload non PDF, troppo grande o senza testo | `Document.status=rejected` con motivo; nessun credito toccato |
| Saldo insufficiente | 402 con il fabbisogno; la UI propone l'acquisto |
| Errore LLM transitorio | retry con backoff dentro la pipeline (come oggi) |
| Worker morto a metà | heartbeat scaduto: job rimesso in coda, al massimo 2 tentativi |
| Fallimento definitivo | `failed` e `refund` nella stessa transazione, email all'utente |
| Webhook duplicato | vincolo PK su `StripeEvent`, risposta 200, nessun doppio accredito |
| Avvisi dei controlli | salvati in `Job.warnings`, riassunto consegnato comunque |

## 11. Test

- **Worker (pytest):** `test_controlli.py` esistente, più test per template dei preset, parsing dell'outline e divisione in capitoli; un test di integrazione su un PDF piccolo con LLM finto che verifica stato, avanzamento, charge e refund sul DB.
- **API (Jest):** ledger (riserva e rimborso; due creazioni concorrenti con saldo per una sola, di cui una sola riesce; limite di 3 job attivi); idempotenza del webhook (stesso evento due volte, un solo `purchase`); verifica della firma del webhook; isolamento tra utenti (404 su risorse altrui).
- **E2E (Playwright), un solo percorso:** magic link con email catturata in dev, acquisto in Stripe test mode, upload, preventivo, job con worker e LLM finto, download.

## 12. Rilasci

Ogni rilascio ha il proprio piano di implementazione.

1. **Nucleo:** monorepo, DB, auth (magic link e Google; Apple nel rilascio 3 se richiede il developer account), upload, analisi, job, avanzamento via SSE, download. I crediti si danno solo con `grant`.
2. **Pagamenti:** Stripe Checkout, webhook, pagina di acquisto, `revoke` sui rimborsi.
3. **Lancio:** Apple, eliminazione dell'account, lifecycle rule, pagine legali, i18n completo, deploy di produzione in UE, taratura del prezzo per credito.
