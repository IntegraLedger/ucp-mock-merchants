// End-to-end smoke: in-process (Web Crypto), no deploy needed. Runs the full
// UCP + AP2 + LCP flow against a mock merchant and proves the LCP reference is
// bound and tamper-evident. Run with: pnpm smoke  (or: npx tsx scripts/smoke.ts)

import { atrHashOf, verifyJws, publicOf, type PrivateJwk } from '../src/lib/crypto.js';
import { verifyTermsHash } from '../src/lib/lcp.js';
import { buildSignedCheckout } from '../src/lib/checkout.js';
import { buildMandateBundle, verifyAndReceipt } from '../src/lib/ap2.js';
import { buildOrder } from '../src/lib/order.js';
import { SEED } from '../src/lib/catalog.js';
import { getMerchant } from '../src/merchants.js';

const log = (ok: boolean, msg: string) => console.log(`${ok ? '✓' : '✗'} ${msg}`);
let failures = 0;
const assert = (cond: boolean, msg: string) => { log(cond, msg); if (!cond) failures++; };

async function newBuyerKey(): Promise<PrivateJwk> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as PrivateJwk;
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d };
}

async function main(): Promise<void> {
  const m = getMerchant('homegoods');
  const atrHash = await atrHashOf(m.terms);
  const buyerKey = await newBuyerKey();
  const now = 1_800_000_000; // fixed injected time

  // 1. Merchant prices an order + produces a signed UCP checkout with the LCP reference welded in.
  const order = buildOrder({
    orderId: 'chk_smoke_1',
    merchant: m.id,
    items: [{ sku: 'rug-9x12', qty: 1 }],
    products: SEED.homegoods!,
    shippingAddress: { name: 'A Buyer', line1: '1 Main', city: 'NYC', region: 'NY', postal: '10001', country: 'US' },
    createdAt: '2026-07-24T00:00:00Z',
  });
  const co = await buildSignedCheckout({
    merchant: m,
    order,
    atrHash,
    legalContextUrl: 'https://example.com/homegoods/.well-known/legal-context.json',
    disputeResolution: m.disputeResolution,
    createdAt: '2026-07-24T00:00:00Z',
  });
  const ext = co.checkout.extensions['org.legalcontextprotocol.legal-context'] as { value: string };
  assert(ext.value === atrHash, 'Tier-B extension carries the atrHash');
  assert(co.checkout.links[0]!.type === 'terms_of_service', 'Tier-A terms_of_service link present');
  assert(!!co.checkout_jwt && !!co.checkout_hash, 'checkout signed → checkout_jwt + checkout_hash');

  // 2. The checkout signature verifies under the merchant key.
  const cov = await verifyJws(co.checkout_jwt, publicOf(m.signingKey));
  assert(cov.ok, 'checkout_jwt verifies under the merchant signing key');

  // 3. LCP integrity: recompute the terms hash → equals the bound reference.
  assert(await verifyTermsHash(m.terms, ext.value), 'terms bytes recompute to the bound atrHash (L2)');

  // 4. Buyer wraps it in AP2 mandates; merchant verifies + issues a receipt.
  const bundle = await buildMandateBundle({
    checkout_jwt: co.checkout_jwt,
    checkout_hash: co.checkout_hash,
    payee: { id: m.id, name: m.name },
    amount: co.checkout.total,
    buyerKey,
    iat: now,
  });
  const receipt = await verifyAndReceipt({ merchant: m, checkout_jwt: co.checkout_jwt, bundle, orderId: 'ord_1', iat: now });
  assert(receipt.status === 'authorized', 'AP2 mandate bundle verifies → authorized receipt');
  assert(receipt.checkout_hash === co.checkout_hash, 'receipt binds the same checkout_hash');

  // 5. Tamper test: mutate the checkout_jwt → verification MUST fail loud.
  const tampered = co.checkout_jwt.slice(0, -2) + (co.checkout_jwt.endsWith('a') ? 'bb' : 'aa');
  let threw = false;
  try {
    await verifyAndReceipt({ merchant: m, checkout_jwt: tampered, bundle, orderId: 'ord_2', iat: now });
  } catch { threw = true; }
  assert(threw, 'tampering the checkout invalidates the binding (fail-fast)');

  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  if (failures) process.exitCode = 1;
}

void main();
