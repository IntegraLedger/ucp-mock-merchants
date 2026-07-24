# UCP + AP2 + LCP Mock Merchants

Reference **merchant** surfaces for agentic commerce — mock merchants that implement
**UCP (Universal Commerce Protocol) + AP2 (Agent Payments Protocol) + x402 (HTTP-402
pay-per-request)** and weld in the **LCP (Legal Context Protocol)** legal-context reference.
Runs as a single **Cloudflare Worker** (Hono), self-contained (no external LCP packages),
**testnet / mock posture** (throwaway keys, mock payment/settlement, no real value).

**One catalog, one legal-context, three payment rails.** The same products and the same
`atrHash` ride UCP checkout + AP2 mandates *and* an x402 challenge — so whichever protocol Fisher
builds against, the merchant and its legal context are identical.

## Live

- **Worker:** `https://ucp-mock-merchants.dfisher-3f3.workers.dev`
- **Test console (Worker-hosted):** `/console` on the Worker
- **Conformance report (JSON):** `/report` (all merchants) or `/:m/report`
- **Test app (Cloudflare Pages):** see the deploy output / `pnpm pages:deploy`

Now a full commerce mock: a **rich, Wayfair-style product model** (variants, dimensions,
weight, images, inventory, shipping, tax), a **catalog management API** (add/update/remove
products), and a **real order** (shipping address, shipping options, tax, promo codes, a
totals breakdown, delivery estimate, and an order lifecycle).

---

## Purpose — what this is for

**This project exists to give Fisher the tools to build and test the rest of the system.**

The "rest of the system" is the side that *isn't* a merchant: the buyer/agent, the demo
wiring, settlement, disputes, partner integrations. Those need a concrete counterparty — a
merchant that actually serves a UCP manifest, lets you **stock a catalog**, signs a real order,
carries the LCP reference, and verifies an AP2 mandate bundle. That's what this is: a **stable,
inspectable merchant** you can point new code at and get deterministic, verifiable answers.

Three things ship here:

1. **The merchant surfaces** (`src/index.ts` + `src/lib/*`) — the full UCP/AP2/LCP HTTP contract
   plus catalog management and order lifecycle.
2. **A reference buyer** (`src/buyer.ts`) — a worked, verify-before-pay buyer agent. Fisher will
   likely build the production buyer on the demo code; this is the **shape to copy**.
3. **A catalog you can set up** — seed products ship in code, and `POST /:m/products` (or
   `/import`) lets Fisher stock each merchant with anything a real order carries.

If you're Fisher: run `pnpm buyer`, read the trace, then read `src/buyer.ts` (commented as a
guide). To stock a catalog, see [Catalog management](#catalog-management-api). To see full order
pricing, hit `POST /:m/orders/quote`.

---

## The three protocols, in one paragraph each

- **UCP (Universal Commerce Protocol)** — how an agent discovers a merchant and transacts. The
  merchant publishes a manifest at `/.well-known/ucp` (services, capabilities, payment handlers,
  signing keys) and signs a **Checkout** object.
- **AP2 (Agent Payments Protocol)** — how payment authorization rides on top. The buyer wraps the
  signed checkout in two **mandates** (Checkout + Payment), both bound to
  `checkout_hash = base64url(sha256(checkout_jwt))`. The merchant verifies the bundle → receipt.
  (Simplified to compact ES256 JWS VCs — no SD-JWT selective disclosure.)
- **x402 (HTTP-402 pay-per-request)** — the pay-per-call rail (Coinbase's open standard). Request a
  protected resource → `402` + payment requirements (priced from the catalog, in testnet USDC on
  base-sepolia) → resend with an `X-PAYMENT` header → `200` + settlement in `X-PAYMENT-RESPONSE`.
  The LCP `atrHash` rides the requirement's `extra` (same reverse-domain key as UCP). Mock: the
  payment shape is validated and a fake tx hash is returned; nothing settles on-chain.
- **LCP (Legal Context Protocol)** — how the legal terms become discoverable and provable. The
  byte-stable terms hash to an **`atrHash`** (`0x` + SHA-256, 64 hex). That reference rides inside
  the signed Checkout two ways — Tier A `links[].terms_of_service` (discovery) and Tier B
  `extensions["org.legalcontextprotocol.legal-context"]` (integrity). Change one byte of the terms
  and the hash won't match — the binding fails. **LCP is evidence, not enforcement.**

**How they compose:** the merchant signs a UCP Checkout (carrying the full order) with the LCP
`atrHash` welded in → `checkout_jwt`. AP2 hashes that exact JWT into `checkout_hash`, and both
mandates carry it. A single tamper — to the terms, the order, or a mandate — breaks the chain.

---

## The three merchants

Merchant *identity* (keys, terms, dispute clause) lives in `src/merchants.ts`; their *products*
live in the ProductStore (`src/lib/catalog.ts`), seeded per merchant and editable at runtime.

| id | name | seeded catalog | dispute resolution |
|---|---|---|---|
| `homegoods` | Homegoods Co. | furniture w/ variants, freight/standard shipping | AAA Commercial, seat New York |
| `apihub` | ApiHub | digital metered API SKUs (no shipping) | AAA Expedited, seat Boston |
| `makermart` | MakerMart | handmade goods w/ variants | AAA Commercial, seat San Francisco |

---

## Quickstart

**Requirements:** Node 20+ (or Bun). Cloudflare account only for `deploy`.

```sh
pnpm install
pnpm smoke        # in-process end-to-end proof — build → sign → mandate → verify → tamper-fail
pnpm buyer        # run the reference buyer against a merchant, print the step trace
pnpm test         # vitest: flow + buyer + cart + commerce (catalog CRUD, pricing, lifecycle)
pnpm typecheck
pnpm dev          # wrangler dev — open the printed URL, visit /homegoods/
pnpm deploy       # wrangler deploy
```

`pnpm smoke` and `pnpm buyer` need **no server and no deploy** — they drive the Worker in-process.

---

## The product model (Wayfair-style)

`src/lib/catalog.ts`. A `Product`:

```jsonc
{
  "sku": "sofa-3seat",
  "name": "Marlow 3-Seat Sofa",
  "description": "Mid-century 3-seat sofa …",
  "brand": "Marlow",
  "category": "Living Room / Sofas",
  "price": { "amount": 89900, "currency": "USD" },   // minor units; base price
  "images": ["https://…/sofa.jpg"],
  "dimensions": { "length": 84, "width": 36, "height": 34, "unit": "in" },
  "weight": { "value": 118, "unit": "lb" },
  "attributes": { "material": "…", "assembly": "…", "warranty": "5 years" },
  "variants": [
    { "sku": "sofa-3seat-navy", "options": { "color": "Navy" }, "inventory": 12 },
    { "sku": "sofa-3seat-forest", "options": { "color": "Forest Green" }, "price": { "amount": 94900, "currency": "USD" }, "inventory": 3 }
  ],
  "inventory": 0,
  "shipping": { "class": "freight", "freeShipping": true, "estimatedDaysMin": 7, "estimatedDaysMax": 14, "handlingFee": { "amount": 0, "currency": "USD" } },
  "taxCode": "furniture"
}
```

Only `sku`, `name`, `price` are required; the rest default (validated, no silent coercion). A
variant with a `price` overrides the base; without one it inherits it.

---

## The order model

`src/lib/order.ts`. Resolving items → a priced `Order`:

- **line items** — with the selected variant + options, unit price, line total
- **shipping** — options derived from the products' shipping class (`digital` / `small_parcel` /
  `standard` / `freight`); all-free products make the cheapest option $0; upgrades cost more;
  per-product handling fees are added
- **tax** — destination rate by ship-to `region` (illustrative US state table; e.g. NY 8.88%, CA
  9.5%, DE/OR 0%); applied to `subtotal − discount`
- **promo codes** — `SAVE10` / `WELCOME15` (percent), `FLAT20` ($20 off), `FREESHIP` (zero shipping)
- **totals** — `{ subtotal, discount, shipping, tax, total, currency }`
- **delivery estimate** — `{ earliest, latest }` ISO dates from the chosen option
- **status lifecycle** — `created → paid → fulfilled → shipped → delivered` (or `cancelled`)

Preview any of this without signing via `POST /:m/orders/quote`.

---

## Complete API reference

Per merchant `:m` = `homegoods` | `apihub` | `makermart`. `wrangler dev` serves `http://localhost:8787`.

### Discovery
| Route | What |
|---|---|
| `GET /:m/.well-known/ucp` | UCP manifest — capabilities (`checkout`, `catalog`, `legal-context`), `payment_handlers`, `signing_keys` |
| `GET /:m/.well-known/legal-context.json` | LCP discovery — `terms` URL + `atrHash` + `disputeResolution` |
| `GET /:m/terms/:atrHash` | the byte-stable terms (content-addressed; full 64-hex or `400`/`404`) |

### Catalog management API
| Route | What |
|---|---|
| `GET /:m/catalog` | list all products |
| `GET /:m/products/:sku` | one product |
| `POST /:m/products` | **create** a product (body = Product; `201`) |
| `PUT /:m/products/:sku` | **update** (patch merged; sku immutable) |
| `DELETE /:m/products/:sku` | **remove** |
| `POST /:m/products/import` | **bulk import** `{ products: [...] }` → `{ created, count }` |

Validation errors return `400 { "error": "…" }`.

### Order + checkout
| Route | What |
|---|---|
| `POST /:m/orders/quote` | price an order **without signing** — `{ items, shippingOptionId?, shippingAddress?, promoCode? }` → full `Order` |
| `POST /:m/checkout` | one-shot: build the order + sign the UCP Checkout (welds LCP) → `{ checkout, checkout_jwt, checkout_hash, order_id, lcp_reference }` |
| `POST /:m/cart` | open a mutable cart session |
| `POST /:m/cart/:sid/items` | add a line `{ sku, variantSku?, qty? }` (increments) |
| `DELETE /:m/cart/:sid/items/:sku[?variant=]` | remove a line |
| `GET /:m/cart/:sid` | view the cart (priced subtotal) |
| `POST /:m/cart/:sid/checkout` | sign the checkout from the cart (accepts `shippingOptionId?/shippingAddress?/promoCode?`) |

`items` accept `{ sku, variantSku?, qty }`. The signed Checkout embeds the full `order`
(line items, totals breakdown, shipping, address, delivery estimate) and welds the `atrHash`.

### Payment + order lifecycle
| Route | What |
|---|---|
| `POST /:m/ap2/receipt` | **receive payment**: verify `{ checkout_jwt, bundle }` → receipt w/ `payment.status:"captured"`, and advance the stored order to `paid` (`order_status` in the response) |
| `GET /:m/orders/:oid` | fetch an order (status, totals, payment) |
| `POST /:m/orders/:oid/fulfill` \| `/ship` \| `/deliver` \| `/cancel` | advance the lifecycle (illegal transitions → `400`) |

### x402 (pay-per-request)
| Route | What |
|---|---|
| `GET/POST /:m/x402/:sku[?variant=]` | no `X-PAYMENT` → `402` + requirements (catalog-priced USDC, LCP welded in `extra`); valid `X-PAYMENT` → `200` + resource + `X-PAYMENT-RESPONSE` (mock settlement) |

The `X-PAYMENT` header is base64 of a `PaymentPayload` (`{ x402Version, scheme, network, payload:{ signature, authorization } }`). `src/lib/x402.ts` exports `buildMockPaymentHeader()` for clients without a wallet; real clients sign EIP-3009 `transferWithAuthorization`.

### Conformance report + test UIs
| Route | What |
|---|---|
| `GET /:m/report` \| `GET /report` | run the self-check suite (13 checks/merchant incl. x402) → JSON `{ ok, passed, failed, checks }`; HTTP `200` if all pass else `500` — **for Fisher's dev env / CI** |
| `GET /console` | Worker-hosted test console — exercises every surface (discovery, catalog CRUD, cart, quote, checkout, AP2 pay, x402, order lifecycle, report) |
| `GET /` | landing · `GET /:m/` minimal storefront · `GET /health` |

`pnpm report` runs the same suite from the CLI (in-process or against a live URL) and exits
non-zero on any failure. A standalone **Cloudflare Pages** test app (`pages/index.html`, deploy with
`pnpm pages:deploy`) does the same from a static origin against any Worker base URL.

---

## The reference buyer (`src/buyer.ts`)

The discipline a real buyer must copy: **never pay against terms you haven't verified.**
`runBuyer()` runs these steps and returns a readable trace:

1. **discover-ucp** — manifest → merchant signing key
2. **discover-lcp** — `legal-context.json` → terms URL + declared `atrHash`
3. **verify-terms-hash** *(the gate)* — fetch terms, recompute `atrHash`, require equality (LCP L2)
4. **policy-legal** — require a dispute path; optional jurisdiction allowlist
5. **checkout** — `POST /checkout`
6. **verify-checkout-sig** — verify `checkout_jwt` under the manifest key
7. **verify-checkout-lcp** — welded reference in the signed checkout equals the gated terms
8. **policy-spend** — total within budget
9. **sign-mandates** — AP2 Checkout + Payment mandates (bound by `checkout_hash`)
10. **receipt** — `POST /ap2/receipt`, verify the receipt binds the same `checkout_hash`

```sh
pnpm buyer                             # in-process, merchant = homegoods
pnpm buyer apihub                      # in-process, pick a merchant
pnpm buyer https://<host>/homegoods    # against a live deployment
```

`runBuyer()` is transport-agnostic — pass the global `fetch` (a live URL) or a Worker's
`app.fetch` (in-process). Building the real buyer: copy the step order; steps 3, 6, 7 are
load-bearing. Guardrails plug into `BuyerPolicy` (budget, jurisdictions, required dispute path).

---

## End-to-end walkthrough (curl)

Against `pnpm dev` (`http://localhost:8787`):

```sh
# stock the catalog (Fisher's setup step)
curl -s -XPOST localhost:8787/homegoods/products -H 'content-type: application/json' \
  -d '{"sku":"desk-oak","name":"Oak Desk","price":{"amount":45000,"currency":"USD"},
       "shipping":{"class":"freight","freeShipping":true,"estimatedDaysMin":7,"estimatedDaysMax":14}}'

# price a full order (shipping + tax + promo) without signing
curl -s -XPOST localhost:8787/homegoods/orders/quote -H 'content-type: application/json' \
  -d '{"items":[{"sku":"lamp-arc","qty":1}],"shippingOptionId":"standard",
       "shippingAddress":{"name":"A","line1":"1 Main","city":"NYC","region":"NY","postal":"10001","country":"US"},
       "promoCode":"SAVE10"}' | jq .totals

# verify the terms hash yourself (the buyer gate, by hand)
ATR=$(curl -s localhost:8787/homegoods/.well-known/legal-context.json | jq -r .atrHash)
curl -s "localhost:8787/homegoods/terms/$ATR" | shasum -a 256   # equals $ATR without 0x

# full signed loop (discover → gate → checkout → mandates → receipt → paid)
pnpm buyer http://localhost:8787/homegoods
```

---

## Wiring into the LCP demo

`pnpm deploy` to the Integra Cloudflare account; each merchant is then live at
`https://<worker-url>/:m/…`. The demo's buyer agent (or the Carriers surface) points at a
merchant's `/.well-known/ucp`, runs a real checkout, and shows the Tier-B `legal-context`
placement — a genuine UCP merchant, not just a carrier round-trip.

---

## Persistence (D1)

The catalog uses an in-memory store by default (seeded; fine for `wrangler dev` + tests). To make
it **durable**, add a D1 binding named `DB` — the Worker then uses `D1ProductStore` automatically:

```sh
wrangler d1 create ucp-mock-merchants           # then set database_id in wrangler.toml
wrangler d1 execute ucp-mock-merchants --file db/schema.sql
# seed via the API: POST /:id/products/import
```

Uncomment the `[[d1_databases]]` block in `wrangler.toml`. Carts and orders are still in-memory
(swap for D1/Durable Objects the same way if you need them durable).

---

## Project layout

```
src/
  index.ts          Hono Worker — all routes (discovery, catalog CRUD, cart, checkout, ap2, x402, orders, console, report, storefront)
  merchants.ts      merchant identity (keys, terms, dispute clauses, x402 payTo)
  buyer.ts          the reference verify-before-pay buyer (runBuyer + BuyerPolicy)
  report.ts         the conformance self-check suite (runReport)
  console.ts        the Worker-hosted test console page
  lib/
    crypto.ts       Web Crypto — base64url, SHA-256 (atrHash/checkout_hash), ES256 JWS
    lcp.ts          LCP — legal-context.json, lcpReference, Tier-A/Tier-B carriers
    catalog.ts      product model + ProductStore (Memory + D1) + validation + seed
    order.ts        order pricing (shipping/tax/promo/totals/delivery) + status lifecycle + order store
    checkout.ts     build + sign the UCP Checkout from an order (welds the LCP reference)
    ap2.ts          AP2 — buildMandateBundle (buyer) + verifyAndReceipt (merchant) + mock payment capture
    x402.ts         x402 — requirements from the catalog, mock verify/settle, LCP weld
    cart.ts         mutable cart session ops (in-memory)
db/schema.sql       D1 schema for the durable catalog backend
pages/index.html    standalone Cloudflare Pages test app (targets any Worker base URL)
scripts/
  smoke.ts          in-process end-to-end proof
  buyer.ts          run the reference buyer (in-process or against a URL)
  report.ts         run the conformance report (in-process or against a URL; CI-friendly)
test/
  flow.test.ts      checkout + LCP binding + AP2 receipt + tamper-fail
  buyer.test.ts     buyer authorize / policy-decline / tampered-terms gate
  cart.test.ts      cart lifecycle (add/increment/remove/checkout/pay)
  commerce.test.ts  catalog CRUD + order pricing (shipping/tax/promo) + variant pricing + order lifecycle
  x402.test.ts      x402 challenge → pay → settle + LCP weld + underpay rejection
```

---

## Mock / testnet posture — read this

- **Throwaway keys.** The signing keys in `src/merchants.ts` are committed dev keys. **Never** reuse.
- **Mock payment.** `dev.ucp.mock_payment` authorizes but does not settle; `captured` is nominal.
- **Ephemeral state.** Catalog (in-memory mode), carts, and orders don't survive a restart or a
  second isolate. Use D1 (catalog) / Durable Objects for durability.
- **Illustrative tax + dispute.** The tax rates and AAA clauses are illustrative; no tax authority
  or arbitration is actually invoked. LCP is evidence, not enforcement.

Apache-2.0.
