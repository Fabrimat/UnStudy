# Rilascio A — Browser, dashboard, consumi

**Spec:** `docs/superpowers/specs/2026-09-29-personalizzazione-design.md` §2. È l'autorità: questo piano ne ricava i brief.

**Già fatto dall'head:** schema e migrazione `packages/db/prisma/migrations/20260929112956_usage_tracking_and_job_list_index`, con:
- `LlmCall`, con enum `LlmPhase` `draft` | `verify`;
- `Job.model` e `Job.durationMs`;
- indice `Job(userId, kind, createdAt)`.

Il client Prisma è già generato.

## Global Constraints

- Mai stampare o committare `.env`.
- Mai usare `prisma migrate reset` e mai modificare le migrazioni esistenti.
- Niente trailer Co-Authored-By.
- Non toccare i file non tracciati `Lijphart - …`.
- Log: id utente e id risorsa, mai nomi di file, email o testo dei riassunti. Pattern `new Logger(X.name)` nell'API e `log = logging.getLogger(__name__)` nel worker.
- Nessun dato di token o `LlmCall` arriva mai al browser: `toJobDto` resta com'è.
- Seguire lo stile esistente: file piccoli, commenti rari e mirati, `ponytail:` sulle semplificazioni volute.

## Contratto API (condiviso tra il brief API e il brief Web)

```ts
type Page<T> = { items: T[]; total: number; page: number; pageSize: number };
// query comuni: page>=1 (default 1), pageSize 1..100 (default 20); 400 se non validi
GET  /api/documents?page&pageSize&q&status=analyzing|ready|rejected|summarized&sort=createdAt|filename&order=asc|desc  -> Page<Doc>
     // analyzing = status 'uploaded'; ready = 'analyzed'; rejected = 'rejected'; summarized = ha almeno un job summarize 'done'
     // Doc = forma attuale di toDocDto (include jobs summarize)
PATCH  /api/documents/:id  { filename }   -> Doc      // 1..200 caratteri dopo trim, una sola riga
DELETE /api/documents/:id                  -> 204      // 409 se ha job queued/running
GET  /api/jobs?page&pageSize&status=queued|running|done|failed&method=<preset>&documentId=<uuid>&active=true -> Page<Job & { document: { id, filename } }>
     // solo kind summarize, createdAt desc; method = options.preset (in B arriverà anche custom)
DELETE /api/jobs/:id                       -> 204      // 409 se non done/failed
GET  /api/jobs/:id/content                 -> text/markdown   // 404 se non done
GET  /api/me/ledger?page&pageSize          -> Page<{ id, type, amount, createdAt, jobId: string|null, filename: string|null }>
GET  /api/me/stats                         -> { documents, summariesDone, creditsSpent, pagesSummarized }
     // creditsSpent = Σ Job.credits dei job done (i falliti sono rimborsati); pagesSummarized = Σ document.pages dei job done
```

---

## Brief 1 — API (sonnet)

**Goal:** implementare nell'API tutto il contratto qui sopra, come descritto nella spec §2.1.

**Files:**
- `apps/api/src/documents/*`, `apps/api/src/jobs/*`, `apps/api/src/me.controller.ts`, `apps/api/src/storage/storage.service.ts`;
- un helper di paginazione condiviso: un DTO `PageQueryDto` e una funzione `page()`, in `apps/api/src/pagination.ts`;
- test in `apps/api/test/`.

Nessun file del web o del worker.

**Acceptance:**
- Tutti gli endpoint del contratto, con i codici di stato indicati. Le query sono validate con DTO `class-validator` e `@Type(() => Number)` di `class-transformer`; verifica che il `ValidationPipe` in `setup.ts` abbia `transform`.
- Paginazione con `skip`/`take` più un `count` con lo stesso `where`, dentro `$transaction([...])`.
- `DELETE /documents/:id`:
  - `$transaction` interattiva che prende `SELECT … FROM "User" … FOR UPDATE`, come `JobsService.create`, poi verifica ownership e assenza di job attivi (409);
  - raccoglie le chiavi S3: `s3Key` del documento più `resultMdKey` e `resultDocxKey` di tutti i suoi job;
  - chiama `storage.delete(keys)` e poi `document.delete`.

  Una chiave assente conta come cancellata. Se S3 dà errore, la richiesta risponde 5xx e il DB resta intatto. Le righe `CreditLedger` restano (`SetNull`).
- `DELETE /jobs/:id`: accetta solo `done` o `failed`, cancella i due oggetti S3 e poi la riga. Il ledger resta.
- `GET /jobs/:id/content`: `storage.get(resultMdKey)` con `Content-Type: text/markdown; charset=utf-8`. Il middleware di logging già esistente logga il path, e va bene.
- `StorageService`:
  - `get(key): Promise<Buffer>`;
  - `delete(keys: string[])` con `DeleteObjectsCommand`, a lotti di 1000 e ignorando le liste vuote, che lancia un errore se la risposta contiene `Errors`.
- Isolamento: 404 su risorse di altri utenti in tutti i nuovi endpoint.
- Log: rename, delete doc e delete job, con id utente e id risorsa.
- Test Jest:
  - rename valido e non valido (vuoto, 201 caratteri, con newline);
  - delete doc con job attivo dà 409; delete riuscito rimuove gli oggetti S3 (verificato con `storage.head` nullo) e lascia il ledger;
  - delete di un job `running` dà 409;
  - 404 cross-user su ogni nuovo endpoint;
  - paginazione: `total`, pagina oltre la fine con `items` vuoto, `pageSize` 0 e 101 danno 400, filtri `q`/`status` e ordinamento per `filename`;
  - `/me/stats` e `/me/ledger` con dati noti;
  - `content` dà 404 se il job non è `done`.

  Segui lo stile dei test esistenti in `apps/api/test/`.

**Verify:** `pnpm --filter @summarize/api build && pnpm --filter @summarize/api test`. Serve l'infra docker già avviata; il nome del filtro è da verificare in `apps/api/package.json`.

**Skills:** superpowers:test-driven-development.

---

## Brief 2 — Worker: consumi reali (sonnet)

**Goal:** spec §2.3. Una riga `LlmCall` per ogni chiamata al modello, riuscita o fallita; totali del job su tutti i tentativi; `Job.model` e `Job.durationMs`.

**Files:** `apps/worker/summarize_worker/{llm.py,pipeline.py,handlers.py,db.py}` e `apps/worker/tests/`. Non toccare API, web o schema: lo schema è già migrato.

**Acceptance:**
- Dopo ogni chiamata, riuscita o fallita, `call_model` o il suo chiamante riporta:
  - `phase`: `draft` o `verify`;
  - `chapter`: indice da 0;
  - `model`;
  - `inputTokens` e `outputTokens`: quelli riportati dallo stream, 0 se non disponibili;
  - `durationMs`;
  - `ok`.
- La riga va scritta con un `INSERT INTO "LlmCall"` in autocommit, fuori da ogni transazione di fine job, così sopravvive a crash e retry. `attempt` = `job["attempts"]`.
- Una chiamata fallita dopo tutti i retry interni di `call_model` è una riga con `ok = false`. Se i retry interni fanno più richieste HTTP, basta una riga per ogni chiamata logica di `call_model`, con i token noti. Documenta la scelta con un commento `ponytail:`.
- Canale di scrittura: un callback `on_call(record)` passato da `handle_summarize` a `summarize_chapters`, che non conosce il DB. Il callback non deve mai far fallire il job: un'eccezione di scrittura si logga come warning e si ignora.
- `finish_summary` imposta:
  - `inputTokens` e `outputTokens` = somma su `LlmCall` di quel job, su tutti i tentativi;
  - `model` = `settings.llm_model`;
  - `durationMs` = durata del tentativo riuscito.
- Anche sul fallimento definitivo (`_fail`) e su `fail()` i totali del job diventano la somma di `LlmCall` e `model` viene valorizzato se noto. Il rimborso resta invariato.
- La fencing esistente per `attempts` e le semantiche di charge e refund restano invariate. Questo è codice che tocca i soldi e la concorrenza: nessuna modifica a `claim`, `_done`, `recover_stale`, salvo aggiungere colonne negli `UPDATE`.
- Test pytest con `FakeClient` e il DB di test di `conftest.py`:
  - un job riuscito ha righe `LlmCall` per bozza e verifica di ogni capitolo, e `Job.inputTokens` è uguale alla somma;
  - un job che fallisce ha comunque le sue righe `LlmCall` e totali coerenti;
  - un errore nel callback non fa fallire il job.

**Verify:** `cd apps/worker && python -m pytest -q`. Serve l'infra docker; verifica in `conftest.py` il comando esatto e la venv.

**Skills:** superpowers:test-driven-development.

---

## Brief 3 — Web (sonnet)

**Goal:** spec §2.2 sul contratto API qui sopra: dashboard, `/documents`, `/jobs`, anteprima in `JobPage`, `/credits`, navigazione nell'header.

**Files:** `apps/web/src/**` e `apps/web/package.json`, con la nuova dipendenza `react-markdown` installata con `pnpm --filter <web> add react-markdown`. Nessun file dell'API o del worker.

**Acceptance:**
- `api.ts`:
  - tipi `Page<T>`, `JobWithDoc`, `LedgerEntry` e `Stats`;
  - un helper `qs(params)` che salta i valori vuoti.
- Il campo `credits` di `Doc` resta.
- **Dashboard (`/`):**
  - saldo;
  - le 4 statistiche di `/me/stats`;
  - job attivi da `/jobs?active=true`, con barra di progresso e link, con `refetchInterval` di 3000 solo se ce ne sono;
  - zona di upload invariata. Dopo un upload invalida `['documents']` e `['stats']`;
  - gli ultimi 5 documenti (`/documents?pageSize=5`), che vengono ricaricati ogni 3 secondi finché uno è in analisi. Riusa la logica `busy`/`docStatus` esistente;
  - link "Tutti i documenti".
- **`/documents`:**
  - ricerca con debounce di 300 ms;
  - select dello stato, ordinamento (data e nome, asc e desc) e paginazione Precedente/Successiva con "pagina X di Y";
  - lo stato dei filtri vive nei search params dell'URL (`useSearchParams`), così il back e il reload lo conservano;
  - rinomina in linea: bottone, input, invio o esc;
  - elimina con `window.confirm('Delete "<nome>" and all its summaries? This cannot be undone and used credits are not returned.')`;
  - dopo una mutazione invalida `['documents']` e `['stats']`;
  - gestione del 409 con un messaggio visibile.
- **`/jobs`:**
  - colonne documento, data, stile (`options.preset`), lunghezza (`options.fraction`, mostrato come `1/N`), lingua, stato e crediti;
  - filtri stato e stile nei search params;
  - paginazione;
  - eliminazione dei riassunti `done` o `failed` con confirm.
- **`JobPage`:** a job `done`, sotto i bottoni di download, carica `/api/jobs/:id/content` con `fetch`, non con `api()`, perché la risposta non è JSON, e lo renderizza con `<Markdown>` di react-markdown. Niente `rehype-raw` e nessun HTML grezzo. Tailwind non ha typography: aggiungi in `index.css` poche regole mirate per `h1`, `h2`, `h3`, `ul`, `ol`, `strong` e `p` dentro un contenitore `.prose-summary`.
- **`/credits`:** tabella del ledger paginata, con data, tipo, importo con segno e documento.
- **Header:** link Dashboard · Documents · Summaries · Credits, più saldo ed email come oggi.
- UI in inglese, come il resto dell'app attuale; l'i18n è nel rilascio 3.
- Nessun componente o libreria in più oltre a `react-markdown`. Riusa lo stile Tailwind esistente e il componente `Select` di `DocumentPage` se serve: spostalo in un file condiviso solo se lo usi davvero in due posti.

**Verify:** `pnpm --filter <web> build`, con typecheck e build vite puliti.

**Skills:** frontend-design, se disponibile, solo per coerenza visiva, senza redesign.
