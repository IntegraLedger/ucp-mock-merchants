// A conformance / self-check report — the thing Fisher's dev environment (or CI)
// calls to verify a merchant is behaving correctly end-to-end. It runs a battery
// of checks against a merchant over HTTP (a live URL or the Worker's own
// app.fetch) and returns a structured, machine-readable report.
//
// Exposed three ways: GET /:m/report and GET /report (server-side self-check),
// and `pnpm report [url]` (CLI, non-zero exit on failure — CI-friendly).

import { verifyJws, type PrivateJwk, type PublicJwk } from './lib/crypto.js';
import { buildMandateBundle } from './lib/ap2.js';
import { LCP_EXTENSION_KEY } from './lib/lcp.js';
import { buildMockPaymentHeader, type PaymentRequirements } from './lib/x402.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Report {
  merchant: string;
  base: string;
  ok: boolean;
  passed: number;
  failed: number;
  checks: Check[];
  ran_at: string;
}

async function newKey(): Promise<PrivateJwk> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as PrivateJwk;
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d };
}

export interface RunReportOptions {
  merchantBase: string; // e.g. https://host/homegoods (trailing slash tolerated)
  fetch: FetchLike;
  ranAt: string; // injected ISO timestamp
}

/** Run the conformance suite against one merchant. Never throws — every failure
 *  becomes a failed Check with a detail string. */
export async function runReport(o: RunReportOptions): Promise<Report> {
  const base = o.merchantBase.replace(/\/+$/, '');
  const checks: Check[] = [];
  const get = async (p: string): Promise<Response> => o.fetch(`${base}${p}`);
  const post = (p: string, b: unknown): Promise<Response> =>
    o.fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

  // Each check is a labelled async assertion. `run` records ok + detail, and
  // returns whatever the body produced so later checks can build on it.
  async function run<T>(name: string, fn: () => Promise<[boolean, string, T?]>): Promise<T | undefined> {
    try {
      const [ok, detail, value] = await fn();
      checks.push({ name, ok, detail });
      return value;
    } catch (err) {
      checks.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  }

  const manifest = await run<{ pub: PublicJwk; kid: string }>('ucp-manifest', async () => {
    const j = (await (await get('/.well-known/ucp')).json()) as { signing_keys?: Array<{ kid: string; kty: 'EC'; crv: 'P-256'; x: string; y: string; alg: string }> };
    const sk = j.signing_keys?.[0];
    if (!sk) return [false, 'no signing key in manifest'];
    if (sk.alg !== 'ES256') return [false, `unexpected alg ${sk.alg}`];
    return [true, `signing key kid=${sk.kid} alg=${sk.alg}`, { pub: { kty: sk.kty, crv: sk.crv, x: sk.x, y: sk.y }, kid: sk.kid }];
  });

  const lc = await run<{ atrHash: string; terms: string; hasDR: boolean }>('lcp-discovery', async () => {
    const j = (await (await get('/.well-known/legal-context.json')).json()) as { atrHash?: string; terms?: string; disputeResolution?: { method?: string } };
    if (!j.atrHash || !/^0x[0-9a-f]{64}$/i.test(j.atrHash)) return [false, `bad atrHash: ${j.atrHash}`];
    if (!j.terms || !j.terms.startsWith('https://')) return [false, `terms url not https: ${j.terms}`];
    return [true, `atrHash=${j.atrHash.slice(0, 12)}… DR=${j.disputeResolution?.method ?? 'none'}`, { atrHash: j.atrHash, terms: j.terms, hasDR: !!j.disputeResolution?.method }];
  });

  await run('terms-hash-matches', async () => {
    if (!lc) return [false, 'no legal-context'];
    const text = await (await o.fetch(lc.terms)).text();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text) as BufferSource);
    const hash = '0x' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return [hash === lc.atrHash, hash === lc.atrHash ? 'recomputed hash equals declared atrHash (L2)' : `mismatch ${hash} != ${lc.atrHash}`];
  });

  await run('terms-format-guard', async () => {
    const r = await get('/terms/0xshort');
    return [r.status === 400, `truncated atrHash → HTTP ${r.status} (want 400)`];
  });

  await run('catalog-nonempty', async () => {
    const j = (await (await get('/catalog')).json()) as { items?: unknown[] };
    const n = j.items?.length ?? 0;
    return [n > 0, `${n} products`];
  });

  await run('product-crud', async () => {
    const sku = 'report-probe';
    await o.fetch(`${base}/products/${sku}`, { method: 'DELETE' }); // clean any leftover
    const create = await post('/products', { sku, name: 'Report Probe', price: { amount: 123, currency: 'USD' } });
    if (create.status !== 201) return [false, `create → HTTP ${create.status}`];
    const upd = await o.fetch(`${base}/products/${sku}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ price: { amount: 456, currency: 'USD' } }) });
    const updated = (await upd.json()) as { price?: { amount: number } };
    if (updated.price?.amount !== 456) return [false, 'update did not persist'];
    const del = await o.fetch(`${base}/products/${sku}`, { method: 'DELETE' });
    const gone = await get(`/products/${sku}`);
    return [del.status === 200 && gone.status === 404, `create/update/delete ok (delete ${del.status}, get-after ${gone.status})`];
  });

  const quote = await run<{ currency: string }>('order-quote-math', async () => {
    const cat = (await (await get('/catalog')).json()) as { items?: Array<{ sku: string }> };
    const sku = cat.items?.[0]?.sku;
    if (!sku) return [false, 'no product to quote'];
    const j = (await (await post('/orders/quote', { items: [{ sku, qty: 1 }], shippingAddress: { name: 'R', line1: '1', city: 'C', region: 'NY', postal: '0', country: 'US' } })).json()) as {
      totals?: { subtotal: { amount: number }; discount: { amount: number }; shipping: { amount: number }; tax: { amount: number }; total: { amount: number; currency: string } };
    };
    const t = j.totals;
    if (!t) return [false, 'no totals in quote'];
    const expect = t.subtotal.amount - t.discount.amount + t.shipping.amount + t.tax.amount;
    return [expect === t.total.amount, `total ${t.total.amount} = subtotal − discount + shipping + tax (${expect})`, { currency: t.total.currency }];
  });

  const co = await run<{ checkout_jwt: string; checkout_hash: string; order_id: string; total: { amount: number; currency: string }; merchant: { id: string; name: string } }>('checkout-welds-lcp', async () => {
    const cat = (await (await get('/catalog')).json()) as { items?: Array<{ sku: string }> };
    const sku = cat.items?.[0]?.sku;
    if (!sku) return [false, 'no product to checkout'];
    const j = (await (await post('/checkout', { items: [{ sku, qty: 1 }] })).json()) as {
      checkout_jwt?: string; checkout_hash?: string; order_id?: string;
      checkout?: { total: { amount: number; currency: string }; merchant: { id: string; name: string }; extensions: Record<string, { value?: string }>; links: Array<{ type: string }> };
    };
    if (!j.checkout_jwt || !j.checkout_hash || !j.checkout) return [false, 'checkout missing jwt/hash'];
    const ext = j.checkout.extensions[LCP_EXTENSION_KEY];
    const tierA = j.checkout.links.some((l) => l.type === 'terms_of_service');
    if (!ext?.value || ext.value !== lc?.atrHash) return [false, `Tier-B reference ${ext?.value} != atrHash`];
    if (!tierA) return [false, 'no Tier-A terms_of_service link'];
    return [true, `signed checkout welds atrHash (Tier A + B)`, { checkout_jwt: j.checkout_jwt, checkout_hash: j.checkout_hash, order_id: j.order_id ?? '', total: j.checkout.total, merchant: j.checkout.merchant }];
  });

  await run('checkout-signature', async () => {
    if (!co || !manifest) return [false, 'no checkout / manifest'];
    const v = await verifyJws(co.checkout_jwt, manifest.pub);
    return [v.ok, v.ok ? 'checkout_jwt verifies under manifest key' : 'signature does not verify'];
  });

  const buyerKey = await newKey();
  await run('ap2-pay', async () => {
    if (!co) return [false, 'no checkout'];
    const bundle = await buildMandateBundle({ checkout_jwt: co.checkout_jwt, checkout_hash: co.checkout_hash, payee: co.merchant, amount: co.total, buyerKey, iat: 1_800_000_000 });
    const j = (await (await post('/ap2/receipt', { checkout_jwt: co.checkout_jwt, bundle })).json()) as { status?: string; payment?: { status?: string }; order_status?: string };
    const ok = j.status === 'authorized' && j.payment?.status === 'captured';
    return [ok, ok ? `authorized · payment ${j.payment?.status} · order ${j.order_status}` : `not authorized: ${JSON.stringify(j)}`];
  });

  await run('tamper-rejected', async () => {
    if (!co) return [false, 'no checkout'];
    const bundle = await buildMandateBundle({ checkout_jwt: co.checkout_jwt, checkout_hash: co.checkout_hash, payee: co.merchant, amount: co.total, buyerKey, iat: 1_800_000_000 });
    const tampered = co.checkout_jwt.slice(0, -2) + 'zz';
    const r = await post('/ap2/receipt', { checkout_jwt: tampered, bundle });
    return [r.status === 422, `tampered checkout → HTTP ${r.status} (want 422)`];
  });

  await run('x402-flow', async () => {
    const cat = (await (await get('/catalog')).json()) as { items?: Array<{ sku: string }> };
    const sku = cat.items?.[0]?.sku;
    if (!sku) return [false, 'no product for x402'];
    const chal = await get(`/x402/${sku}`);
    if (chal.status !== 402) return [false, `no-payment request → HTTP ${chal.status} (want 402)`];
    const body = (await chal.json()) as { accepts?: PaymentRequirements[] };
    const rq = body.accepts?.[0];
    if (!rq?.maxAmountRequired) return [false, '402 body missing payment requirements'];
    const ext = rq.extra?.[LCP_EXTENSION_KEY] as { value?: string } | undefined;
    if (ext?.value !== lc?.atrHash) return [false, 'x402 requirement missing LCP weld'];
    const header = buildMockPaymentHeader(rq, '0x' + 'ab'.repeat(20));
    const paid = await o.fetch(`${base}/x402/${sku}`, { headers: { 'X-PAYMENT': header } });
    const pj = (await paid.json()) as { settlement?: { success?: boolean; transaction?: string } };
    const ok = paid.status === 200 && !!pj.settlement?.success && !!paid.headers.get('X-PAYMENT-RESPONSE');
    return [ok, ok ? `402 → pay → settled tx ${pj.settlement!.transaction!.slice(0, 12)}…` : `pay → HTTP ${paid.status}`];
  });

  await run('order-lifecycle', async () => {
    if (!co?.order_id) return [false, 'no order id'];
    const step = async (a: string): Promise<string> => ((await (await post(`/orders/${co.order_id}/${a}`, {})).json()) as { status?: string }).status ?? '?';
    const f = await step('fulfill'), s = await step('ship'), d = await step('deliver');
    const illegal = await post(`/orders/${co.order_id}/fulfill`, {});
    const ok = f === 'fulfilled' && s === 'shipped' && d === 'delivered' && illegal.status === 400;
    return [ok, `fulfilled→shipped→delivered ok; illegal re-fulfill → ${illegal.status}`];
  });

  await run('mcp-tools', async () => {
    const init = (await (await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).json()) as { result?: { protocolVersion?: string } };
    if (!init.result?.protocolVersion) return [false, 'initialize failed'];
    const list = (await (await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as { result?: { tools?: unknown[] } };
    const tools = list.result?.tools ?? [];
    const cat = (await (await get('/catalog')).json()) as { items?: Array<{ sku: string }> };
    const call = (await (await post('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_checkout', arguments: { items: [{ sku: cat.items?.[0]?.sku, qty: 1 }] } } })).json()) as { result?: { content?: Array<{ text?: string }> } };
    const okCheckout = (call.result?.content?.[0]?.text ?? '').includes('checkout_jwt');
    return [tools.length > 0 && okCheckout, `initialize ok · ${tools.length} tools · create_checkout → ${okCheckout ? 'checkout_jwt' : 'no jwt'}`];
  });

  await run('a2a-agent', async () => {
    const card = (await (await get('/.well-known/agent.json')).json()) as { skills?: unknown[]; [k: string]: unknown };
    const skills = card.skills ?? [];
    const ext = card[LCP_EXTENSION_KEY] as { value?: string } | undefined;
    if (skills.length === 0) return [false, 'agent card has no skills'];
    if (ext?.value !== lc?.atrHash) return [false, 'agent card missing LCP weld'];
    const cat = (await (await get('/catalog')).json()) as { items?: Array<{ sku: string }> };
    const task = (await (await post('/a2a', { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', parts: [{ kind: 'data', data: { action: 'checkout', items: [{ sku: cat.items?.[0]?.sku, qty: 1 }] } }] } } })).json()) as { result?: { status?: { state?: string }; artifacts?: Array<{ parts?: Array<{ data?: { checkout_jwt?: string } }> }> } };
    const ok = task.result?.status?.state === 'completed' && !!task.result?.artifacts?.[0]?.parts?.[0]?.data?.checkout_jwt;
    return [ok, `card ${skills.length} skills + LCP · task ${task.result?.status?.state}`];
  });

  await run('acp-session', async () => {
    const cat = (await (await get('/catalog')).json()) as { items?: Array<{ sku: string }> };
    const create = (await (await post('/acp/checkout_sessions', { items: [{ sku: cat.items?.[0]?.sku, qty: 1 }], fulfillment_address: { name: 'R', line1: '1', city: 'C', region: 'NY', postal: '0', country: 'US' } })).json()) as { id?: string; status?: string; totals?: Array<{ type: string; amount: number }> };
    if (create.status !== 'ready_for_payment') return [false, `create status ${create.status}`];
    const total = create.totals?.find((t) => t.type === 'total');
    const done = (await (await post(`/acp/checkout_sessions/${create.id}/complete`, {})).json()) as { status?: string };
    return [done.status === 'completed', `ready_for_payment → completed (total ${total?.amount})`];
  });

  const passed = checks.filter((c) => c.ok).length;
  return { merchant: base.split('/').pop() ?? base, base, ok: passed === checks.length, passed, failed: checks.length - passed, checks, ran_at: o.ranAt };
}
