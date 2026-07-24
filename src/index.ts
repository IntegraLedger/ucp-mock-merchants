// UCP + AP2 + LCP mock merchants — a single Cloudflare Worker serving N merchants.
// Each merchant exposes: a UCP manifest, a legal-context discovery doc + content-
// addressed terms, a UCP checkout that welds in the LCP reference, AP2 mandate
// verification + receipt, a catalog, and an absolute-minimum HTML storefront.
//
// No external LCP packages (self-contained; field shapes match @legalcontext/*).
// Testnet/mock posture: throwaway keys, mock payment handler, no real value.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getMerchant, MERCHANTS, MERCHANT_IDS, type Merchant } from './merchants.js';
import { atrHashOf, publicOf } from './lib/crypto.js';
import { buildLegalContext, lcpReference } from './lib/lcp.js';
import { buildSignedCheckout } from './lib/checkout.js';
import { verifyAndReceipt, type MandateBundle } from './lib/ap2.js';
import { type CartStore, createCart, addItem, removeItem, getCart, markCheckedOut, cartView } from './lib/cart.js';

type Bindings = Record<string, never>;
const app = new Hono<{ Bindings: Bindings }>();

app.use('*', cors());
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
});

const ATR_RE = /^0x[0-9a-fA-F]{64}$/;

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

// In-memory cart sessions (MOCK/DEV — not durable across production isolates;
// back with D1 or a Durable Object for real use). Keyed by session id.
const carts: CartStore = new Map();
// Turn any thrown cart/checkout error into a 4xx instead of a 500.
const fail = (err: unknown): { error: string } => ({ error: err instanceof Error ? err.message : String(err) });

// --- landing + health -----------------------------------------------------

app.get('/', (c) => {
  const rows = MERCHANT_IDS.map(
    (id) => `<li><a href="/${id}/">${MERCHANTS[id]!.name}</a> — <code>/${id}/</code></li>`,
  ).join('');
  return c.html(page('UCP · AP2 · LCP — Mock Merchants', `
    <p>Reference merchant surfaces implementing <b>UCP + AP2 + LCP</b> (testnet/mock).
    Each storefront runs a real agentic checkout that welds the LCP legal-context
    reference into the UCP Checkout object and binds it via AP2 <code>checkout_hash</code>.</p>
    <h2>Merchants</h2><ul>${rows}</ul>
    <p class="muted">APIs per merchant: <code>/:id/.well-known/ucp</code> ·
    <code>/:id/.well-known/legal-context.json</code> · <code>/:id/terms/:atrHash</code> ·
    <code>POST /:id/checkout</code> · <code>POST /:id/ap2/receipt</code>.</p>`));
});

app.get('/health', (c) => c.json({ ok: true, merchants: MERCHANT_IDS }));

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
        'org.legalcontextprotocol.legal-context': [{ version: '0.1.0', spec: 'https://legalcontextprotocol.org/standard' }],
      },
      payment_handlers: {
        'dev.ucp.mock_payment': [{ id: 'mock-1', version: '2026-04-08', spec: 'https://ucp.dev/mock' }],
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

// --- per-merchant: catalog ------------------------------------------------

app.get('/:id/catalog', (c) => {
  const m = getMerchant(c.req.param('id'));
  return c.json({ merchant: m.id, items: m.catalog });
});

// --- per-merchant: UCP checkout (welds the LCP reference) -----------------

app.post('/:id/checkout', async (c) => {
  const m = getMerchant(c.req.param('id'));
  const body = (await c.req.json().catch(() => ({}))) as { items?: Array<{ sku: string; qty: number }> };
  const items = body.items ?? m.catalog.slice(0, 1).map((it) => ({ sku: it.sku, qty: 1 }));
  const result = await buildSignedCheckout({
    merchant: m,
    items,
    atrHash: await atrFor(m),
    legalContextUrl: `${base(c.req.url, m.id)}/.well-known/legal-context.json`,
    disputeResolution: m.disputeResolution,
    checkoutId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });
  return c.json({ ...result, lcp_reference: lcpReference(await atrFor(m)) });
});

// --- per-merchant: mutable cart session (add / remove / view / checkout) ---
// Stateful alternative to the one-shot POST /checkout above:
//   POST   /:id/cart                       → open a session
//   POST   /:id/cart/:sid/items {sku,qty}  → add (increments if present)
//   DELETE /:id/cart/:sid/items/:sku       → remove a line
//   GET    /:id/cart/:sid                  → view (priced, running total)
//   POST   /:id/cart/:sid/checkout         → sign the UCP Checkout from the cart

app.post('/:id/cart', (c) => {
  const m = getMerchant(c.req.param('id'));
  const cart = createCart(carts, m.id, crypto.randomUUID(), new Date().toISOString());
  return c.json(cartView(m, cart), 201);
});

app.get('/:id/cart/:sid', (c) => {
  const m = getMerchant(c.req.param('id'));
  try {
    return c.json(cartView(m, getCart(carts, m.id, c.req.param('sid'))));
  } catch (err) {
    return c.json(fail(err), 404);
  }
});

app.post('/:id/cart/:sid/items', async (c) => {
  const m = getMerchant(c.req.param('id'));
  const body = (await c.req.json().catch(() => ({}))) as { sku?: string; qty?: number };
  if (!body.sku) return c.json({ error: 'sku required' }, 400);
  try {
    const cart = addItem(carts, m, c.req.param('sid'), body.sku, body.qty ?? 1);
    return c.json(cartView(m, cart));
  } catch (err) {
    return c.json(fail(err), 400);
  }
});

app.delete('/:id/cart/:sid/items/:sku', (c) => {
  const m = getMerchant(c.req.param('id'));
  try {
    const cart = removeItem(carts, m.id, c.req.param('sid'), c.req.param('sku'));
    return c.json(cartView(m, cart));
  } catch (err) {
    return c.json(fail(err), 400);
  }
});

app.post('/:id/cart/:sid/checkout', async (c) => {
  const m = getMerchant(c.req.param('id'));
  try {
    const cart = markCheckedOut(carts, m.id, c.req.param('sid'));
    const result = await buildSignedCheckout({
      merchant: m,
      items: cart.items,
      atrHash: await atrFor(m),
      legalContextUrl: `${base(c.req.url, m.id)}/.well-known/legal-context.json`,
      disputeResolution: m.disputeResolution,
      checkoutId: cart.id, // the checkout is keyed to the cart session
      createdAt: new Date().toISOString(),
    });
    return c.json({ ...result, session_id: cart.id, lcp_reference: lcpReference(await atrFor(m)) });
  } catch (err) {
    return c.json(fail(err), 400);
  }
});

// --- per-merchant: AP2 receipt (verify the mandate bundle) ----------------

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
    return c.json(receipt);
  } catch (err) {
    return c.json({ status: 'declined', error: err instanceof Error ? err.message : String(err) }, 422);
  }
});

// --- per-merchant: absolute-minimum storefront ----------------------------

app.get('/:id', async (c) => {
  const m = getMerchant(c.req.param('id'));
  const atr = await atrFor(m);
  const items = m.catalog
    .map((it) => `<label class="row"><input type="checkbox" data-sku="${it.sku}"> ${it.name} — $${(it.price.amount / 100).toFixed(2)}</label>`)
    .join('');
  return c.html(page(`${m.name} — Storefront`, `
    <p><a href="/">← all merchants</a></p>
    <h2>${m.name}</h2>
    <p class="muted">UCP merchant · LCP ${m.disputeResolution.method} (${m.disputeResolution.jurisdiction})</p>
    <p>
      <a href="/${m.id}/.well-known/ucp">UCP manifest</a> ·
      <a href="/${m.id}/.well-known/legal-context.json">legal-context.json</a> ·
      <a href="/${m.id}/terms/${atr}">terms</a>
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
          'extensions[legal-context]': j.checkout.extensions['org.legalcontextprotocol.legal-context'],
          links: j.checkout.links,
          total: j.checkout.total
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
