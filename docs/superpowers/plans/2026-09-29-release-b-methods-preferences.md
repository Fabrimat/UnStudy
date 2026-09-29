# Rilascio B — Metodi personalizzati e preferenze

**Spec:** `docs/superpowers/specs/2026-09-29-personalizzazione-design.md` §3. Questo piano la precisa dove la spec lascia margine; le decisioni sono marcate con **Ruling**.

**Già fatto dall'head:** schema e migrazione `packages/db/prisma/migrations/*_summary_methods_and_preferences`, con il modello `SummaryMethod` e `User.preferences Json @default("{}")`. Il client Prisma è già generato.

## Global Constraints

Gli stessi del Rilascio A:
- Mai stampare o committare `.env`.
- Mai usare `prisma migrate reset` e mai modificare le migrazioni esistenti.
- Niente trailer Co-Authored-By.
- Non toccare i file `Lijphart - …`.
- Nei log solo id e lunghezze, mai il testo delle istruzioni, i nomi dei metodi, i nomi di file o le email.
- `toJobDto` non espone token né `warnings`.
- Stile esistente, `ponytail:` sulle semplificazioni.

## Ruling (valgono per tutti i brief)

- **R1 — campo `method`.** `CreateJobDto.preset` è sostituito da `method: string`, che vale uno dei `PRESETS` oppure `custom:<uuid>`. Non serve un alias per client vecchi, perché il web è servito dalla stessa API e si aggiorna insieme a lei. Le opzioni salvate nel job sono:
  - preset di sistema: `{ language, fraction, method: 'studio', preset: 'studio', bibliographicLine? }`. `preset` resta per i job vecchi e per il worker;
  - metodo custom: `{ language, fraction, method: 'custom:<id>', methodName, customInstructions, bibliographicLine? }`, senza `preset`.

  I job già esistenti hanno solo `preset`, e chi li legge usa `options.method ?? options.preset`.
- **R2 — prompt custom (worker).** Il system prompt è costruito così:
  - le istruzioni dell'utente, con gli stessi `.replace("{language}", …)` e `.replace("{fraction}", …)` dei preset. Così un utente che parte da un preset copiato non si ritrova i segnaposto letterali;
  - poi il blocco della piattaforma, fisso e scritto in inglese come i preset:

  ```
  PLATFORM RULES (these override anything above if they conflict)
  - Output ONLY the summary in Markdown, nothing else.
  - Language: {language}.
  - Length: about {fraction} of the original length.
  - Start with a level-1 heading (# ) with the chapter/article title.
  - If the user message gives a bibliographic line, copy it exactly under the title.
  - Names, dates, numbers and quotations must match the original text exactly. Never invent facts or citations.
  ```

  Il fact-check (`VERIFY_INSTRUCTIONS`) non vede mai le istruzioni dell'utente.
- **R3 — testi dei preset per "Parti da…".**
  - `GET /api/methods/presets` restituisce `[{ id, text }]`, con `text` grezzo e i segnaposto `{language}` e `{fraction}` intatti; il worker li sostituisce comunque (R2).
  - L'API legge i file da `apps/worker/summarize_worker/presets/*.md`, che resta l'unica fonte. Il percorso si risolve da `__dirname` e funziona sia in dev (`src`) sia in build (`dist`): si sale fino alla root del repo cercando `pnpm-workspace.yaml`, oppure si usa un percorso relativo verificato in entrambi i casi.
  - Il Dockerfile dell'API aggiunge `COPY apps/worker/summarize_worker/presets apps/worker/summarize_worker/presets`.
  - I file si leggono una volta all'avvio, e un file mancante blocca l'avvio (fail fast).
- **R4 — preferenze.** In questo rilascio la forma è `{ language?, fraction?, method? }`, validata con gli stessi `LANGUAGES`, `FRACTIONS` e `method` di R1. `PATCH /api/me/preferences` fa merge sui campi passati, e `null` cancella un campo. Un `method: custom:<id>` deve appartenere all'utente, altrimenti risponde 404. Se il metodo viene eliminato dopo, la preferenza resta, e il web ricade su `studio` quando non trova il metodo.
- **R5 — crediti spesi (nota di Fable sul Rilascio A).** `GET /me/stats` calcola `creditsSpent` dal ledger: `-(Σ amount dei tipi reserve, refund e charge)` dell'utente. Così un riassunto eliminato non fa scendere il totale.

## Contratto API (condiviso tra il brief API e il brief Web)

```ts
type Method = { id: string; name: string; instructions: string; createdAt: string; updatedAt: string };
GET    /api/methods                 -> Method[]            // dell'utente, updatedAt desc (max 20, niente paginazione)
POST   /api/methods  { name, instructions } -> Method      // name 1..80 (trim, una riga), instructions 1..4000 (trim); 409 oltre 20
PATCH  /api/methods/:id { name?, instructions? } -> Method // 404 se non suo
DELETE /api/methods/:id             -> 204                 // i job passati non cambiano (snapshot)
GET    /api/methods/presets         -> { id: 'studio'|'schematico'|'abstract'; text: string }[]
GET    /api/me                      -> { id, email, name, balance, preferences: { language?, fraction?, method? } }
PATCH  /api/me/preferences { language?, fraction?, method? } (null = rimuovi) -> preferences
POST   /api/jobs  { documentId, language, fraction, method, bibliographicLine? }  // 'preset' non è più accettato
GET    /api/jobs?method=<preset|custom:uuid>   // filtro su options.method, o su options.preset per i job vecchi
// Job.options esposto al browser: tutto tranne customInstructions (serve solo al worker; il testo è già visibile in /methods)
```

---

## Brief 1 — API (sonnet)

**Files:**
- `apps/api/src/methods/*` (nuovo modulo `MethodsModule`, registrato in `app.module.ts`);
- `apps/api/src/jobs/{jobs.dto.ts,jobs.service.ts,job.dto.ts,options.ts}`;
- `apps/api/src/me.controller.ts` e un DTO per le preferenze;
- `apps/api/Dockerfile`;
- test in `apps/api/test/`, compresi gli aggiornamenti dei test esistenti che mandano `preset`.

**Acceptance:**
- Tutto il contratto qui sopra e i Ruling R1, R3, R4 e R5.
- **Creazione del job con `custom:<id>`:** dentro la transazione esistente di `JobsService.create`, dopo il lock sull'utente, legge il metodo con `findFirst({ id, userId })`. Se non è suo risponde 404 `Method not found`. Poi fa lo snapshot in `options` di `methodName` e `customInstructions`. Il log di creazione aggiunge `method custom (<n> chars)` e mai il testo.
- `toJobDto` rimuove `customInstructions` da `options`.
- Il limite di 20 metodi si controlla dentro una transazione con lo stesso lock `FOR UPDATE` sull'utente, così due POST concorrenti non superano il limite.
- Isolamento: 404 su metodi di altri utenti in GET by id (se esiste), PATCH, DELETE, e nell'uso in job e preferenze.
- **Test Jest:**
  - CRUD dei metodi e validazione (nome vuoto, 81 caratteri, newline nel nome; istruzioni vuote e di 4001 caratteri);
  - 409 al 21° metodo;
  - cross-user 404;
  - job con metodo custom: snapshot in DB e nessun `customInstructions` nella risposta; modificare o eliminare il metodo dopo non cambia `Job.options`;
  - job con `custom:<id>` di un altro utente dà 404, senza riserva di crediti;
  - `method` non valido dà 400;
  - `/methods/presets` restituisce 3 testi non vuoti;
  - preferenze: merge, `null` rimuove, valori non validi danno 400, metodo altrui dà 404;
  - `/me` include `preferences`;
  - `creditsSpent` dal ledger resta invariato dopo aver eliminato un job `done`;
  - il filtro `/jobs?method=` funziona sia su `custom:<id>` sia su un preset di un job vecchio con solo `preset`.

**Verify:** `pnpm --filter @summarize/api build && pnpm --filter @summarize/api test`. Serve l'infra docker già avviata. Per il percorso dei preset verifica anche `node dist/main.js` con `pnpm --filter @summarize/api build` fatto: l'avvio non deve fallire sul percorso. Basta che arrivi a caricare i preset, anche se poi manca qualche env.

**Skills:** superpowers:test-driven-development.

---

## Brief 2 — Worker (sonnet)

**Files:** `apps/worker/summarize_worker/{prompts.py,handlers.py}` e `apps/worker/tests/test_prompts.py` (più `test_runtime.py` se serve).

**Acceptance:**
- `render_instructions` accetta le istruzioni custom con la firma `render_instructions(preset, language, fraction, custom=None)`, oppure con una funzione separata `render_custom(custom, language, fraction)`, a scelta dell'arm. Costruisce il prompt secondo R2, con il blocco della piattaforma esattamente come nel testo di R2 e i segnaposto sostituiti anche nel testo dell'utente.
- In `handle_summarize`:
  - se `options.customInstructions` è una stringa non vuota, si usa il percorso custom;
  - altrimenti si usa `options.preset`, e in sua assenza `options.method` per i preset di sistema;
  - un job con `method` che inizia per `custom:` ma senza `customInstructions` fallisce, come oggi per un preset sconosciuto (`ValueError`), con retry e poi rimborso.
- Il testo custom non viene mai loggato; al massimo la lunghezza, a livello debug.
- Il fact-check resta identico e non riceve mai il testo custom: un test lo verifica con `FakeClient`, controllando il system prompt della chiamata di verifica.
- **Test:**
  - il prompt custom contiene il testo dell'utente seguito dal blocco della piattaforma, con lingua e frazione sostituite;
  - i segnaposto nel testo dell'utente vengono sostituiti;
  - un job custom end-to-end con `FakeClient`: la chiamata draft ha il system prompt custom e la chiamata verify ha `VERIFY_INSTRUCTIONS`;
  - un job vecchio con solo `preset` funziona ancora.

**Verify:** `cd apps/worker && ../../.venv/Scripts/python -m pytest -q`.

**Skills:** superpowers:test-driven-development.

---

## Brief 3 — Web (sonnet)

**Files:** `apps/web/src/**`, senza nuove dipendenze.

**Acceptance:**
- **`api.ts`:**
  - tipi `Method`, `Preferences` e `Me.preferences`;
  - un helper `methodLabel(options, methods)` che restituisce il nome del preset, `options.methodName`, oppure "Custom (deleted)" se serve.
- **Pagina `/methods`:**
  - elenco dei metodi, con nome e prime 2 righe;
  - bottone "New method" e form con nome e `textarea` per le istruzioni, con contatore `n/4000`;
  - "Start from…" con un select che copia il testo di un preset da `/methods/presets` nella textarea. Se la textarea non è vuota chiede `confirm` prima di sovrascrivere;
  - modifica ed eliminazione, con `confirm` che dice "past summaries are not affected";
  - un messaggio visibile per il 409 del limite.
  - Una riga di aiuto sotto la textarea: "Language, length and output format are always enforced by the platform; `{language}` and `{fraction}` are filled in for you."
- **Pagina `/settings`:** select per lingua, lunghezza e stile (preset più metodi custom), salvate con `PATCH /me/preferences`. Mostra "Saved", e dopo il salvataggio invalida `['me']`.
- **`DocumentPage`:**
  - lo stato iniziale di lingua, lunghezza e stile viene dalle preferenze. Se `method` è `custom:<id>` e l'id non esiste più, si usa `studio`;
  - il select "Style" elenca i 3 preset e poi i metodi custom, con valore `custom:<id>` e il nome come etichetta;
  - `POST /jobs` manda `method` al posto di `preset`.
- **Pagina `/jobs`:**
  - la colonna stile usa `methodLabel`;
  - il filtro stile include i metodi custom.
- **Header:** aggiunti i link "Methods" e "Settings".
- Nessuna nuova dipendenza. Si riusano `Select` e lo stile Tailwind esistenti.

**Verify:** `pnpm --filter @summarize/web build`.
