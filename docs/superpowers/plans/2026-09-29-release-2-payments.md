# Rilascio 2 — Pagamenti (Stripe)

**Spec:** `docs/superpowers/specs/2026-09-28-summarize-platform-design.md` §3 (CreditLedger, StripeEvent), §5, §7, §10 (webhook duplicato), §11 (test). Le decisioni prese qui dove la spec lascia margine sono marcate **Ruling**.

## Global Constraints

- Mai stampare o committare `.env`. Mai `prisma migrate reset`, mai modificare migrazioni esistenti.
- Niente trailer Co-Authored-By. Non toccare i file `Lijphart - …`.
- Log: solo id e importi, mai email, chiavi o payload Stripe interi.
- Stile esistente, `ponytail:` sulle semplificazioni. Unica nuova dipendenza ammessa: `stripe` (npm) in `apps/api`.

## Ruling

- **R1 — Billing opzionale.** Se `STRIPE_SECRET_KEY` non è impostata, il billing è disattivato: l'app parte, `GET /billing/packs` risponde `{enabled:false, packs:[]}`, `POST /billing/checkout` e il webhook rispondono 503. Se è impostata, `STRIPE_WEBHOOK_SECRET` e `STRIPE_PACKS` sono obbligatorie (fail fast all'avvio, come `LLM_MODELS`).
- **R2 — Pacchetti.** `STRIPE_PACKS` = JSON `[{ "id": "small", "credits": 50, "priceId": "price_..." }]`, `id` `^[a-z0-9-]{1,32}$`, `credits` intero 1..100000, id unici, array non vuoto. Prezzo e valuta si leggono da Stripe (`prices.retrieve`) e restano in cache in memoria 10 minuti. `credits` resta nostro: non si legge dai metadata del Price.
- **R3 — Checkout.** `mode: 'payment'`, un `line_item` `{price, quantity: 1}`, `client_reference_id = userId`, `customer_email` = email dell'utente, `metadata: { userId, packId, credits }` (anche in `payment_intent_data.metadata`), `invoice_creation: { enabled: true }`, `automatic_tax: { enabled: STRIPE_AUTOMATIC_TAX === 'true' }` (default off: senza Stripe Tax registrato il checkout fallisce). `success_url = WEB_ORIGIN/credits?paid=1`, `cancel_url = WEB_ORIGIN/credits`. Metodi di pagamento: quelli dinamici del dashboard (niente `payment_method_types`).
- **R4 — Accredito.** Solo dal webhook. Eventi `checkout.session.completed` con `payment_status === 'paid'` e `checkout.session.async_payment_succeeded`. In **una transazione**: insert `StripeEvent(id=event.id)`; se `P2002` → rollback e 200 (duplicato). Poi lock `User FOR UPDATE`, controlla che non esista già un `purchase` con lo stesso `paymentIntentId` (difesa oltre la PK), inserisce `purchase` con `amount = metadata.credits`, `stripeEventId`, `paymentIntentId`. Utente inesistente o metadata non validi → log error + 200 (non si recupera ritentando). `completed` con `payment_status !== 'paid'` → registra solo `StripeEvent`, niente credito.
- **R5 — Rimborsi.** `charge.refunded`: trova il `purchase` per `charge.payment_intent`. Crediti da revocare = `round(purchase.amount * charge.amount_refunded / charge.amount)` − Σ |revoke| già registrati per quel `paymentIntentId`; se > 0 inserisce `revoke` (amount negativo) con `paymentIntentId` e `stripeEventId`. Così rimborsi parziali multipli sommano correttamente. Nessun `purchase` trovato (evento fuori ordine) → rollback e **500**, così Stripe ritenta. Il saldo può diventare negativo; `JobsService.create` già rifiuta se saldo < credits (verificare con un test).
- **R6 — Migrazione** `stripe_payments`: modello `StripeEvent { id String @id; type String; processedAt DateTime @default(now()) }` e `CreditLedger.paymentIntentId String?` con `@@index([paymentIntentId])`. Creata con `pnpm --filter @summarize/db exec prisma migrate dev --name stripe_payments` sul DB docker locale.
- **R7 — Webhook.** `POST /api/billing/webhook`: firma verificata con `stripe.webhooks.constructEvent(rawBody, sig, secret)` sul **raw body** (`NestFactory.create(..., { rawBody: true })` e lo stesso nella creazione dell'app nei test). Firma mancante o non valida → 400. Esente da `originCheck`, dalla `SessionGuard` e dal throttler. Tipi di evento non gestiti → 200.

## Contratto API (condiviso tra API e Web)

```ts
type Pack = { id: string; credits: number; amount: number /* centesimi */; currency: string /* 'eur' */ };
GET  /api/billing/packs            (SessionGuard) -> { enabled: boolean; packs: Pack[] }
POST /api/billing/checkout {packId} (SessionGuard) -> { url: string }   // 404 pack sconosciuto, 503 billing off
POST /api/billing/webhook          (Stripe)       -> 200 | 400 | 500 | 503
GET  /api/me/ledger  // esistente: le righe purchase/revoke hanno jobId null
```

---

## Brief 1 — API (sonnet)

**Files:** `apps/api/src/billing/*` (nuovo `BillingModule`, registrato in `app.module.ts`), `apps/api/src/config.ts`, `apps/api/src/main.ts`, `apps/api/src/origin.middleware.ts` (esenzione webhook), `packages/db/prisma/schema.prisma` + nuova migrazione, `apps/api/test/billing.spec.ts` (+ `helpers.ts`/`env.ts` se serve per `rawBody`), `.env.example`, `docs/deploy.md`.

**Acceptance:**
- Tutti i Ruling R1–R7 e il contratto.
- Il client Stripe è un provider Nest (token iniettabile) così i test lo sostituiscono con un fake per `prices.retrieve` e `checkout.sessions.create`; il webhook nei test usa la vera verifica di firma con `stripe.webhooks.generateTestHeaderString` e un secret di test.
- **Test Jest (`billing.spec.ts`):**
  - billing off: packs `{enabled:false}`, checkout 503, webhook 503;
  - packs: importo e valuta dal fake, cache (fake chiamato una volta per due GET);
  - checkout: pack sconosciuto 404; valido → `{url}`, e il fake riceve `client_reference_id`, `metadata` e `success_url` corretti; non autenticato 401;
  - webhook: firma assente o sbagliata 400; `completed` paid → un `purchase` di `credits` e saldo aggiornato; **stesso evento due volte → un solo purchase, 200**; due eventi diversi con lo stesso payment intent → un solo purchase; `completed` unpaid → niente credito, poi `async_payment_succeeded` → credito; tipo non gestito 200;
  - rimborso totale → `revoke` = −credits; due parziali (50% + 50%) → totale revocato = credits; refund senza purchase → 500 e nessun `StripeEvent` salvato;
  - saldo negativo dopo un revoke → `POST /jobs` rifiutato;
  - il webhook funziona senza header `Origin`.
- `config.ts`: `parsePacks` con fail fast (test unitari come per `parseModels`).
- `.env.example` e `docs/deploy.md`: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PACKS`, `STRIPE_AUTOMATIC_TAX`, URL del webhook da registrare (`https://<api>/api/billing/webhook`, eventi `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`).

**Verify:** `pnpm --filter @summarize/api build && pnpm --filter @summarize/api test` (infra docker avviata).

**Skills:** superpowers:test-driven-development.

---

## Brief 2 — Web (sonnet)

**Files:** `apps/web/src/api.ts`, `apps/web/src/pages/Credits.tsx`, eventualmente `App.tsx` (link nell'header). Nessuna nuova dipendenza.

**Acceptance:**
- `api.ts`: tipi `Pack`, `BillingPacks`, hook `usePacks()` (`['packs']`), helper `formatPrice(amount, currency)` con `Intl.NumberFormat`.
- `Credits.tsx`: sopra lo storico, se `enabled`, una sezione "Buy credits" con una card per pack: crediti, prezzo formattato, prezzo per credito, bottone "Buy" che fa `POST /billing/checkout` e poi `window.location.assign(url)`; bottone disabilitato durante la richiesta; errore visibile. Se `enabled === false` la sezione non appare.
- Ritorno con `?paid=1`: banner "Payment received — credits will appear in a few seconds." e invalidazione periodica di `['me']` e `['ledger']` (ogni 2 s per al massimo 30 s, oppure finché appare una nuova riga `purchase`), poi il parametro si toglie dall'URL.
- Lo storico mostra `purchase` come "Purchase" e `revoke` come "Refund (revoked)"; le righe senza `jobId` né filename mostrano "—".
- Se il saldo è negativo, `Credits` mostra un avviso rosso; `DocumentPage` già blocca la creazione se il costo supera il saldo (verificare, non riscrivere).

**Verify:** `pnpm --filter @summarize/web build`.
