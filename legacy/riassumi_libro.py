#!/usr/bin/env python3
"""
riassumi_libro.py
------------------
Pipeline automatica per riassumere libri PDF usando l'API gratuita di NVIDIA Build
(compatibile OpenAI, https://build.nvidia.com).

Cosa fa:
1. Estrae il testo dal PDF (con fallback OCR automatico sulle pagine scansionate)
2. Pulisce il testo (rimuove numeri di pagina, header/footer ripetuti)
3. Divide il libro in capitoli (rilevati automaticamente, o a blocchi di dimensione fissa)
4. Riassume ogni capitolo mantenendo il contesto dei capitoli precedenti
5. Genera una sintesi finale dell'intero libro
6. Salva tutto in un file Markdown

Requisiti:
    pip install openai pymupdf pdf2image pytesseract tqdm
    (per l'OCR serve anche poppler e tesseract installati a livello di sistema:
     sudo apt install poppler-utils tesseract-ocr tesseract-ocr-ita)

Uso:
    export NVIDIA_API_KEY="nvapi-xxxxxxxxxxxxxxxxxxxxxxxx"
    python riassumi_libro.py libro.pdf --output riassunto.md

Opzioni utili:
    --model deepseek-ai/deepseek-v4.1-flash   (modello NVIDIA Build da usare)
    --lang ita                             (lingua per l'OCR, default italiano)
    --chunk-words 3000                     (dimensione blocco se non trova capitoli)
    --no-ocr                               (disabilita il fallback OCR)
"""

import argparse
import os
import re
import sys
import time
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:
    sys.exit("Manca PyMuPDF. Installa con: pip install pymupdf")

try:
    from openai import OpenAI
except ImportError:
    sys.exit("Manca il client OpenAI. Installa con: pip install openai")

from tqdm import tqdm

# ---------------------------------------------------------------------------
# 1. ESTRAZIONE TESTO (con fallback OCR pagina per pagina)
# ---------------------------------------------------------------------------

def estrai_testo(pdf_path: str, usa_ocr: bool, lingua_ocr: str) -> list[str]:
    """Restituisce una lista di stringhe, una per pagina."""
    doc = fitz.open(pdf_path)
    pagine = []

    ocr_disponibile = usa_ocr
    if usa_ocr:
        try:
            import pytesseract
            from pdf2image import convert_from_path
        except ImportError:
            print("⚠️  pytesseract/pdf2image non installati: l'OCR di fallback sarà disabilitato.")
            ocr_disponibile = False

    for i, pagina in enumerate(tqdm(doc, desc="Estrazione testo")):
        testo = pagina.get_text("text")

        # Se la pagina ha pochissimo testo, probabilmente è una scansione: prova l'OCR
        if ocr_disponibile and len(testo.strip()) < 40:
            try:
                immagini = convert_from_path(pdf_path, first_page=i + 1, last_page=i + 1, dpi=300)
                testo_ocr = pytesseract.image_to_string(immagini[0], lang=lingua_ocr)
                if len(testo_ocr.strip()) > len(testo.strip()):
                    testo = testo_ocr
            except Exception as e:
                print(f"⚠️  OCR fallito sulla pagina {i + 1}: {e}")

        pagine.append(testo)

    doc.close()
    return pagine


# ---------------------------------------------------------------------------
# 2. PULIZIA TESTO (rimuove header/footer ripetuti e numeri di pagina)
# ---------------------------------------------------------------------------

def pulisci_pagine(pagine: list[str]) -> list[str]:
    # Trova righe che si ripetono identiche su molte pagine (probabili header/footer)
    conteggio_righe = {}
    for testo in pagine:
        righe_uniche = {r.strip() for r in testo.splitlines() if r.strip()}
        for r in righe_uniche:
            conteggio_righe[r] = conteggio_righe.get(r, 0) + 1

    soglia = max(3, int(len(pagine) * 0.4))
    righe_da_rimuovere = {r for r, c in conteggio_righe.items() if c >= soglia and len(r) < 80}

    pagine_pulite = []
    for testo in pagine:
        righe_pulite = []
        for riga in testo.splitlines():
            riga_stripped = riga.strip()
            if riga_stripped in righe_da_rimuovere:
                continue
            if re.fullmatch(r"[\d ivxlcdmIVXLCDM\-–—]{1,6}", riga_stripped):
                continue  # numeri di pagina isolati (anche romani)
            righe_pulite.append(riga)
        pagine_pulite.append("\n".join(righe_pulite))

    return pagine_pulite


# ---------------------------------------------------------------------------
# 3. SUDDIVISIONE IN CAPITOLI (o blocchi di dimensione fissa)
# ---------------------------------------------------------------------------

PATTERN_CAPITOLO = re.compile(
    r"^\s*(cap(itolo)?\.?\s*\d+|chapter\s*\d+|parte\s+[ivxlcdm\d]+)\b",
    re.IGNORECASE,
)

def suddividi_in_capitoli(pagine: list[str], parole_per_blocco: int) -> list[str]:
    testo_completo = "\n".join(pagine)
    righe = testo_completo.splitlines()

    indici_capitoli = [i for i, r in enumerate(righe) if PATTERN_CAPITOLO.match(r)]

    if len(indici_capitoli) >= 2:
        blocchi = []
        for idx, inizio in enumerate(indici_capitoli):
            fine = indici_capitoli[idx + 1] if idx + 1 < len(indici_capitoli) else len(righe)
            blocco = "\n".join(righe[inizio:fine]).strip()
            if blocco:
                blocchi.append(blocco)
        return blocchi

    # Fallback: nessun capitolo riconosciuto, spezza per numero di parole
    parole = testo_completo.split()
    blocchi = []
    for i in range(0, len(parole), parole_per_blocco):
        blocchi.append(" ".join(parole[i:i + parole_per_blocco]))
    return blocchi


# ---------------------------------------------------------------------------
# 4. RIASSUNTO VIA NVIDIA BUILD API (con contesto dei capitoli precedenti)
# ---------------------------------------------------------------------------

PROGRESSO = Path(__file__).with_name("progresso.txt")


def scrivi_progresso(testo: str) -> None:
    try:
        PROGRESSO.write_text(testo + "\n", encoding="utf-8")
    except OSError:  # file aperto/bloccato da un lettore: si salta un aggiornamento
        pass


def chiama_modello(client: OpenAI, model: str, prompt: str, max_tokens: int = 700,
                    tentativi: int = 5, system: str = "", progresso=None) -> str:
    # progresso: funzione(parole_scritte, sta_ragionando) chiamata ogni ~2 s durante lo streaming
    messaggi = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}]
    for tentativo in range(tentativi):
        try:
            # Streaming: il testo compare in tempo reale (anche il ragionamento, se il modello lo espone).
            flusso = client.chat.completions.create(
                model=model,
                messages=messaggi,
                max_tokens=max_tokens,
                temperature=0.4,
                stream=True,
            )
            parti, pensa, ultimo = [], False, 0.0
            for evento in flusso:
                if progresso and time.time() - ultimo > 2:
                    progresso(len("".join(parti).split()), pensa)
                    ultimo = time.time()
                if not evento.choices:
                    continue
                delta = evento.choices[0].delta
                ragionamento = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
                if ragionamento:
                    if not pensa:
                        print("\n💭 ", end="")
                        pensa = True
                    print(ragionamento, end="", flush=True)
                if delta.content:
                    if pensa:
                        print("\n\n✍️  ", end="")
                        pensa = False
                    parti.append(delta.content)
                    print(delta.content, end="", flush=True)
                if evento.choices[0].finish_reason == "length":
                    print(f"\n⚠️  Output troncato: raggiunto max_tokens={max_tokens}")
            print()
            return "".join(parti).strip()
        except Exception as e:
            attesa = 2 ** tentativo
            print(f"⚠️  Errore API ({e}). Riprovo tra {attesa}s...")
            time.sleep(attesa)
    raise RuntimeError("Troppi errori consecutivi nella chiamata all'API.")


ISTRUZIONI_VERIFICA = """You are a meticulous fact-checker. The user message contains the ORIGINAL TEXT of a reading and a DRAFT SUMMARY of it.
Return the corrected summary in Markdown, and NOTHING else (no comments, no list of changes).
- Check every name, year, number, percentage, seat count, date, citation (Author year) and quotation against the original; fix wrong ones.
- Delete any claim, term or quotation that is not supported by the original (invented facts, content only found in footnotes).
- Quotation marks may only enclose words that appear verbatim in the original.
- Check that attributions are correct (who said what, which year) and that comparisons are not reversed.
- Keep structure, headings, bold terms, length and style unchanged: correct, do not rewrite. No bullets or tables."""


def normalizza(testo: str) -> str:
    # Uniforma il testo del PDF per i confronti: legature, a capo con trattino, virgolette, spazi.
    testo = testo.replace("ﬁ", "fi").replace("ﬂ", "fl").replace("ﬀ", "ff")
    testo = re.sub(r"(\w)-\s+(\w)", r"\1\2", testo)
    testo = testo.translate(str.maketrans("“”‘’–—", "\"\"''--"))
    return re.sub(r"\s+", " ", testo).lower()


def controlli(riassunto: str, originale: str) -> list[str]:
    # Controlli senza modello: citazioni non trovate nell'originale, parentesi quadre, lunghezza.
    problemi = []
    solo_lettere = lambda s: re.sub(r"[^a-z0-9]", "", normalizza(s))
    # testatine di pagina tipo "CONSENSUS MODEL OF DEMOCRACY  45" spezzano le citazioni: via prima del confronto
    originale = re.sub(r"^(?:\d+\s+)?[A-Z][A-Z ,:;'’\-–]{3,}(?:\s+\d+)?\s*$", " ", originale, flags=re.M)
    fonte = solo_lettere(originale)
    # virgolette tipografiche e dritte separate: mescolarle abbina l'apertura di una alla chiusura dell'altra
    citazioni = re.findall(r"“([^“”\n]{8,400}?)”", riassunto) + re.findall(r"\"([^\"\n]{8,400}?)\"", riassunto)
    for citazione in citazioni:
        # ponytail: blocchi di 5 parole, solo lettere; tollera cambi pagina, legature spezzate e [inserti] editoriali.
        # Soglia 80%: una parafrasi quasi letterale può passare.
        parole = re.sub(r"\*\*|[\[\]]", " ", citazione).split()
        blocchi = [solo_lettere(" ".join(parole[j:j + 5])) for j in range(0, len(parole), 5)]
        blocchi = [b for b in blocchi if b]
        if blocchi and sum(b in fonte for b in blocchi) < 0.8 * len(blocchi):
            problemi.append(f"citazione non trovata nel testo: \"{citazione}\"")
    fuori_citazioni = re.sub(r"“[^“”\n]*”|\"[^\"\n]*\"", "", riassunto)  # [..] dentro le citazioni sono inserti legittimi
    for resto in re.findall(r"\[[^\]]*\]", fuori_citazioni):
        problemi.append(f"parentesi quadre rimaste: {resto}")
    parole, obiettivo = len(riassunto.split()), len(originale.split()) // 3
    if not 0.75 * obiettivo <= parole <= 1.25 * obiettivo:
        problemi.append(f"lunghezza {parole} parole, obiettivo ~{obiettivo}")
    return problemi


def sistema_formato(testo: str, intestazione: str | None) -> str:
    testo = re.sub(r"\n*^---[ \t]*$\n*", "\n\n---\n\n", testo, flags=re.M)  # evita titoli setext
    testo = re.sub(r"[ \t]+$", "", testo, flags=re.M)
    testo = re.sub(r"\n*^(#{1,6} .*)$\n*", r"\n\n\1\n\n", testo, flags=re.M)  # pandoc vuole righe vuote attorno ai titoli
    minori = {"a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "vs"}
    def title_case(m):  # titoli TUTTO MAIUSCOLO -> Title Case (il modello a volte copia il maiuscolo del PDF)
        parole = m.group(2).lower().split()
        return m.group(1) + " ".join(p if j and p in minori else p[:1].upper() + p[1:] for j, p in enumerate(parole))
    testo = re.sub(r"^(#{1,6} )([^a-z\n]*[A-Z]{3}[^a-z\n]*)$", title_case, testo, flags=re.M)
    testo = re.sub(r"\n{3,}", "\n\n", testo)
    if intestazione:  # la riga bibliografica è imposta, non indovinata dal modello
        testo = re.sub(r"^\*\*.*$", lambda _: intestazione, testo, count=1, flags=re.M)
    return testo.strip()


def riassumi_con_istruzioni(client: OpenAI, model: str, capitoli: list[str], istruzioni: str,
                            fonte: str | None = None, pagine: list[str] | None = None,
                            verifica: bool = True, nome: str = "") -> list[str]:
    # Un capitolo intero per chiamata, con le istruzioni dell'utente come system prompt,
    # poi una seconda chiamata che verifica il riassunto sul testo originale.
    # max_tokens alto: i modelli "reasoning" spendono token anche nel ragionamento.
    riassunti = []
    fasi = 2 if verifica else 1
    passi = len(capitoli) * fasi
    inizio = time.time()

    def stato(passo: int, fase: str, attese: int):
        # ponytail: stima dalle parole scritte rispetto a quelle attese; il ragionamento non è misurabile
        def aggiorna(scritte: int, ragiona: bool):
            frazione = min(scritte / max(attese, 1), 0.99)
            totale = (passo + frazione) / passi
            barra = "#" * int(totale * 30) + "-" * (30 - int(totale * 30))
            righe = [nome,
                     f"Capitolo {passo // fasi + 1}/{len(capitoli)} - {fase}" + (" (sta ragionando...)" if ragiona else ""),
                     f"Fase: {frazione:.0%}  ({scritte}/{attese} parole)",
                     f"Documento: [{barra}] {totale:.0%}",
                     f"Tempo: {int(time.time() - inizio) // 60} min"]
            scrivi_progresso("\n".join(righe))
        return aggiorna

    for i, cap in enumerate(tqdm(capitoli, desc="Riassunto capitoli")):
        passo = i * fasi
        intestazione = None
        if fonte:
            intestazione = fonte + (f", pp. {pagine[i]}" if pagine and i < len(pagine) else "")
        obiettivo = len(cap.split()) // 3
        prompt = f"Target length: about {obiettivo} words (one third of the original).\n\n"
        if intestazione:
            prompt += f"Use exactly this bibliographic line under the title:\n{intestazione}\n\n"
        prompt += f"Reading to summarize:\n\n{cap}"
        print(f"\n\n===== Capitolo {i + 1}: bozza =====")
        testo = sistema_formato(chiama_modello(client, model, prompt, max_tokens=32000, system=istruzioni,
                                               progresso=stato(passo, "bozza", obiettivo)), intestazione)
        if verifica:
            print(f"\n\n===== Capitolo {i + 1}: verifica sul testo originale =====")
            corretto = chiama_modello(client, model, f"ORIGINAL TEXT:\n\n{cap}\n\n=====\n\nDRAFT SUMMARY:\n\n{testo}",
                                      max_tokens=32000, system=ISTRUZIONI_VERIFICA,
                                      progresso=stato(passo + 1, "verifica", len(testo.split())))
            # ponytail: se la verifica restituisce qualcosa di troppo corto (rifiuto/troncamento) si tiene la bozza
            if len(corretto.split()) > 0.7 * len(testo.split()):
                testo = sistema_formato(corretto, intestazione)
            else:
                print("\n⚠️  Verifica scartata (output troppo corto), tengo la bozza.")
        problemi = controlli(testo, cap)
        print(f"\n\n🔎 Controlli capitolo {i + 1}: " + ("nessun problema" if not problemi else ""))
        for p in problemi:
            print(f"   ⚠️  {p}")
        riassunti.append(testo)
    scrivi_progresso(f"{nome}\nCompletato in {int(time.time() - inizio) // 60} min")
    return riassunti


def salva_docx(md: Path) -> None:
    # Copia .docx accanto al .md, da aprire/importare in Google Docs (pandoc incluso in pypandoc_binary).
    try:
        import pypandoc
        testo = sistema_formato(md.read_text(encoding="utf-8"), None)
        pypandoc.convert_text(testo, "docx", format="markdown", outputfile=str(md.with_suffix(".docx")))
        print(f"📄 Versione per Google Docs: {md.with_suffix('.docx')}")
    except Exception as e:  # il .md resta comunque salvato
        print(f"⚠️  Conversione .docx non riuscita ({e}); installa pypandoc_binary")


def riassumi_capitoli(client: OpenAI, model: str, capitoli: list[str]) -> list[str]:
    riassunti = []
    contesto_precedente = ""

    for i, capitolo in enumerate(tqdm(capitoli, desc="Riassunto capitoli")):
        prompt = f"""Riassumi in modo chiaro e completo il seguente capitolo di un libro, in italiano.
Mantieni i concetti chiave, i nomi propri e gli eventi principali. Massimo 300 parole.

{"Contesto dei capitoli precedenti (per continuità narrativa): " + contesto_precedente if contesto_precedente else ""}

Testo del capitolo {i + 1}:
{capitolo[:12000]}
"""
        riassunto = chiama_modello(client, model, prompt)
        riassunti.append(riassunto)
        contesto_precedente = riassunto  # passa solo l'ultimo riassunto come contesto, per non gonfiare il prompt

    return riassunti


def sintesi_finale(client: OpenAI, model: str, riassunti: list[str]) -> str:
    testo_riassunti = "\n\n".join(f"Capitolo {i+1}: {r}" for i, r in enumerate(riassunti))
    prompt = f"""Di seguito trovi i riassunti dei singoli capitoli di un libro.
Scrivi una sintesi finale complessiva del libro (temi principali, arco narrativo o argomentativo,
conclusioni), in italiano, in massimo 500 parole.

{testo_riassunti[:20000]}
"""
    return chiama_modello(client, model, prompt, max_tokens=900)


# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Riassumi automaticamente un libro PDF.")
    parser.add_argument("pdf", help="Percorso del file PDF del libro")
    parser.add_argument("--output", default="riassunto.md", help="File di output Markdown")
    parser.add_argument("--model", default="deepseek-ai/deepseek-v4.1-flash",
                         help="Modello NVIDIA Build da usare")
    parser.add_argument("--lang", default="ita", help="Lingua per l'OCR (default: ita)")
    parser.add_argument("--chunk-words", type=int, default=3000,
                         help="Parole per blocco se non vengono rilevati capitoli")
    parser.add_argument("--no-ocr", action="store_true", help="Disabilita il fallback OCR")
    parser.add_argument("--istruzioni", help="File con le istruzioni di riassunto (system prompt); "
                         "manda i capitoli interi e salta la sintesi finale")
    parser.add_argument("--fonte", help="Riga bibliografica senza pagine, es. "
                         "\"**Arend Lijphart** – *Patterns of Democracy*, Yale University Press, 2012\"")
    parser.add_argument("--pagine", help="Pagine per capitolo separate da virgola, es. \"9–29,30–45\"")
    parser.add_argument("--no-verifica", action="store_true", help="Salta la chiamata di verifica sul testo originale")
    args = parser.parse_args()

    # ponytail: parser .env minimale (KEY=value), niente python-dotenv
    for env_file in (Path(__file__).with_name(".env"), Path(__file__).resolve().parent.parent / ".env"):
        if env_file.exists():
            for line in env_file.read_text(encoding="utf-8").splitlines():
                key, sep, value = line.partition("=")
                if sep and not key.strip().startswith("#"):
                    os.environ.setdefault(key.strip(), value.strip().strip('"\''))

    api_key = os.environ.get("NVIDIA_API_KEY")
    if not api_key:
        sys.exit("Errore: imposta NVIDIA_API_KEY nel file .env o come variabile d'ambiente (chiave nvapi-...)")

    client = OpenAI(base_url="https://integrate.api.nvidia.com/v1", api_key=api_key)

    print(f"📖 Apro {args.pdf}...")
    pagine = estrai_testo(args.pdf, usa_ocr=not args.no_ocr, lingua_ocr=args.lang)

    print("🧹 Pulizia testo...")
    pagine_pulite = pulisci_pagine(pagine)

    print("✂️  Suddivisione in capitoli...")
    capitoli = suddividi_in_capitoli(pagine_pulite, args.chunk_words)
    print(f"   Trovati {len(capitoli)} blocchi da riassumere.")

    if args.istruzioni:
        print("🤖 Riassunto dei capitoli con le istruzioni personalizzate...")
        istruzioni = Path(args.istruzioni).read_text(encoding="utf-8")
        pagine_cap = [p.strip().replace("-", "–") for p in args.pagine.split(",")] if args.pagine else None
        riassunti = riassumi_con_istruzioni(client, args.model, capitoli, istruzioni,
                                            args.fonte, pagine_cap, not args.no_verifica, Path(args.output).stem)
        Path(args.output).write_text("\n\n---\n\n".join(riassunti) + "\n", encoding="utf-8")
        print(f"✅ Fatto! Riassunto salvato in {Path(args.output).resolve()}")
        salva_docx(Path(args.output))
        return

    print("🤖 Riassunto dei capitoli (può richiedere tempo, va tenuto girare in background)...")
    riassunti = riassumi_capitoli(client, args.model, capitoli)

    print("🧩 Sintesi finale...")
    sintesi = sintesi_finale(client, args.model, riassunti)

    output_path = Path(args.output)
    with output_path.open("w", encoding="utf-8") as f:
        f.write(f"# Riassunto di {Path(args.pdf).stem}\n\n")
        f.write("## Sintesi generale\n\n")
        f.write(sintesi + "\n\n")
        f.write("## Riassunti per capitolo\n\n")
        for i, r in enumerate(riassunti):
            f.write(f"### Capitolo {i + 1}\n\n{r}\n\n")

    print(f"✅ Fatto! Riassunto salvato in {output_path.resolve()}")


if __name__ == "__main__":
    main()
