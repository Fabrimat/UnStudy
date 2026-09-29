# Summarize — browser, dashboard e personalizzazione

Data: 2026-09-29 · Stato: scelte fatte dall'utente in chat, in revisione come spec · Segue `2026-09-28-summarize-platform-design.md`

## 1. Obiettivo

Dopo il nucleo, dare all'utente il controllo su ciò che ha caricato e su come viene riassunto.

**Scelte dell'utente:**
- **Metodi di riassunto personalizzati:** istruzioni libere salvate e riutilizzabili. Toglie dal "fuori scope MVP" della spec del nucleo la voce "istruzioni libere dell'utente".
- **Tweak:**
  - selezione dei capitoli;
  - preferenze predefinite;
  - extra nell'output;
  - rigenerazione con altre opzioni.
- **Browser:**
  - eliminazione;
  - rinomina;
  - ricerca e filtri;
  - anteprima del riassunto.
- **Organizzazione:** una spec unica con tre rilasci, ognuno con il proprio piano.
- **Aggiunte dopo la prima revisione:**
  - paginazione lato server;
  - lunghezza del riassunto più flessibile;
  - registrazione per ogni job dei crediti e dei token IA effettivamente usati, per le statistiche future;
  - scelta del modello IA tra alcuni pre-selezionati dalla piattaforma.

**Fuori scope:**
- cartelle e tag;
- condivisione dei metodi tra utenti;
- modifica manuale della divisione in capitoli;
- eliminazione dell'account (resta nel rilascio 3 del nucleo);
- esporre i token all'utente: restano dati interni, come oggi per `toJobDto`.

## 2. Rilascio A — Browser e dashboard

### 2.1 API

| Endpoint | Comportamento |
|---|---|
| `GET /documents` | Paginato lato server (vedi sotto). Filtri: `q` (nome, `contains` case-insensitive), `status` (`analyzing` \| `ready` \| `rejected` \| `summarized`). Ordinamento `sort` con valori `createdAt` o `filename` e direzione `order` con valori `asc` o `desc`. Ogni documento porta i suoi job di riassunto. |
| `PATCH /documents/:id` | Body `{ filename }`: da 1 a 200 caratteri, una sola riga. Cambia solo il nome visualizzato, non la chiave S3. Il nome del file scaricato ne deriva già. |
| `DELETE /documents/:id` | Risponde 409 se il documento ha job `queued` o `running`. Altrimenti, nell'ordine: prende il lock `FOR UPDATE` sulla riga `User`, come fa `JobsService.create`, così nessun job può nascere durante l'eliminazione; cancella da S3 il PDF e i risultati di tutti i job; cancella `Document`, e i `Job` a cascata. Le righe `CreditLedger` restano, perché `jobId` è `SetNull`. Risponde 204. |
| `GET /jobs` | Paginato. Restituisce i job `summarize` dell'utente con `document: { id, filename }`, usando `toJobDto` più il campo `document`. Filtri: `status`, `method`, `documentId`, `active=true` (solo `queued` e `running`, per la dashboard). Ordinamento per `createdAt desc`. |
| `DELETE /jobs/:id` | Risponde 409 se il job non è `done` né `failed`. Altrimenti cancella da S3 `.md` e `.docx` e poi la riga `Job`. Risponde 204. |
| `GET /jobs/:id/content` | Il Markdown del riassunto, come `text/markdown`, letto da S3 lato server così non serve CORS. Risponde 404 se il job non è pronto. |
| `GET /me/ledger` | Paginato, dal più recente: `{ type, amount, createdAt, jobId, filename? }`. |
| `GET /me/stats` | `{ documents, summariesDone, creditsSpent, pagesSummarized }`, calcolati con aggregate Prisma. |

- **Paginazione, uguale per le tre liste:**
  - parametri `page` (da 1) e `pageSize` (1–100, default 20);
  - risposta `{ items, total, page, pageSize }`;
  - query con `skip`/`take` e un `count` con lo stesso `where`;
  - validazione con DTO `class-validator` (`@Type(() => Number)`), quindi 400 sui valori non validi;
  - `ponytail:` offset e non cursore, perché serve anche l'ordinamento per nome e i volumi per utente sono piccoli. Se una lista supera le decine di migliaia di righe si passa a keyset su `(createdAt, id)`;
  - indice aggiunto `Job(userId, kind, createdAt)`.
- **Ordine delle cancellazioni:** prima S3, poi il DB. Se S3 fallisce la richiesta risponde 5xx e il DB resta intatto, quindi si può ritentare. Se lo storage non trova un oggetto, conta come cancellato.
- `StorageService` riceve i metodi `get(key)` e `delete(keys[])`, basati su `DeleteObjects`.
- **Isolamento:** ogni endpoint risponde 404 su risorse di altri utenti, come oggi con `findOwned`.
- Ogni azione viene loggata con il pattern esistente: id utente e id risorsa, mai i nomi dei file.

### 2.2 Web

- **Dashboard (`/`):**
  - saldo;
  - le 4 statistiche di `/me/stats`;
  - i job attivi con barra di avanzamento, aggiornati con polling ogni 3 secondi solo finché ce ne sono;
  - la zona di upload, invariata;
  - gli ultimi 5 documenti, con il link al browser.
- **Browser dei file (`/documents`):**
  - una tabella con nome, data, pagine, stato e numero di riassunti;
  - ricerca per nome;
  - filtro per stato (in analisi, pronto, rifiutato, con riassunti);
  - ordinamento per data o nome;
  - rinomina in linea;
  - eliminazione con `confirm()` che dice "irreversibile, i crediti usati non tornano".
- **Browser dei job (`/jobs`):**
  - documento, data, metodo, lunghezza, lingua, stato e crediti;
  - filtri per stato e metodo;
  - l'eliminazione di un riassunto concluso.
- **Anteprima:** `JobPage`, a job concluso, mostra il Markdown renderizzato con `react-markdown`, nuova dipendenza e unica aggiunta al web. È un renderer puro, senza HTML grezzo, quindi niente XSS dal testo dell'LLM.
- **Crediti (`/credits`):** tabella dei movimenti del ledger.
- **Header:** navigazione Dashboard · Documenti · Riassunti · Crediti.

### 2.3 Consumi reali per job (migrazione)

Scopo: statistiche future su costi e margini. Sono dati interni e non vanno mai al browser.

- **`LlmCall`**, nuovo modello, una riga per ogni chiamata al modello:
  - campi: `id`, `jobId` (cascade), `attempt`, `chapter` (indice), `phase` (`draft` | `verify`), `model`, `inputTokens`, `outputTokens`, `durationMs`, `ok` (bool), `createdAt`;
  - indici su `jobId` e su `(model, createdAt)`.
- **Scrittura:** il worker scrive la riga subito dopo ogni chiamata, riuscita o fallita, con i token che l'API ha riportato. Così i token dei tentativi falliti e dei job rimborsati non si perdono più, mentre oggi `Usage` si salva solo a job riuscito.
- **Totali sul job:**
  - `Job.inputTokens` e `Job.outputTokens` diventano la somma di tutti i tentativi;
  - il nuovo `Job.model` registra il modello usato;
  - il nuovo `Job.durationMs` registra la durata dell'elaborazione.
- **Crediti effettivi:** nessuna colonna nuova, perché il ledger li registra già in append. Il valore è `Job.credits` meno l'eventuale `refund` dello stesso job. `/me/stats` ed eventuali query admin lo ricavano così.
- **Interruzioni:** la scrittura di `LlmCall` è fuori dalla transazione di fine job. Se il worker muore a metà, le righe già scritte restano, ed è quello che vogliamo.

### 2.4 Test

- API (Jest):
  - rinomina con valori validi e non validi;
  - eliminazione rifiutata con 409 se c'è un job attivo;
  - eliminazione riuscita: gli oggetti S3 spariscono e il ledger resta;
  - 404 cross-user su tutti i nuovi endpoint;
  - `/me/stats` con dati noti;
  - `content` con 404 se il job non è pronto;
  - paginazione: `total`, `page` oltre la fine che restituisce `items` vuoto, 400 su `pageSize` 0 o 101, filtri e ordinamento per nome.
- Worker: una riga `LlmCall` per ogni chiamata, anche quando il job fallisce, e totali del job uguali alla somma delle righe.
- Web: build pulita.

## 3. Rilascio B — Metodi personalizzati e preferenze

### 3.1 Dati (migrazione)

- **`SummaryMethod`**, nuovo modello:
  - campi: `id`, `userId` (cascade), `name` (1–80), `instructions` (1–4000 caratteri), `createdAt`, `updatedAt`;
  - indice su `userId`;
  - al massimo 20 metodi per utente.
- **`User.preferences`**: `Json @default("{}")`, con forma `{ language?, lengthPercent?, method?, model?, extras? }`. `lengthPercent`, `model` ed `extras` diventano attivi con il rilascio C.

### 3.2 Job

- Le opzioni del job accettano `method`, che vale un preset di sistema (`studio` | `schematico` | `abstract`) oppure `custom:<uuid>`. `preset` resta valido come alias, per i job già esistenti.
- **Snapshot:** alla creazione di un job custom, `api` copia `instructions` e `name` dentro `Job.options` (`customInstructions`, `methodName`). Così modificare o eliminare il metodo non cambia i job in corso né lo storico, e il worker non fa join.
- **Worker:**
  - Con `customInstructions`, il system prompt diventa: le istruzioni dell'utente, poi un blocco della piattaforma non modificabile con lingua, lunghezza target e formato Markdown con titoli per capitolo.
  - Fact-check, `fix_format` e `run_checks` restano identici.
  - Le istruzioni dell'utente non raggiungono mai il prompt di fact-check.
- **Trust boundary:** il testo dell'utente finisce solo nel suo job e lo paga lui in crediti. Il rischio è l'uso dell'LLM come chatbot generico; il limite di 4000 caratteri e il prezzo per parola del documento lo contengono. Si logga la lunghezza delle istruzioni, mai il loro testo.

### 3.3 API e Web

- `GET/POST /methods`, `PATCH/DELETE /methods/:id`.
- `PATCH /me/preferences` con validazione per campo. `GET /me` include `preferences`.
- **Pagina `/methods`:**
  - elenco, creazione e modifica dei metodi;
  - "Parti da…" copia il testo di un preset di sistema. `api` espone `GET /methods/presets` con i testi dei 3 preset, letti da `apps/worker/summarize_worker/presets/*.md`, che vengono copiati nel build dell'API e restano l'unica fonte.
- **Pagina `/settings`:** le preferenze predefinite.
- `DocumentPage` precompila le opzioni dalle preferenze, e il selettore "Style" elenca preset e metodi personalizzati.

### 3.4 Test

- API:
  - CRUD con isolamento tra utenti;
  - limite di 20 metodi;
  - snapshot nelle opzioni;
  - `custom:<id>` di un altro utente dà 404;
  - validazione delle preferenze.
- Worker: `render_instructions` con istruzioni custom contiene il blocco della piattaforma.

## 4. Rilascio C — Tweak dei job

### 4.1 Selezione dei capitoli

- `CreateJobDto.chapters?: number[]`: indici unici, ordinati, dentro `Document.chapters`. Se manca, vale "tutti".
- I crediti diventano `creditsFor(Σ words dei capitoli scelti)`. È un cambiamento del percorso dei soldi, quindi va coperto da test.
- **Worker:** rilegge i capitoli come oggi e mantiene il controllo anti-manomissione su tutto il documento (`Σ words == doc.words`). Poi filtra per indice. Se il numero dei capitoli differisce da `Document.chapters`, scatta `FileChanged`.
- **Web:** checkbox per capitolo, "tutti/nessuno" e il costo aggiornato in tempo reale.

### 4.2 Extra nell'output

- `extras?: ('glossary' | 'questions' | 'takeaways')[]`.
- Si aggiungono alle istruzioni come blocco della piattaforma: "alla fine di ogni capitolo aggiungi le sezioni …". Il fact-check le vede come parte del riassunto e le verifica come il resto.
- Nessun sovrapprezzo: il costo è dominato dall'input. Da rivedere con i dati dei token in `Job`.

### 4.3 Rigenera con altre opzioni

- Su `JobPage` c'è "Rigenera con altre opzioni" per i job `done` o `failed`. Porta a `/documents/:id?from=<jobId>`, che precompila le opzioni da quel job, compresi capitoli ed extra.
- Nessun endpoint nuovo: è un nuovo `POST /jobs`.
- Il bottone è disabilitato se il PDF è già stato cancellato dalla retention (`fileDeletedAt`).

### 4.4 Lunghezza flessibile

- `fraction` (3 | 5 | 10) viene sostituito da `lengthPercent`: un intero da 5 a 50.
- **Web:** slider con i valori rapidi 1/3, 1/5 e 1/10 e l'anteprima "≈ N parole", calcolata sui capitoli scelti.
- **Worker:**
  - il prompt dice "about N% of the original (≈ W words)";
  - `{fraction}` nei preset diventa `{length}`;
  - `run_checks` usa il rapporto al posto della frazione;
  - `FRACTION_NAMES` sparisce.
- **Compatibilità:** i job esistenti con `fraction` valgono `round(100 / fraction)`. Il worker accetta entrambe le forme, e l'API scrive solo `lengthPercent`.
- **Crediti:** invariati, perché il prezzo è per parola in input. `ponytail:` un riassunto al 50% costa più token in output; si rivede con i dati di `LlmCall`.

### 4.5 Scelta del modello

- **Catalogo:**
  - lo definisce la piattaforma nella env var `LLM_MODELS`, condivisa tra api e worker, con un JSON: `[{ "id": "fast", "label": "Veloce", "model": "<provider model id>", "multiplier": 1 }, …]`;
  - il primo elemento è il default;
  - un JSON non valido o vuoto blocca l'avvio (fail fast, come `LOG_LEVEL`);
  - tutti i modelli passano dallo stesso endpoint OpenAI-compatibile (`LLM_BASE_URL`). `ponytail:` più provider si aggiungono con `baseUrl` per voce quando servono.
- **API:**
  - `GET /models` restituisce `{ id, label, multiplier }`, senza il model id del provider;
  - `CreateJobDto.model?` accetta un `id` del catalogo;
  - i crediti diventano `ceil(creditsFor(parole scelte) × multiplier)`;
  - il job fa lo snapshot di `modelId` e `model` in `Job.options`.
- **Worker:** usa `options.model` solo se compare nel proprio catalogo. Altrimenti il job fallisce senza retry e viene rimborsato: un'opzione manomessa non deve mai poter chiamare un modello arbitrario. `LLM_MODEL` resta il fallback per i job vecchi.
- **Web:** selettore "Modello" in `DocumentPage` e in `/settings` (preferenza `model`), con il moltiplicatore mostrato nel costo.

### 4.6 Test

- API:
  - crediti con un sottoinsieme di capitoli e con il moltiplicatore del modello;
  - indici fuori range o duplicati danno 400;
  - extra, `lengthPercent` fuori da 5–50 e `model` sconosciuto danno 400;
  - `LLM_MODELS` non valido blocca l'avvio.
- Worker:
  - filtro dei capitoli;
  - mismatch del numero di capitoli dà `FileChanged`;
  - il blocco degli extra è presente nelle istruzioni;
  - `lengthPercent` e il vecchio `fraction`;
  - un modello fuori catalogo dà un fallimento rimborsato.

## 5. Rischi e sign-off

Ogni rilascio passa il risk test di ensemble, quindi serve un SUPERVISE di Fable prima del merge:

- **A:** cancellazioni irreversibili su S3 e sul DB, race con la creazione dei job, e migrazione per `LlmCall`.
- **B:** migrazione e testo dell'utente dentro il prompt.
- **C:** calcolo dei crediti (capitoli e moltiplicatore) e scelta del modello attraverso un trust boundary.

Le migrazioni sono solo additive: nessun `DROP` e nessun `migrate reset`.
