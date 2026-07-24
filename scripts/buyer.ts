// Run the reference buyer against a merchant and print the step-by-step trace.
//
// In-process by default — it drives the Worker's own `app.fetch`, so there's no
// server to start and no deploy. Pass a live base URL to run over the network.
//
//   pnpm buyer                             # in-process, merchant = homegoods
//   pnpm buyer apihub                      # in-process, pick a merchant id
//   pnpm buyer https://<host>/homegoods    # against a live deployment
//
// This is a WORKED EXAMPLE of a buyer, not a library entry point — the reusable
// logic lives in src/buyer.ts.

import app from '../src/index.js';
import { runBuyer, type FetchLike } from '../src/buyer.js';
import { MERCHANT_IDS } from '../src/merchants.js';
import type { PrivateJwk } from '../src/lib/crypto.js';

async function newBuyerKey(): Promise<PrivateJwk> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as PrivateJwk;
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d };
}

// The Worker, driven directly — a Request in, a Response out, no network. HTTPS
// host because the legal-context route requires absolute-HTTPS terms URLs.
const inProcessFetch: FetchLike = async (url, init) => app.fetch(new Request(url, init));

async function catalogSkus(fetchLike: FetchLike, base: string): Promise<Array<{ sku: string; qty: number }>> {
  const r = await fetchLike(`${base}/catalog`);
  if (!r.ok) throw new Error(`GET ${base}/catalog → HTTP ${r.status}`);
  const j = (await r.json()) as { items: Array<{ sku: string }> };
  return j.items.slice(0, 2).map((it) => ({ sku: it.sku, qty: 1 })); // buy the first couple
}

async function main(): Promise<void> {
  const arg = process.argv[2] ?? 'homegoods';
  const isUrl = arg.startsWith('http://') || arg.startsWith('https://');

  const fetchLike: FetchLike = isUrl ? (u, i) => fetch(u, i) : inProcessFetch;
  const base = isUrl ? arg.replace(/\/+$/, '') : `https://mock.local/${arg}`;

  if (!isUrl && !MERCHANT_IDS.includes(arg)) {
    console.error(`unknown merchant "${arg}" — try one of: ${MERCHANT_IDS.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  console.log(`buyer → ${base}${isUrl ? '' : '  (in-process)'}\n`);

  const items = await catalogSkus(fetchLike, base);
  const outcome = await runBuyer({
    merchantBase: base,
    items,
    buyerKey: await newBuyerKey(),
    iat: 1_800_000_000, // fixed injected time
    fetch: fetchLike,
    policy: {
      requireDisputeResolution: true, // won't pay a merchant with no dispute path
      maxTotal: { amount: 2_000_000, currency: 'USD' }, // $20,000 budget cap
    },
  });

  for (const s of outcome.steps) console.log(`${s.ok ? '✓' : '✗'} ${s.step.padEnd(20)} ${s.detail}`);
  console.log(outcome.authorized ? '\nAUTHORIZED' : `\nDECLINED: ${outcome.declinedReason}`);
  if (!outcome.authorized) process.exitCode = 1;
}

void main();
