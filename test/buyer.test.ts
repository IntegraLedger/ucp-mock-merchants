import { describe, it, expect } from 'vitest';
import app from '../src/index.js';
import { runBuyer, type FetchLike } from '../src/buyer.js';
import type { PrivateJwk } from '../src/lib/crypto.js';

// Drive the Worker in-process — Request in, Response out, no server.
const fetchLike: FetchLike = async (url, init) => app.fetch(new Request(url, init));
const base = 'https://mock.local/homegoods';

async function buyerKey(): Promise<PrivateJwk> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as PrivateJwk;
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d };
}

describe('reference buyer (over the Worker, in-process)', () => {
  it('completes the full flow and gets an authorized receipt', async () => {
    const out = await runBuyer({
      merchantBase: base,
      items: [{ sku: 'rug-9x12', qty: 1 }],
      buyerKey: await buyerKey(),
      iat: 1_800_000_000,
      fetch: fetchLike,
      policy: { requireDisputeResolution: true, maxTotal: { amount: 2_000_000, currency: 'USD' } },
    });
    expect(out.authorized).toBe(true);
    // the buyer gate ran and passed before any spend
    expect(out.steps.find((s) => s.step === 'verify-terms-hash')?.ok).toBe(true);
    expect(out.steps.find((s) => s.step === 'verify-checkout-sig')?.ok).toBe(true);
  });

  it('declines (does not pay) when the total exceeds the budget policy', async () => {
    const out = await runBuyer({
      merchantBase: base,
      items: [{ sku: 'sofa-3seat', qty: 1 }], // $899.00
      buyerKey: await buyerKey(),
      iat: 1_800_000_000,
      fetch: fetchLike,
      policy: { maxTotal: { amount: 10_000, currency: 'USD' } }, // $100 cap
    });
    expect(out.authorized).toBe(false);
    expect(out.declinedReason).toMatch(/exceeds budget/);
    // it must decline BEFORE signing any mandate
    expect(out.steps.some((s) => s.step === 'sign-mandates')).toBe(false);
  });

  it('gate catches tampered terms (declines before checkout)', async () => {
    // A fetch that serves the manifest/legal-context/checkout normally but returns
    // altered terms bytes → the recomputed atrHash won't match the declared one.
    const tamperingFetch: FetchLike = async (url, init) => {
      if (url.includes('/terms/')) return new Response('# Tampered Terms\n', { status: 200 });
      return app.fetch(new Request(url, init));
    };
    const out = await runBuyer({
      merchantBase: base,
      items: [{ sku: 'rug-9x12', qty: 1 }],
      buyerKey: await buyerKey(),
      iat: 1_800_000_000,
      fetch: tamperingFetch,
    });
    expect(out.authorized).toBe(false);
    expect(out.declinedReason).toMatch(/terms hash mismatch/);
    expect(out.steps.some((s) => s.step === 'checkout')).toBe(false);
  });
});
