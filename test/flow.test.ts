import { describe, it, expect } from 'vitest';
import { atrHashOf, verifyJws, publicOf, type PrivateJwk } from '../src/lib/crypto.js';
import { verifyTermsHash } from '../src/lib/lcp.js';
import { buildSignedCheckout } from '../src/lib/checkout.js';
import { buildMandateBundle, verifyAndReceipt } from '../src/lib/ap2.js';
import { buildOrder } from '../src/lib/order.js';
import { SEED } from '../src/lib/catalog.js';
import { getMerchant, MERCHANT_IDS } from '../src/merchants.js';

async function buyerKey(): Promise<PrivateJwk> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as PrivateJwk;
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d };
}

async function checkoutFor(id: string) {
  const m = getMerchant(id);
  const atrHash = await atrHashOf(m.terms);
  const products = SEED[id]!;
  const order = buildOrder({
    orderId: 'chk_test',
    merchant: m.id,
    items: [{ sku: products[0]!.sku, qty: 1 }],
    products,
    createdAt: '2026-07-24T00:00:00Z',
  });
  const co = await buildSignedCheckout({
    merchant: m,
    order,
    atrHash,
    legalContextUrl: `https://example.com/${id}/.well-known/legal-context.json`,
    disputeResolution: m.disputeResolution,
    createdAt: '2026-07-24T00:00:00Z',
  });
  return { m, atrHash, co };
}

describe('UCP + AP2 + LCP mock merchant flow', () => {
  it('welds the LCP reference into the signed checkout (both tiers)', async () => {
    const { atrHash, co } = await checkoutFor('homegoods');
    const ext = co.checkout.extensions['org.legalcontextprotocol.legal-context'] as { type: string; value: string };
    expect(ext.type).toBe('sha256');
    expect(ext.value).toBe(atrHash);
    expect(co.checkout.links[0]!.type).toBe('terms_of_service');
  });

  it('checkout_jwt verifies and terms recompute to the bound atrHash (L2)', async () => {
    const { m, co } = await checkoutFor('homegoods');
    const v = await verifyJws(co.checkout_jwt, publicOf(m.signingKey));
    expect(v.ok).toBe(true);
    const ext = co.checkout.extensions['org.legalcontextprotocol.legal-context'] as { value: string };
    expect(await verifyTermsHash(m.terms, ext.value)).toBe(true);
  });

  it('AP2 mandate bundle binds via checkout_hash → authorized receipt', async () => {
    const { m, co } = await checkoutFor('homegoods');
    const bundle = await buildMandateBundle({
      checkout_jwt: co.checkout_jwt, checkout_hash: co.checkout_hash,
      payee: { id: m.id, name: m.name }, amount: co.checkout.total,
      buyerKey: await buyerKey(), iat: 1_800_000_000,
    });
    const r = await verifyAndReceipt({ merchant: m, checkout_jwt: co.checkout_jwt, bundle, orderId: 'o1', iat: 1_800_000_000 });
    expect(r.status).toBe('authorized');
    expect(r.checkout_hash).toBe(co.checkout_hash);
  });

  it('tampering the checkout invalidates the binding (fail-fast)', async () => {
    const { m, co } = await checkoutFor('homegoods');
    const bundle = await buildMandateBundle({
      checkout_jwt: co.checkout_jwt, checkout_hash: co.checkout_hash,
      payee: { id: m.id, name: m.name }, amount: co.checkout.total,
      buyerKey: await buyerKey(), iat: 1_800_000_000,
    });
    const tampered = co.checkout_jwt.slice(0, -2) + 'zz';
    await expect(
      verifyAndReceipt({ merchant: m, checkout_jwt: tampered, bundle, orderId: 'o2', iat: 1_800_000_000 }),
    ).rejects.toThrow();
  });

  it('every merchant produces a valid checkout', async () => {
    for (const id of MERCHANT_IDS) {
      const { atrHash, co } = await checkoutFor(id);
      const ext = co.checkout.extensions['org.legalcontextprotocol.legal-context'] as { value: string };
      expect(ext.value).toBe(atrHash);
    }
  });
});
