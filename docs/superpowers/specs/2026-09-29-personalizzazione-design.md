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

**Fuori scope:**
- cartelle e tag;
- condivisione dei metodi tra utenti;
- modifica manuale della divisione in capitoli;
- eliminazione dell'account (resta nel rilascio 3 del nucleo);
- paginazione lato server (vedi §2.1).

## 2. Rilascio A — Browser e dashboard

### 2.1 API

| Endpoint | Comportamento |
|---|---|
| `GET /documents` | Invariato: tutti i documenti dell'utente, con i job di riassunto. Ricerca, filtri e ordinamento si fanno nel browser. `ponytail:` va bene fino a qualche centinaio di documenti per utente; oltre servono `?q=&status=&cursor=` lato server. |
| `PATCH /documents/:id` | Body `{ filename }`: da 1 a 200 caratteri, una sola riga. Cambia solo il nome visualizzato, non la chiave S3. Il nome del file scaricato ne deriva già. |
| `DELETE /documents/:id` | Risponde 409 se il documento ha job `queued` o `running`. Altrimenti, nell'ordine: prende il lock `FOR UPDATE` sulla riga `User`, come fa `JobsService.create`, così nessun job può nascere durante l'eliminazione; cancella da S3 il PDF e i risultati di tutti i job; cancella `Document`, e i `Job` a cascata. Le righe `CreditLedger` restano, perché `jobId` è `SetNull`. Risponde 204. |
| `GET /jobs` | Tutti i job `summarize` dell'utente, dal più recente, con `document: { id, filename }`. Usa `toJobDto` più il campo `document`. |
| `DELETE /jobs/:id` | Risponde 409 se il job non è `done` né `failed`. Altrimenti cancella da S3 `.md` e `.docx` e poi la riga `Job`. Risponde 204. |
| `GET /jobs/:id/content` | Il Markdown del riassunto, come `text/markdown`, letto da S3 lato server così non serve CORS. Risponde 404 se il job non è pronto. |
| `GET /me/ledger` | Gli ultimi 100 movimenti: `{ type, amount, createdAt, jobId, filename? }`. |
| `GET /me/stats` | `{ documents, summariesDone, creditsSpent, pagesSummarized }`, calcolati con aggregate Prisma. |

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

### 2.3 Test

- API (Jest):
  - rinomina con valori validi e non validi;
  - eliminazione rifiutata con 409 se c'è un job attivo;
  - eliminazione riuscita: gli oggetti S3 spariscono e il ledger resta;
  - 404 cross-user su tutti i nuovi endpoint;
  - `/me/stats` con dati noti;
  - `content` con 404 se il job non è pronto.
- Web: build pulita.

## 3. Rilascio B — Metodi personalizzati e preferenze

### 3.1 Dati (migrazione)

- **`SummaryMethod`**, nuovo modello:
  - campi: `id`, `userId` (cascade), `name` (1–80), `instructions` (1–4000 caratteri), `createdAt`, `updatedAt`;
  - indice su `userId`;
  - al massimo 20 metodi per utente.
- **`User.preferences`**: `Json @default("{}")`, con forma `{ language?, fraction?, method?, extras? }`.

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

### 4.4 Test

- API: crediti con un sottoinsieme di capitoli; indici fuori range o duplicati danno 400; extra non validi danno 400.
- Worker: filtro dei capitoli; mismatch del numero di capitoli dà `FileChanged`; il blocco degli extra è presente nelle istruzioni.

## 5. Rischi e sign-off

Ogni rilascio passa il risk test di ensemble, quindi serve un SUPERVISE di Fable prima del merge:

- **A:** cancellazioni irreversibili su S3 e sul DB, e race con la creazione dei job.
- **B:** migrazione e testo dell'utente dentro il prompt.
- **C:** calcolo dei crediti.

Le migrazioni sono solo additive: nessun `DROP` e nessun `migrate reset`.
