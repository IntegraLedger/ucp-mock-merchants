// UCP + AP2 + LCP mock merchants — a single Cloudflare Worker serving N merchants.
// Each merchant exposes: a UCP manifest, a legal-context discovery doc + content-
// addressed terms, a catalog management API (add/update/remove products), a
// mutable cart, a rich order (shipping/tax/promo/totals/delivery) checkout that
// welds in the LCP reference, AP2 mandate verification + receipt, an order
// lifecycle, and an absolute-minimum HTML storefront.
//
// No external LCP packages (self-contained; field shapes match @legalcontext/*).
// Testnet/mock posture: throwaway keys, mock payment handler, no real value.

import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { getMerchant, MERCHANTS, MERCHANT_IDS, type Merchant } from './merchants.js';
import { atrHashOf, publicOf } from './lib/crypto.js';
import { buildLegalContext, lcpReference } from './lib/lcp.js';
import { buildSignedCheckout } from './lib/checkout.js';
import { verifyAndReceipt, type MandateBundle } from './lib/ap2.js';
import { type CartStore, createCart, addItem, removeItem, getCart, markCheckedOut, cartView } from './lib/cart.js';
import { MemoryProductStore, D1ProductStore, validateProduct, resolveVariant, type ProductStore, type Product, type D1Like } from './lib/catalog.js';
import { buildX402Requirements, build402Body, verifyX402Payment, encodeSettlement, X402_NETWORK, X402_USDC } from './lib/x402.js';
import { buildOrder, shippingOptionsFor, advanceStatus, OrderStore, type Address, type OrderStatus } from './lib/order.js';
import { consolePage } from './console.js';
import { runReport, type FetchLike } from './report.js';

interface Bindings {
  DB?: D1Like; // optional D1 binding; when absent the in-memory store is used
}
const app = new Hono<{ Bindings: Bindings }>();

app.use('*', cors());
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
});

const ATR_RE = /^0x[0-9a-fA-F]{64}$/;

// Stores. Products: D1 when bound, else a single in-memory store (seeded). Carts
// + orders: in-memory (mock/dev — swap for D1/Durable Objects in production).
const memProducts = new MemoryProductStore();
const carts: CartStore = new Map();
const orders = new OrderStore();
function productStore(env: Bindings | undefined): ProductStore {
  // env is undefined for in-process app.fetch (tests); D1 only exists on a deploy
  // with the binding. Explicit backend choice by binding presence — not a silent
  // fallback masking a missing required value.
  return env?.DB ? new D1ProductStore(env.DB) : memProducts;
}

// atrHash is deterministic per merchant terms; cache it.
const atrCache = new Map<string, string>();
async function atrFor(m: Merchant): Promise<string> {
  const hit = atrCache.get(m.id);
  if (hit) return hit;
  const h = await atrHashOf(m.terms);
  atrCache.set(m.id, h);
  return h;
}

const origin = (url: string): string => new URL(url).origin;
const base = (url: string, id: string): string => `${origin(url)}/${id}`;
const fail = (err: unknown): { error: string } => ({ error: err instanceof Error ? err.message : String(err) });

// Shared order-building body for both checkout paths.
interface OrderBody {
  items?: Array<{ sku: string; variantSku?: string; qty?: number }>;
  shippingOptionId?: string;
  shippingAddress?: Address;
  promoCode?: string;
}

// --- landing + health -----------------------------------------------------

app.get('/', (c) => {
  const rows = MERCHANT_IDS.map(
    (id) => `<li><a href="/${id}/">${MERCHANTS[id]!.name}</a> — <code>/${id}/</code></li>`,
  ).join('');
  return c.html(page('UCP · AP2 · LCP — Mock Merchants', `
    <p>Reference merchant surfaces implementing <b>UCP + AP2 + LCP</b> (testnet/mock).
    Each storefront runs a real agentic checkout that welds the LCP legal-context
    reference into the UCP Checkout object and binds it via AP2 <code>checkout_hash</code>.</p>
    <p><a href="/console"><b>▶ Open the test console</b></a> — exercise every surface (catalog, cart, checkout, pay, order lifecycle).</p>
    <h2>Merchants</h2><ul>${rows}</ul>
    <p class="muted">Per merchant: catalog CRUD (<code>/:id/products</code>), cart
    (<code>/:id/cart</code>), rich checkout (<code>POST /:id/checkout</code>),
    payment (<code>POST /:id/ap2/receipt</code>), orders (<code>/:id/orders/:oid</code>).</p>`));
});

app.get('/health', (c) => c.json({ ok: true, merchants: MERCHANT_IDS }));

// Worker-hosted test console — a single page that exercises every surface.
app.get('/console', (c) => c.html(consolePage(MERCHANT_IDS)));

// Conformance report — Fisher's dev env / CI can hit this to verify the system.
// Runs the self-check suite in-process against the merchant's own routes.
app.get('/report', async (c) => {
  const inproc: FetchLike = async (url, init) => app.fetch(new Request(url, init), c.env);
  const merchants = [];
  for (const id of MERCHANT_IDS) merchants.push(await runReport({ merchantBase: base(c.req.url, id), fetch: inproc, ranAt: new Date().toISOString() }));
  const ok = merchants.every((r) => r.ok);
  return c.json({ ok, merchants }, ok ? 200 : 500);
});

app.get('/:id/report', async (c) => {
  const m = getMerchant(c.req.param('id'));
  const inproc: FetchLike = async (url, init) => app.fetch(new Request(url, init), c.env);
  const report = await runReport({ merchantBase: base(c.req.url, m.id), fetch: inproc, ranAt: new Date().toISOString() });
  return c.json(report, report.ok ? 200 : 500);
});

// --- per-merchant: UCP manifest ------------------------------------------

app.get('/:id/.well-known/ucp', (c) => {
  const m = getMerchant(c.req.param('id'));
  const pub = publicOf(m.signingKey);
  return c.json({
    ucp: {
      version: '2026-04-08',
      services: {
        'dev.ucp.shopping': [
          { version: '2026-04-08', transport: 'rest', endpoint: `${base(c.req.url, m.id)}/checkout`, spec: 'https://ucp.dev/specification/overview' },
        ],
      },
      capabilities: {
        'dev.ucp.shopping.checkout': [{ version: '2026-04-08', spec: 'https://ucp.dev/specification/checkout' }],
        'dev.ucp.shopping.catalog': [{ version: '2026-04-08', spec: 'https://ucp.dev/specification/catalog' }],
        'org.x402.payment': [{ version: '1', spec: 'https://x402.org', resource: `${base(c.req.url, m.id)}/x402/{sku}` }],
        'org.legalcontextprotocol.legal-context': [{ version: '0.1.0', spec: 'https://legalcontextprotocol.org/standard' }],
      },
      payment_handlers: {
        'dev.ucp.mock_payment': [{ id: 'mock-1', version: '2026-04-08', spec: 'https://ucp.dev/mock' }],
        'x402': [{ id: 'x402-base-sepolia', version: '1', network: X402_NETWORK, asset: X402_USDC, spec: 'https://x402.org' }],
      },
    },
    signing_keys: [{ kid: m.kid, kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y, use: 'sig', alg: 'ES256' }],
  });
});

// --- per-merchant: LCP discovery + content-addressed terms ---------------

app.get('/:id/.well-known/legal-context.json', async (c) => {
  const m = getMerchant(c.req.param('id'));
  const doc = await buildLegalContext({
    termsUrl: `${base(c.req.url, m.id)}/terms/${await atrFor(m)}`,
    termsText: m.terms,
    disputeResolution: m.disputeResolution,
  });
  return c.json(doc);
});

app.get('/:id/terms/:atrHash', async (c) => {
  const m = getMerchant(c.req.param('id'));
  const claimed = c.req.param('atrHash');
  if (!ATR_RE.test(claimed)) return c.json({ error: 'invalid atrHash format' }, 400);
  if (claimed.toLowerCase() !== (await atrFor(m))) return c.json({ error: 'unknown atrHash' }, 404);
  return c.body(m.terms, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
});

// --- per-merchant: catalog management (CRUD + bulk import) ----------------

app.get('/:id/catalog', async (c) => {
  const m = getMerchant(c.req.param('id'));
  return c.json({ merchant: m.id, items: await productStore(c.env).list(m.id) });
});

app.get('/:id/products/:sku', async (c) => {
  const m = getMerchant(c.req.param('id'));
  const p = await productStore(c.env).get(m.id, c.req.param('sku'));
  if (!p) return c.json({ error: 'unknown product' }, 404);
  return c.json(p);
});

app.post('/:id/products', async (c) => {
  const m = getMerchant(c.req.param('id'));
  try {
    const product = validateProduct(await c.req.json().catch(() => ({})));
    return c.json(await productStore(c.env).create(m.id, product), 201);
  } catch (err) {
    return c.json(fail(err), 400);
  }
});

app.put('/:id/products/:sku', async (c) => {
  const m = getMerchant(c.req.param('id'));
  try {
    const patch = (await c.req.json().catch(() => ({}))) as Partial<Product>;
    return c.json(await productStore(c.env).update(m.id, c.req.param('sku'), patch));
  } catch (err) {
    return c.json(fail(err), 400);
  }
});

app.delete('/:id/products/:sku', async (c) => {
  const m = getMerchant(c.req.param('id'));
  try {
    await productStore(c.env).remove(m.id, c.req.param('sku'));
    return c.json({ ok: true, removed: c.req.param('sku') });
  } catch (err) {
    return c.json(fail(err), 400);
  }
});

app.post('/:id/products/import', async (c) => {
  const m = getMerchant(c.req.param('id'));
  const body = (await c.req.json().catch(() => ({}))) as { products?: unknown[] };
  if (!Array.isArray(body.products)) return c.json({ error: 'body.products (array) required' }, 400);
  const store = productStore(c.env);
  try {
    const created: string[] = [];
    for (const raw of body.products) {
      const p = validateProduct(raw);
      await store.create(m.id, p);
      created.push(p.sku);
    }
    return c.json({ created, count: created.length }, 201);
  } catch (err) {
    return c.json(fail(err), 400);
  }
});

// --- per-merchant: shipping options / order quote (no signing) ------------

app.post('/:id/orders/quote', async (c) => {
  const m = getMerchant(c.req.param('id'));
  const body = (await c.req.json().catch(() => ({}))) as OrderBody;
  try {
    const order = buildOrder({
      orderId: 'quote',
      merchant: m.id,
      items: (body.items ?? []).map((i) => ({ sku: i.sku, variantSku: i.variantSku, qty: i.qty ?? 1 })),
      products: await productStore(c.env).list(m.id),
      shippingOptionId: body.shippingOptionId,
      shippingAddress: body.shippingAddress,
      promoCode: body.promoCode,
      createdAt: new Date().toISOString(),
    });
    return c.json(order);
  } catch (err) {
    return c.json(fail(err), 400);
  }
});

// --- per-merchant: one-shot UCP checkout (welds the LCP reference) --------

app.post('/:id/checkout', async (c) => {
  const m = getMerchant(c.req.param('id'));
  const body = (await c.req.json().catch(() => ({}))) as OrderBody;
  const products = await productStore(c.env).list(m.id);
  const fallback: NonNullable<OrderBody['items']> = products.slice(0, 1).map((p) => ({ sku: p.sku }));
  const items = (body.items ?? fallback).map((i) => ({ sku: i.sku, variantSku: i.variantSku, qty: i.qty ?? 1 }));
  try {
    return c.json(await signCheckout(c.req.url, m, products, items, body));
  } catch (err) {
    return c.json(fail(err), 400);
  }
});

// --- per-merchant: mutable cart session (add / remove / view / checkout) ---
//   POST   /:id/cart                       → open a session
//   POST   /:id/cart/:sid/items {sku,variantSku?,qty} → add (increments)
//   DELETE /:id/cart/:sid/items/:sku[?variant=] → remove a line
//   GET    /:id/cart/:sid                  → view (priced, running subtotal)
//   POST   /:id/cart/:sid/checkout {shippingOptionId?,shippingAddress?,promoCode?}

app.post('/:id/cart', (c) => {
  const m = getMerchant(c.req.param('id'));
  const cart = createCart(carts, m.id, crypto.randomUUID(), new Date().toISOString());
  return c.json(cartView([], cart), 201);
});

app.get('/:id/cart/:sid', async (c) => {
  const m = getMerchant(c.req.param('id'));
  try {
    return c.json(cartView(await productStore(c.env).list(m.id), getCart(carts, m.id, c.req.param('sid'))));
  } catch (err) {
    return c.json(fail(err), 404);
  }
});

app.post('/:id/cart/:sid/items', async (c) => {
  const m = getMerchant(c.req.param('id'));
  const body = (await c.req.json().catch(() => ({}))) as { sku?: string; variantSku?: string; qty?: number };
  if (!body.sku) return c.json({ error: 'sku required' }, 400);
  try {
    const products = await productStore(c.env).list(m.id);
    const cart = addItem(carts, m.id, c.req.param('sid'), products, body.sku, body.variantSku, body.qty ?? 1);
    return c.json(cartView(products, cart));
  } catch (err) {
    return c.json(fail(err), 400);
  }
});

app.delete('/:id/cart/:sid/items/:sku', async (c) => {
  const m = getMerchant(c.req.param('id'));
  try {
    const cart = removeItem(carts, m.id, c.req.param('sid'), c.req.param('sku'), c.req.query('variant'));
    return c.json(cartView(await productStore(c.env).list(m.id), cart));
  } catch (err) {
    return c.json(fail(err), 400);
  }
});

app.post('/:id/cart/:sid/checkout', async (c) => {
  const m = getMerchant(c.req.param('id'));
  const body = (await c.req.json().catch(() => ({}))) as OrderBody;
  try {
    const cart = markCheckedOut(carts, m.id, c.req.param('sid'));
    const products = await productStore(c.env).list(m.id);
    const items = cart.items.map((l) => ({ sku: l.sku, variantSku: l.variant_sku, qty: l.qty }));
    const result = await signCheckout(c.req.url, m, products, items, body, cart.id);
    return c.json({ ...result, session_id: cart.id });
  } catch (err) {
    return c.json(fail(err), 400);
  }
});

// --- per-merchant: AP2 receipt (verify the mandate bundle → pay) ----------

app.post('/:id/ap2/receipt', async (c) => {
  const m = getMerchant(c.req.param('id'));
  const body = (await c.req.json().catch(() => null)) as { checkout_jwt?: string; bundle?: MandateBundle } | null;
  if (!body?.checkout_jwt || !body.bundle) return c.json({ error: 'checkout_jwt and bundle required' }, 400);
  try {
    const receipt = await verifyAndReceipt({
      merchant: m,
      checkout_jwt: body.checkout_jwt,
      bundle: body.bundle,
      orderId: crypto.randomUUID(),
      iat: Math.floor(Date.now() / 1000),
    });
    // Advance the stored order (if this checkout came from our routes) to paid.
    let order_status: OrderStatus | undefined;
    try {
      const order = orders.get(m.id, receipt.checkout_id);
      advanceStatus(order, 'paid', new Date().toISOString());
      order.checkout_hash = receipt.checkout_hash;
      order.payment = receipt.payment;
      order_status = order.status;
    } catch {
      // no stored order (e.g. a checkout signed outside these routes) — receipt still valid
    }
    return c.json({ ...receipt, order_status });
  } catch (err) {
    return c.json({ status: 'declined', error: err instanceof Error ? err.message : String(err) }, 422);
  }
});

// --- per-merchant: x402 (HTTP-402 pay-per-request) ------------------------
// Same catalog, same LCP weld, a different rail. No X-PAYMENT → 402 + payment
// requirements; a valid X-PAYMENT → 200 + the resource + X-PAYMENT-RESPONSE.

app.all('/:id/x402/:sku', async (c) => {
  const m = getMerchant(c.req.param('id'));
  const product = await productStore(c.env).get(m.id, c.req.param('sku'));
  if (!product) return c.json({ error: 'unknown product' }, 404);
  let unitPrice;
  try {
    unitPrice = resolveVariant(product, c.req.query('variant')).unit_price;
  } catch (err) {
    return c.json(fail(err), 400);
  }
  const atr = await atrFor(m);
  const req = buildX402Requirements({
    product,
    unitPrice,
    resource: `${base(c.req.url, m.id)}/x402/${product.sku}`,
    atrHash: atr,
    termsUrl: `${base(c.req.url, m.id)}/.well-known/legal-context.json`,
    payTo: m.payTo,
  });
  const xp = c.req.header('X-PAYMENT');
  if (!xp) return c.json(build402Body([req], 'X-PAYMENT header is required'), 402);
  try {
    const settlement = await verifyX402Payment(xp, req);
    c.header('X-PAYMENT-RESPONSE', encodeSettlement(settlement));
    return c.json({ paid: true, sku: product.sku, result: { delivered: product.name, sku: product.sku }, settlement, lcp_reference: lcpReference(atr) });
  } catch (err) {
    return c.json(build402Body([req], err instanceof Error ? err.message : String(err)), 402);
  }
});

// --- per-merchant: order lifecycle ----------------------------------------

app.get('/:id/orders/:oid', (c) => {
  const m = getMerchant(c.req.param('id'));
  try {
    return c.json(orders.get(m.id, c.req.param('oid')));
  } catch (err) {
    return c.json(fail(err), 404);
  }
});

const transition = (to: OrderStatus) => (c: Context<{ Bindings: Bindings }>) => {
  const m = getMerchant(c.req.param('id') ?? '');
  const oid = c.req.param('oid');
  if (!oid) return c.json({ error: 'order id required' }, 400);
  try {
    const order = advanceStatus(orders.get(m.id, oid), to, new Date().toISOString());
    return c.json(order);
  } catch (err) {
    return c.json(fail(err), 400);
  }
};
app.post('/:id/orders/:oid/fulfill', transition('fulfilled'));
app.post('/:id/orders/:oid/ship', transition('shipped'));
app.post('/:id/orders/:oid/deliver', transition('delivered'));
app.post('/:id/orders/:oid/cancel', transition('cancelled'));

// --- shared: build the order, sign the checkout, store the order ----------

async function signCheckout(
  reqUrl: string,
  m: Merchant,
  products: Product[],
  items: Array<{ sku: string; variantSku?: string; qty: number }>,
  body: OrderBody,
  orderId: string = crypto.randomUUID(),
): Promise<Record<string, unknown>> {
  const createdAt = new Date().toISOString();
  const order = buildOrder({
    orderId,
    merchant: m.id,
    items,
    products,
    shippingOptionId: body.shippingOptionId,
    shippingAddress: body.shippingAddress,
    promoCode: body.promoCode,
    createdAt,
  });
  orders.put(order);
  const result = await buildSignedCheckout({
    merchant: m,
    order,
    atrHash: await atrFor(m),
    legalContextUrl: `${base(reqUrl, m.id)}/.well-known/legal-context.json`,
    disputeResolution: m.disputeResolution,
    createdAt,
  });
  return { ...result, order_id: order.order_id, lcp_reference: lcpReference(await atrFor(m)) };
}

// --- per-merchant: absolute-minimum storefront ----------------------------

app.get('/:id', async (c) => {
  const m = getMerchant(c.req.param('id'));
  const atr = await atrFor(m);
  const products = await productStore(c.env).list(m.id);
  const items = products
    .map((it) => {
      const v = it.variants.length ? ` <span class="muted">(${it.variants.length} variants)</span>` : '';
      return `<label class="row"><input type="checkbox" data-sku="${it.sku}"> ${it.name} — $${(it.price.amount / 100).toFixed(2)}${v}</label>`;
    })
    .join('');
  return c.html(page(`${m.name} — Storefront`, `
    <p><a href="/">← all merchants</a></p>
    <h2>${m.name}</h2>
    <p class="muted">UCP merchant · LCP ${m.disputeResolution.method} (${m.disputeResolution.jurisdiction})</p>
    <p>
      <a href="/${m.id}/.well-known/ucp">UCP manifest</a> ·
      <a href="/${m.id}/.well-known/legal-context.json">legal-context.json</a> ·
      <a href="/${m.id}/terms/${atr}">terms</a> ·
      <a href="/${m.id}/catalog">catalog</a>
    </p>
    <h3>Catalog</h3>
    <form id="cart">${items}</form>
    <p><button id="buy">Run agentic checkout (UCP + AP2 + LCP)</button></p>
    <pre id="out" class="out">Select items and run a checkout…</pre>
    <script>
      const out = document.getElementById('out');
      document.getElementById('buy').onclick = async () => {
        const items = [...document.querySelectorAll('#cart input:checked')].map(i => ({ sku: i.dataset.sku, qty: 1 }));
        if (!items.length) { out.textContent = 'Select at least one item.'; return; }
        out.textContent = 'Running…';
        const r = await fetch('/${m.id}/checkout', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ items }) });
        const j = await r.json();
        out.textContent = JSON.stringify({
          checkout_hash: j.checkout_hash,
          lcp_reference: j.lcp_reference,
          'extensions[legal-context]': j.checkout?.extensions?.['org.legalcontextprotocol.legal-context'],
          totals: j.checkout?.order?.totals,
          delivery_estimate: j.checkout?.order?.delivery_estimate
        }, null, 2);
      };
    </script>`));
});

function page(title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
 body{font:15px/1.55 system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#111}
 h1,h2,h3{font-weight:600} a{color:#0b57d0} code{background:#f2f2f2;padding:.1em .3em;border-radius:3px}
 .muted{color:#666;font-size:.9em} .row{display:block;padding:.15rem 0}
 button{font:inherit;padding:.5rem .9rem;border:1px solid #0b57d0;background:#0b57d0;color:#fff;border-radius:6px;cursor:pointer}
 .out{background:#0d1117;color:#c9d1d9;padding:1rem;border-radius:8px;overflow:auto;font-size:12px;white-space:pre-wrap}
 ul{padding-left:1.2rem}
</style></head><body>
<h1>${title}</h1>
${bodyHtml}
<p class="muted" style="margin-top:2rem">Mock merchants · testnet/no real value · <a href="https://legalcontextprotocol.org">LCP</a></p>
</body></html>`;
}

export default app;
