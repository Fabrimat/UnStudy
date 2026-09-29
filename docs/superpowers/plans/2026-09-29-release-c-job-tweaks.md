# Rilascio C — Tweak dei job

**Spec:** `docs/superpowers/specs/2026-09-29-personalizzazione-design.md` §4. Questo piano la precisa dove la spec lascia margine; le decisioni sono marcate con **Ruling**. Nessuna migrazione: tutto vive in `Job.options` (Json) e `User.preferences` (Json).

## Global Constraints

- Mai stampare o committare `.env` e mai ripeterne i valori.
- Mai usare `prisma migrate reset`, e nessuna migrazione in questo rilascio.
- Niente trailer Co-Authored-By.
- Non toccare i file `Lijphart - …`.
- Nei log solo id, numeri e lunghezze: mai testo delle istruzioni, nomi di file o email.
- Stile esistente, file piccoli, `ponytail:` sulle semplificazioni.
- Non committare: il commit lo fa l'head.

## Ruling (valgono per tutti i brief)

- **R1 — lunghezza.**
  - `CreateJobDto.fraction` è sostituito da `lengthPercent`: intero da 5 a 50. L'API scrive solo `lengthPercent` in `options`.
  - Il worker legge `opts.get("lengthPercent")`, oppure `round(100 / opts["fraction"])` per i job vecchi.
  - Il testo di lunghezza nei prompt è `f"{p}%"`.
  - I preset usano `{length}` al posto di `{fraction}` (esempio: "to about {length} of the original length" → "to about 20% of the original length"). Nel testo custom dell'utente si sostituiscono sia `{length}` sia `{fraction}`, per i metodi salvati nel Rilascio B.
  - `PLATFORM_RULES` usa "Length: about {length} of the original length.".
  - Il prompt utente per capitolo diventa `Target length: about {target} words ({p}% of the original).` con `target = chapter.words * p // 100`.
  - `run_checks` riceve `length_percent` al posto di `fraction`, e `FRACTION_NAMES` sparisce.
  - Valori rapidi del web: 33 (≈1/3), 20 (1/5), 10 (1/10). Il default è 33.
- **R2 — capitoli.**
  - `chapters?: number[]`: interi ≥ 0, unici, almeno 1, e ciascuno `< (doc.chapters as array).length`; altrimenti 400. L'API li salva ordinati in `options.chapters`.
  - Se `chapters` manca, vuol dire "tutti" e non si salva niente.
  - Se `doc.chapters` non è un array (documenti vecchi) e `chapters` è presente, risponde 400.
  - `words = Σ chapters[i].words` dei capitoli scelti (tutto `doc.words` se "tutti").
  - **Worker:**
    - tiene il controllo `Σ words == doc.words` su tutto il documento;
    - poi, se `len(chapters) != len(doc["chapters"])`, scatta `FileChanged`;
    - infine filtra per indice.
- **R3 — extra.**
  - `extras?: ('glossary'|'questions'|'takeaways')[]`, unici; un valore non valido dà 400. Si salva in `options.extras` solo se non vuoto.
  - Il worker aggiunge alle istruzioni, sia preset sia custom e dopo tutto il resto, un blocco fisso in inglese:
    ```
    EXTRA SECTIONS
    At the end of the summary add these sections, with headings written in the output language:
    - Glossary: the key terms with a one-line definition each.            (glossary)
    - Review questions: 5 exam-style questions on this text, without answers.   (questions)
    - Key takeaways: 3 to 5 bullet points.                                (takeaways)
    ```
    Contiene solo le righe scelte, nell'ordine fisso glossary, questions, takeaways, e senza le etichette tra parentesi.
  - Il fact-check non cambia: vede le sezioni come parte della bozza.
- **R4 — catalogo modelli (`LLM_MODELS`).**
  - Forma: JSON `[{ id, label, model, multiplier }]` con `id` che rispetta `^[a-z0-9-]{1,32}$` e unico, `label` e `model` stringhe non vuote, `multiplier` numero `> 0` e `≤ 100`. Il primo elemento è il default.
  - **Env assente o vuota:** catalogo di una voce `{ id: 'default', label: 'Default', model: LLM_MODEL, multiplier: 1 }`. Serve per la compatibilità con il deploy attuale, dove `LLM_MODELS` non è impostata. L'API, che non conosce `LLM_MODEL`, usa `process.env.LLM_MODEL ?? 'default'` come `model`, e non lo espone mai.
  - **Env presente ma non valida** (JSON rotto, array vuoto, voce non valida, id duplicato): errore all'avvio, sia nell'API (`config.ts`) sia nel worker (`config.py`).
  - **API:**
    - `GET /api/models` restituisce `{ id, label, multiplier }[]`;
    - `CreateJobDto.model?`: un id del catalogo, altrimenti 400; se manca vale il primo;
    - `options` salva `modelId` (id del catalogo) e `model` (id del provider).
  - **Crediti:** `const m100 = Math.round(multiplier * 100); credits = Math.max(1, Math.ceil(creditsFor(words) * m100 / 100))`, in aritmetica intera per evitare `ceil(11.000000000000002)`. La funzione sta in `credits/credits.ts` con un nome tipo `creditsForJob(words, multiplier)`.
  - `toJobDto` rimuove anche `options.model`, cioè l'id del provider: il browser vede solo `modelId`.
  - **Worker:**
    - se `options.modelId` è presente, lo cerca nel proprio catalogo e usa il `model` del **proprio** catalogo, mai `options.model`;
    - un id sconosciuto fa fallire il job senza retry e con rimborso, come `FileChanged`;
    - senza `modelId` (job vecchi) usa `LLM_MODEL` se impostata, altrimenti `catalog[0].model`;
    - il modello risolto è quello registrato in `LlmCall`, `finish_summary` e `fail*`.
  - `LLM_MODEL` diventa opzionale nel worker quando `LLM_MODELS` è impostata, e resta obbligatoria quando non lo è.
- **R5 — preferenze.**
  - `PreferencesDto` aggiunge `lengthPercent` (5–50) e `model` (id del catalogo, altrimenti 400), sempre con `null` che rimuove.
  - `fraction` resta accettato, perché serve `null` per ripulirlo. Il web scrive solo `lengthPercent` e manda `fraction: null` insieme.
  - Se la preferenza `model` non è più nel catalogo, il web ricade sul primo modello.
- **R6 — rigenera e file cancellato.** `toDocDto` aggiunge `fileDeleted: boolean` (`!!doc.fileDeletedAt`). La rigenerazione vive tutta nel web e usa `POST /jobs` come oggi.

## Contratto API (condiviso)

```ts
GET  /api/models -> { id: string; label: string; multiplier: number }[]   // ordine del catalogo, [0] = default
POST /api/jobs { documentId, language, lengthPercent /*5..50*/, method, chapters?: number[], extras?: ('glossary'|'questions'|'takeaways')[], model?: string, bibliographicLine? }
     // credits = creditsForJob(Σ words scelti, multiplier)
     // options salvato: { language, lengthPercent, method, preset?, methodName?, customInstructions?, chapters?, extras?, modelId, model, bibliographicLine? }
     // options esposto: senza customInstructions e senza model
Doc: + fileDeleted: boolean       // chapters resta: [{ title, pageFrom, pageTo, words }]
Preferences: { language?, lengthPercent?, method?, model?, fraction? /*legacy, sola lettura*/ }
```

---

## Brief 1 — API (sonnet)

**Files:**
- `apps/api/src/config.ts` (catalogo);
- `apps/api/src/credits/credits.ts`;
- `apps/api/src/jobs/{jobs.dto.ts,jobs.service.ts,job.dto.ts,options.ts}`;
- un `models.controller.ts` registrato in un modulo esistente o nuovo;
- `apps/api/src/preferences.dto.ts` e `me.controller.ts` se serve;
- `apps/api/src/documents/documents.service.ts` (solo `fileDeleted` in `toDocDto`);
- `.env.example` (una riga commentata che documenta `LLM_MODELS`);
- test in `apps/api/test/`, compresi gli aggiornamenti dei test che mandano `fraction`.

**Acceptance:** i Ruling R1–R6 lato API e il contratto qui sopra. Il parse del catalogo sta in una funzione pura esportata (per esempio `parseModels(raw, fallbackModel)`), testabile senza riavviare il processo.

**Test Jest:**
- crediti con un sottoinsieme di capitoli e con il moltiplicatore, compreso un caso `1.1` che non arrotonda per eccesso in modo sbagliato;
- capitoli fuori range, duplicati, vuoti o negativi danno 400;
- extra non valido, `lengthPercent` 4 e 51, `fraction` al posto di `lengthPercent` e `model` sconosciuto danno 400;
- `GET /models` senza il campo `model`;
- job DTO senza `options.model`;
- `parseModels` con JSON rotto, array vuoto, id duplicato e multiplier 0 lancia errore; env assente dà il fallback `default`;
- preferenze `lengthPercent` e `model` valide e non valide;
- `fileDeleted` presente nel documento.

**Verify:** `pnpm --filter @summarize/api build && pnpm --filter @summarize/api test`. Serve l'infra docker già avviata.

**Skills:** superpowers:test-driven-development.

---

## Brief 2 — Worker (sonnet)

**Files:**
- `apps/worker/summarize_worker/{config.py,prompts.py,pipeline.py,checks.py,handlers.py}`;
- `apps/worker/summarize_worker/presets/*.md` (solo `{fraction}` → `{length}`);
- `__main__.py` se il log d'avvio usa `llm_model`;
- `apps/worker/tests/`.

**Acceptance:** i Ruling R1–R4 lato worker.
- `Settings` ottiene un catalogo `models` (lista di id e model), parsato con fail fast.
- Il testo custom non viene mai loggato.
- `claim`, `_done`, `recover_stale` e la semantica di charge e refund non cambiano.
- Il fallimento per modello sconosciuto usa lo stesso percorso di `FileChanged`: `db.fail`, senza retry.

**Test pytest:**
- filtro dei capitoli: solo i capitoli scelti vanno al modello;
- mismatch del numero di capitoli dà `FileChanged` e rimborso;
- blocco degli extra presente, nell'ordine fisso, e assente senza extra;
- `lengthPercent` e il vecchio `fraction` (5 → 20%) nei prompt e nel target di parole;
- `{length}` e `{fraction}` sostituiti nel testo custom;
- `modelId` conosciuto usa il model del catalogo del worker anche se `options.model` dice altro;
- `modelId` sconosciuto dà fallimento rimborsato senza retry e nessuna chiamata al modello;
- parse di `LLM_MODELS` non valido lancia errore.

**Verify:** `cd apps/worker && ../../.venv/Scripts/python -m pytest -q`.

**Skills:** superpowers:test-driven-development.

---

## Brief 3 — Web (sonnet)

**Files:** `apps/web/src/**`, senza nuove dipendenze. Non toccare `index.css`, che l'head ha già modificato (regola del cursore).

**Acceptance:**
- **`api.ts`:**
  - tipi aggiornati: `Doc.fileDeleted`, `Preferences` di R5, `Model`;
  - un hook `useModels()` su `['models']`;
  - un helper `creditsForJob(words, multiplier)` identico a R4 (`WORDS_PER_CREDIT` = 1000; `Math.max(1, Math.ceil(words/1000))`, poi il moltiplicatore in aritmetica intera);
  - un helper `lengthLabel(options)` che restituisce `N%` oppure `1/N` per i job vecchi.
- **`DocumentPage`:**
  - checkbox per capitolo, con titolo, pagine e parole, e i link "All" e "None". Con zero capitoli selezionati il bottone Start è disabilitato. Se sono tutti selezionati si omette `chapters` dalla richiesta;
  - slider `input type=range` da 5 a 50, con i bottoni rapidi 1/3=33, 1/5=20, 1/10=10 e il testo "≈ N words" calcolato sui capitoli scelti;
  - checkbox degli extra;
  - select "Model", mostrato solo se il catalogo ha più di un modello, con etichetta `label (×multiplier)` quando multiplier ≠ 1;
  - costo in tempo reale con `creditsForJob`;
  - stato iniziale dalle preferenze (`lengthPercent`, oppure `round(100/fraction)`, oppure 33; `model`).
- **`?from=<jobId>`:** `DocumentPage` carica quel job (`GET /api/jobs/:id`) e precompila lingua, lunghezza, metodo, capitoli, extra, modello e `bibliographicLine`. I valori non più validi, come un metodo eliminato o un modello uscito dal catalogo, ricadono sul default.
- **`JobPage`:** bottone "Regenerate with other options" per i job `done` o `failed`, che porta a `/documents/<documentId>?from=<jobId>`. È disabilitato con un tooltip se il documento ha `fileDeleted`.
- **`Settings`:** lunghezza con lo stesso slider e i bottoni rapidi, che salva `{ lengthPercent, fraction: null }`, e select del modello se il catalogo ha più di un modello.
- **`Jobs.tsx`:** la colonna lunghezza usa `lengthLabel`.
- **`Methods.tsx`:** il testo d'aiuto dice `{language}` e `{length}` al posto di `{fraction}`.
- Riusa `Select` e lo stile esistente.

**Verify:** `pnpm --filter @summarize/web build`.
