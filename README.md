# UCP + AP2 + LCP Mock Merchants

Reference **merchant** surfaces for agentic commerce — mock merchants that implement
**UCP (Universal Commerce Protocol) + AP2 (Agent Payments Protocol)** and weld in the
**LCP (Legal Context Protocol)** legal-context reference. Runs as a single **Cloudflare
Worker** (Hono), self-contained (no external LCP packages), **testnet / mock posture**
(throwaway keys, `dev.ucp.mock_payment`, no real value).

---

## Purpose — what this is for

**This project exists to give Fisher the tools to build and test the rest of the system.**

The "rest of the system" is the side that *isn't* a merchant: the buyer/agent, the demo
wiring, the settlement and dispute paths, any partner integration. Those all need something
concrete to talk to — a merchant that actually serves a UCP manifest, signs a real Checkout,
carries the LCP reference, and verifies an AP2 mandate bundle. That's what this is: a **stable,
inspectable counterparty** you can point new code at and get deterministic, verifiable answers.

Two things ship here:

1. **The merchant surfaces** (`src/index.ts` + `src/lib/*`, `src/merchants.ts`) — three mock
   merchants exposing the full UCP/AP2/LCP HTTP contract. Build the buyer/agent/demo against
   these and you're testing against a real protocol implementation, not a stub.
2. **A reference buyer** (`src/buyer.ts`) — a worked, verify-before-pay buyer agent. Fisher will
   likely build the production buyer on the demo code; this is the **shape to copy** — it shows
   exactly which checks a buyer must run (verify the terms hash before paying, verify the
   merchant signature, bind via AP2) and in what order.

If you're Fisher: start at [Quickstart](#quickstart), run `pnpm buyer`, read the trace, then read
`src/buyer.ts` top to bottom — it's commented as a guide. Everything else here is the merchant
contract that buyer talks to.

---

## The three protocols, in one paragraph each

- **UCP (Universal Commerce Protocol)** — how an agent discovers a merchant and transacts. A
  merchant publishes a manifest at `/.well-known/ucp` (its services, capabilities, payment
  handlers, and signing keys), and exposes a **Checkout** object the merchant signs.
- **AP2 (Agent Payments Protocol)** — how payment authorization rides on top. The buyer wraps the
  merchant's signed checkout in two **mandates** (a Checkout Mandate + a Payment Mandate), both
  bound to `checkout_hash = base64url(sha256(checkout_jwt))`. The merchant verifies the bundle and
  issues a receipt. (Simplified here to compact ES256 JWS VCs — no SD-JWT selective disclosure.)
- **LCP (Legal Context Protocol)** — how the legal terms become discoverable and provable. The
  merchant's byte-stable terms hash to an **`atrHash`** (`0x` + SHA-256, 64 hex). That reference
  rides *inside* the signed UCP Checkout two ways — a Tier-A `links[].terms_of_service`
  (discovery) and a Tier-B `extensions["org.legalcontextprotocol.legal-context"]` (integrity).
  Change one byte of the terms and the hash won't match — the binding fails. **LCP is evidence,
  not enforcement.**

**How they compose:** the merchant signs a UCP Checkout with the LCP `atrHash` welded in →
`checkout_jwt`. AP2 hashes that exact JWT into `checkout_hash` and both mandates carry it. So a
single tamper (to the terms, the checkout, or a mandate) breaks the chain — that's the whole proof.

---

## The three merchants

Defined in `src/merchants.ts` — each with a populated catalog, byte-stable terms (with an
illustrative AAA arbitration clause), and a throwaway ES256 signing key.

| id | name | catalog | dispute resolution |
|---|---|---|---|
| `homegoods` | Homegoods Co. | 5 furnishings ($59–$899) | AAA Commercial, seat New York |
| `apihub` | ApiHub | 3 metered API SKUs ($1–$900) | AAA Expedited, seat Boston |
| `makermart` | MakerMart | 4 handmade items ($28–$62) | AAA Commercial, seat San Francisco |

Add another by appending to the `MERCHANTS` registry (generate a P-256 JWK — see the note at the
top of `src/merchants.ts`).

---

## Quickstart

**Requirements:** Node 20+ (or Bun). Cloudflare account only needed for `deploy`.

```sh
pnpm install

pnpm smoke        # in-process end-to-end proof — build → sign → mandate → verify → tamper-fail
pnpm buyer        # run the reference buyer against a merchant, print the step trace
pnpm test         # vitest: merchant flow + buyer (authorize/decline/tampered) + cart lifecycle
pnpm typecheck    # tsc --noEmit

pnpm dev          # wrangler dev — open the printed URL, visit /homegoods/
pnpm deploy       # wrangler deploy (to your Cloudflare account)
```

`pnpm smoke` and `pnpm buyer` need **no server and no deploy** — they drive the Worker in-process
(the buyer uses the Worker's own `app.fetch`). That's deliberate: Fisher can iterate on buyer/agent
logic with a single `tsx` run.

---

## Complete API reference

Base path is per merchant: `/:m/…` where `:m` is `homegoods` | `apihub` | `makermart`.
All responses are JSON unless noted. CORS is open; `wrangler dev` serves at `http://localhost:8787`.

### Discovery

#### `GET /:m/.well-known/ucp` — UCP manifest
```jsonc
{
  "ucp": {
    "version": "2026-04-08",
    "services": { "dev.ucp.shopping": [{ "version": "2026-04-08", "transport": "rest",
      "endpoint": "https://<host>/homegoods/checkout", "spec": "https://ucp.dev/specification/overview" }] },
    "capabilities": {
      "dev.ucp.shopping.checkout": [{ "version": "2026-04-08", "spec": "https://ucp.dev/specification/checkout" }],
      "org.legalcontextprotocol.legal-context": [{ "version": "0.1.0", "spec": "https://legalcontextprotocol.org/standard" }]
    },
    "payment_handlers": { "dev.ucp.mock_payment": [{ "id": "mock-1", "version": "2026-04-08", "spec": "https://ucp.dev/mock" }] }
  },
  "signing_keys": [{ "kid": "homegoods-key-1", "kty": "EC", "crv": "P-256", "x": "…", "y": "…", "use": "sig", "alg": "ES256" }]
}
```
The buyer reads `signing_keys[0]` to verify the checkout signature later.

#### `GET /:m/.well-known/legal-context.json` — LCP discovery
```jsonc
{
  "terms": "https://<host>/homegoods/terms/0x817b…2659",
  "termsFormat": "markdown",
  "atrHash": "0x817b350e…2659",
  "disputeResolution": { "method": "AAA Commercial Arbitration Rules", "jurisdiction": "New York, USA" }
}
```

#### `GET /:m/terms/:atrHash` — the byte-stable terms (content-addressed)
Returns the raw terms markdown with `Content-Type: text/markdown`. The `:atrHash` **must be the
full `0x` + 64-hex** — a truncated hash returns `400 invalid atrHash format`; a well-formed hash
that doesn't match this merchant returns `404 unknown atrHash`. This is the content-address: the
URL *is* the hash, so fetching it and re-hashing the bytes must reproduce it.

#### `GET /:m/catalog`
```jsonc
{ "merchant": "homegoods", "items": [{ "sku": "rug-9x12", "name": "9×12 Area Rug", "price": { "amount": 12000, "currency": "USD" } }, …] }
```
Amounts are in **minor units** (cents).

### Checkout — two paths, one output

Both produce the same signed-checkout object. Use whichever fits the agent.

#### Path A — one-shot: `POST /:m/checkout`
```jsonc
// request
{ "items": [{ "sku": "rug-9x12", "qty": 1 }] }     // omit items → defaults to first catalog item
// response
{
  "checkout": {
    "checkout_id": "…", "merchant": { "id": "homegoods", "name": "Homegoods Co." },
    "line_items": [ … ], "total": { "amount": 12000, "currency": "USD" }, "currency": "USD",
    "links": [{ "type": "terms_of_service", "url": "https://<host>/homegoods/.well-known/legal-context.json" }],   // Tier A
    "extensions": { "org.legalcontextprotocol.legal-context": { "type": "sha256", "value": "0x817b…", "disputeResolution": { … } } },  // Tier B
    "created_at": "2026-07-24T…Z"
  },
  "checkout_jwt": "eyJ…",                 // the merchant-signed Checkout (ES256)
  "checkout_hash": "rYg5hzfaDSpY…",       // base64url(sha256(checkout_jwt)) — the AP2 binding
  "lcp_reference": "lcp:sha256:0x817b…"
}
```

#### Path B — mutable cart session
```
POST   /:m/cart                       → open a session (201): { session_id, merchant, status:"open", line_items:[], total, created_at }
POST   /:m/cart/:sid/items {sku,qty}  → add a line (increments if present) → priced cart view
DELETE /:m/cart/:sid/items/:sku       → remove a line → priced cart view
GET    /:m/cart/:sid                  → view the priced cart (running total)
POST   /:m/cart/:sid/checkout         → sign the UCP Checkout from the cart (same shape as Path A, plus session_id)
```
A cart view is `{ session_id, merchant, status, line_items:[{sku,name,qty,unit_price}], total, created_at }`.
Errors (unknown sku, empty checkout, double checkout, unknown session) return `4xx` with `{ "error": "…" }`.
**The cart store is in-memory (mock/dev)** — see [Extending](#extending).

### Payment — `POST /:m/ap2/receipt`

The **receive-payment** step. The buyer submits the merchant's `checkout_jwt` plus an AP2
**mandate bundle** it signed:
```jsonc
// request
{
  "checkout_jwt": "eyJ…",
  "bundle": {
    "buyer_public_jwk": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
    "checkout_mandate": "eyJ…",   // JWS, vct mandate.checkout.1, carries checkout_hash
    "payment_mandate":  "eyJ…"    // JWS, vct mandate.payment.1, transaction_id = checkout_hash
  }
}
```
The merchant **fails loud** on any mismatch — bad checkout signature, bad mandate signature, or a
`checkout_hash`/`transaction_id` that doesn't bind to *this* checkout (→ `422 { status:"declined", error }`).
On success:
```jsonc
{
  "status": "authorized",
  "checkout_id": "…", "checkout_hash": "rYg5…", "order_id": "…",
  "payment": { "handler": "dev.ucp.mock_payment", "instrument_id": "mock-instrument-1", "amount": { "amount": 12000, "currency": "USD" }, "status": "captured" },
  "iat": 1800000000,
  "receipt_jws": "eyJ…"   // the whole receipt, merchant-signed
}
```
`payment.status: "captured"` is the mock capture — the mandate authorized the charge; there is no
real settlement.

### Misc
- `GET /` — landing page listing merchants.
- `GET /:m/` — absolute-minimum HTML storefront (catalog checkboxes + a "run agentic checkout" button).
- `GET /health` — `{ "ok": true, "merchants": [...] }`.

---

## The reference buyer (`src/buyer.ts`)

The core discipline a real buyer must copy: **never pay against terms you haven't verified.**
`runBuyer()` executes these steps and returns a readable trace:

1. **discover-ucp** — GET the manifest, take the merchant signing key.
2. **discover-lcp** — GET `legal-context.json`, take the terms URL + declared `atrHash`.
3. **verify-terms-hash** *(the gate)* — fetch the terms bytes, recompute the `atrHash`, **require it
   to equal the declared one**. Mismatch → refuse, before any spend.
4. **policy-legal** — enforce buyer policy: require a dispute path; optional jurisdiction allowlist.
5. **checkout** — `POST /checkout`.
6. **verify-checkout-sig** — verify `checkout_jwt` under the manifest's key.
7. **verify-checkout-lcp** — the welded LCP reference in the *signed* checkout must equal the terms
   we gated on (Tier B, and Tier A present).
8. **policy-spend** — total must be within budget.
9. **sign-mandates** — build the AP2 Checkout + Payment mandates (bound by `checkout_hash`).
10. **receipt** — `POST /ap2/receipt`, verify the receipt binds the same `checkout_hash`.

```sh
pnpm buyer                             # in-process, merchant = homegoods
pnpm buyer apihub                      # in-process, pick a merchant
pnpm buyer https://<host>/homegoods    # against a live deployment
```
Example trace:
```
✓ discover-ucp         merchant key kid=homegoods-key-1 alg=ES256
✓ verify-terms-hash    recomputed atrHash matches declared (0x817b350e4c…)
✓ verify-checkout-sig  checkout_jwt verifies under the merchant key
✓ verify-checkout-lcp  signed checkout carries the verified atrHash (Tier B + Tier A)
✓ sign-mandates        Checkout + Payment mandates signed by the buyer key
✓ receipt              authorized · order afe0…
AUTHORIZED
```
`runBuyer()` is **transport-agnostic** — pass the global `fetch` (a live URL) or a Worker's
`app.fetch` (in-process). That's how the same buyer runs in tests, in the CLI, and against a deploy.

**Building the real buyer:** copy the step order. The load-bearing checks are 3, 6, and 7 — if those
pass, the receipt is meaningful; if you skip them, you've paid on trust. The policy object
(`BuyerPolicy`) is where your real guardrails (budget, allowed jurisdictions, required dispute path)
plug in.

---

## End-to-end walkthrough (curl)

The read + checkout steps are plain HTTP; the mandate-signing step needs a key, so use `pnpm buyer`
for the full loop. Against `pnpm dev` (`http://localhost:8787`):

```sh
# 1. discover
curl -s localhost:8787/homegoods/.well-known/ucp | jq .signing_keys
curl -s localhost:8787/homegoods/.well-known/legal-context.json | jq

# 2. verify the terms hash yourself (the buyer gate, by hand)
ATR=$(curl -s localhost:8787/homegoods/.well-known/legal-context.json | jq -r .atrHash)
curl -s "localhost:8787/homegoods/terms/$ATR" | shasum -a 256   # → should equal $ATR without the 0x

# 3. cart → checkout
SID=$(curl -s -XPOST localhost:8787/homegoods/cart | jq -r .session_id)
curl -s -XPOST localhost:8787/homegoods/cart/$SID/items -H 'content-type: application/json' -d '{"sku":"rug-9x12","qty":1}' | jq .total
curl -s -XPOST localhost:8787/homegoods/cart/$SID/checkout | jq '{checkout_hash, lcp_reference}'

# 4. full signed loop (discover → gate → checkout → mandates → receipt)
pnpm buyer http://localhost:8787/homegoods
```

---

## Wiring into the LCP demo

Deploy (`pnpm deploy`) to the Integra Cloudflare account; each merchant is then live at
`https://<worker-url>/:m/…`. The demo's buyer agent (or the Carriers surface) can point at a
merchant's `/.well-known/ucp`, run a real checkout, and show the Tier-B `legal-context` placement —
a genuine UCP merchant target rather than only a carrier round-trip. Nothing in the demo needs to
change except the merchant URL it targets.

---

## Extending

- **Durable cart / product info (D1 or Durable Object).** The cart store is an in-memory `Map`
  (`src/lib/cart.ts`) — correct for `wrangler dev` and the in-process tests, **not durable across
  production isolates**. To productionize, back the same `createCart`/`addItem`/`removeItem`/`getCart`
  functions with D1 (a `cart_sessions` + `cart_items` table) or a Durable Object (one object per
  session). The function signatures don't change. Same story for product info — currently in-code in
  `src/merchants.ts`; move to a D1 `products` table + `[[d1_databases]]` binding if you want it editable.
- **Another merchant.** Append to `MERCHANTS` in `src/merchants.ts` with a fresh P-256 JWK, terms
  string, catalog, and dispute clause. Everything else (routes, buyer, tests) picks it up from the
  registry.
- **Real SD-JWT mandates.** The AP2 layer here is compact ES256 JWS (no selective disclosure); swap
  `src/lib/ap2.ts` for a full SD-JWT implementation when the demo needs disclosures.

---

## Project layout

```
src/
  index.ts          Hono Worker — all routes (manifest, LCP, catalog, checkout, cart, ap2/receipt, storefront)
  merchants.ts      the merchant registry (keys, terms, catalogs, dispute clauses)
  buyer.ts          the reference verify-before-pay buyer (runBuyer + BuyerPolicy)
  lib/
    crypto.ts       Web Crypto — base64url, SHA-256 (atrHash/checkout_hash), ES256 JWS sign/verify
    lcp.ts          LCP — legal-context.json, lcpReference, the Tier-A/Tier-B carriers
    checkout.ts     build + sign the UCP Checkout (welds the LCP reference in)
    ap2.ts          AP2 — buildMandateBundle (buyer) + verifyAndReceipt (merchant) + mock payment capture
    cart.ts         mutable cart session ops (in-memory store)
scripts/
  smoke.ts          in-process end-to-end proof
  buyer.ts          run the reference buyer (in-process or against a URL)
test/
  flow.test.ts      merchant checkout + LCP binding + AP2 receipt + tamper-fail
  buyer.test.ts     buyer authorize / policy-decline / tampered-terms gate
  cart.test.ts      cart lifecycle (add/increment/remove/checkout/pay)
```

---

## Mock / testnet posture — read this

- **Throwaway keys.** The signing keys in `src/merchants.ts` are committed dev keys (mirrors the
  demo's own posture). They are **not secrets** and must **never** be reused for anything real.
- **Mock payment.** `dev.ucp.mock_payment` authorizes but does not settle. `payment.status:"captured"`
  is nominal.
- **Ephemeral cart.** In-memory; restart or a second isolate loses sessions.
- **LCP is evidence, not enforcement.** The AAA clauses are illustrative; no dispute is actually run here.

Apache-2.0.
