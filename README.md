# UCP + AP2 Mock Merchants

Reference **merchant** surfaces for agentic commerce — mock merchants that implement
**UCP (Universal Commerce Protocol) + AP2 (Agent Payments Protocol)** and weld in the
**LCP (Legal Context Protocol)** legal-context reference. Runs as a single **Cloudflare
Worker** (Hono). **Self-contained** (no external LCP packages; field shapes match
`@legalcontext/*`). **Testnet / mock posture** — throwaway keys, `dev.ucp.mock_payment`,
no real value.

Built for dev/test and for wiring into the LCP demo (`demo.integraledger.com`) as a real
UCP-merchant target.

## What each merchant serves

For a merchant id `:m` (`homegoods`, `apihub`, `makermart`):

| Route | What it is |
|---|---|
| `GET /:m/` | absolute-minimum **HTML storefront** (catalog + a "run agentic checkout" button) |
| `GET /:m/.well-known/ucp` | **UCP manifest** — capabilities (`dev.ucp.shopping.checkout`, `…legal-context`), `payment_handlers` (`dev.ucp.mock_payment`), `signing_keys` (JWK) |
| `GET /:m/.well-known/legal-context.json` | **LCP discovery** — `terms` URL + `atrHash` + `disputeResolution` (AAA) |
| `GET /:m/terms/:atrHash` | the **byte-stable terms**, content-addressed (full 64-hex; truncated → `400`) |
| `GET /:m/catalog` | JSON catalog |
| `POST /:m/checkout` | one-shot: a **merchant-signed UCP Checkout object** from a full item list — welds the LCP reference in (Tier-A `links` + Tier-B `extensions`), plus `checkout_jwt` and `checkout_hash` |
| `POST /:m/cart` | open a **mutable cart session** → `{ session_id, line_items, total }` |
| `POST /:m/cart/:sid/items` | **add** an item `{ sku, qty }` (increments if present) → priced cart |
| `DELETE /:m/cart/:sid/items/:sku` | **remove** a line → priced cart |
| `GET /:m/cart/:sid` | **view** the cart (priced, running total) |
| `POST /:m/cart/:sid/checkout` | sign the UCP Checkout **from the cart** (same output as `/checkout`) |
| `POST /:m/ap2/receipt` | **receive payment**: verify the **AP2 mandate bundle** (bound by `checkout_hash`) → signed receipt with `payment.status: "captured"` (mock) |
| `GET /health` | liveness |

Two ways to reach a signed checkout: **one-shot** (`POST /checkout` with the full list) or a
**mutable cart** (`POST /cart` → add/remove → `POST /cart/:sid/checkout`). Both end at the same
`ap2/receipt` payment step. The cart store is in-memory (**mock/dev** — not durable across
production isolates); back it with D1 or a Durable Object for real use (the `src/lib/cart.ts`
function shapes stay the same).

The LCP reference (`atrHash`) rides both the UCP checkout `extensions["org.legalcontextprotocol.legal-context"]`
(Tier B, integrity) and a `links[].terms_of_service` (Tier A, discovery). AP2 binds it: the
merchant signs the Checkout → `checkout_jwt`; `checkout_hash = base64url(sha256(checkout_jwt))`
is carried by the Checkout + Payment mandates. Change one byte of the terms/reference and the
binding fails — the whole proof.

## Merchants

Three mock merchants ship in the registry (`src/merchants.ts`), each with a populated catalog,
byte-stable terms (AAA dispute clause), and a throwaway ES256 signing key:

- **homegoods** (`Homegoods Co.`) — furnishings; AAA Commercial, seat New York
- **apihub** (`ApiHub`) — metered API calls; AAA Expedited, seat Boston
- **makermart** (`MakerMart`) — handmade marketplace; AAA Commercial, seat San Francisco

Add another by appending to `MERCHANTS` (generate a P-256 JWK; see the note at the top of that file).

## Mock buyer (reference for building a real one)

`src/buyer.ts` is a **reference LCP-aware buyer agent** — a worked guide for building a real buyer.
It drives the whole purchase and, crucially, **gates on the terms before paying**:

1. discover `/.well-known/ucp` (merchant signing key) and `/.well-known/legal-context.json` (terms + `atrHash`)
2. **buyer gate** — fetch the terms bytes, recompute the `atrHash`, require it to equal the declared reference (LCP L2). One byte off → refuse.
3. apply a **buyer policy** (require a dispute path; jurisdiction allowlist; spend cap)
4. `POST /checkout`, then **verify** the merchant's signature and that the welded LCP reference matches the terms it gated on
5. sign the **AP2 mandate bundle** (bound by `checkout_hash`), `POST /ap2/receipt`, verify the receipt

Run it — in-process (no server, drives the Worker's own `app.fetch`) or against a live URL:

```sh
pnpm buyer                             # in-process, merchant = homegoods
pnpm buyer apihub                      # in-process, pick a merchant
pnpm buyer https://<host>/homegoods    # against a live deployment
```

It prints a step-by-step trace ending in `AUTHORIZED` or `DECLINED: <reason>`. Fisher will likely
build on the demo code; this buyer is the shape to copy — verify-before-pay, then bind via AP2.

## Run it

```sh
pnpm install
pnpm smoke        # in-process end-to-end proof (no deploy) — build → sign → mandate → verify → tamper-fail
pnpm buyer        # run the reference buyer against a merchant (in-process)
pnpm test         # vitest (merchant flow + buyer authorize / decline / tampered-terms)
pnpm dev          # wrangler dev — open the printed URL, visit /homegoods/
pnpm deploy       # wrangler deploy
```

## Wiring into the LCP demo

Deploy (`pnpm deploy`) to the Integra Cloudflare account; the worker serves each merchant at
`https://<worker-url>/:m/…`. The demo's buyer agent (or Carriers surface) can point at a merchant's
`/.well-known/ucp`, run a checkout, and show the Tier-B `legal-context` placement — a real UCP
merchant target rather than only a carrier round-trip.

## Notes

- **Mock / testnet only.** Keys in `src/merchants.ts` are throwaway dev keys. Payments are mock
  (`dev.ucp.mock_payment`) — no settlement.
- **AP2 mandates** are compact ES256 JWS VCs (no SD-JWT selective disclosure) — the same simplification
  the LCP reference impl's `protocol-ap2` makes.
- **Product info** is in-code (`src/merchants.ts`) for zero-dependency simplicity; move it to a D1 binding
  (add `[[d1_databases]]` + `db/schema.sql`) if you want it editable.
- LCP is **evidence, not enforcement** — the AAA clauses are illustrative; disputes are not run here.

Apache-2.0.
