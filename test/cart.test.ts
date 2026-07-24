import { describe, it, expect } from 'vitest';
import app from '../src/index.js';
import { buildMandateBundle } from '../src/lib/ap2.js';
import type { PrivateJwk } from '../src/lib/crypto.js';

const H = { 'content-type': 'application/json' };
const call = (method: string, path: string, body?: unknown) =>
  app.fetch(new Request(`https://mock.local${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined }));
const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;

interface CartV {
  session_id: string;
  status: string;
  subtotal: { amount: number; currency: string };
  line_items: Array<{ sku: string; qty: number }>;
}
interface CheckoutV {
  checkout_jwt: string;
  checkout_hash: string;
  session_id: string;
  checkout: { merchant: { id: string; name: string }; total: { amount: number; currency: string }; extensions: Record<string, { value: string }> };
}
interface ReceiptV {
  status: string;
  payment: { status: string; handler: string; amount: { amount: number } };
}

async function buyerKey(): Promise<PrivateJwk> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as PrivateJwk;
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d };
}

describe('mutable cart session (add / remove / checkout / pay)', () => {
  it('runs the whole cart lifecycle and receives mock payment', async () => {
    // open
    const open = await json<CartV>(await call('POST', '/homegoods/cart'));
    const sid = open.session_id;
    expect(open.status).toBe('open');
    expect(open.line_items).toHaveLength(0);

    // add two items, then increment the first
    await call('POST', `/homegoods/cart/${sid}/items`, { sku: 'rug-9x12', qty: 1 });
    await call('POST', `/homegoods/cart/${sid}/items`, { sku: 'lamp-arc', qty: 2 });
    const afterAdd = await json<CartV>(await call('POST', `/homegoods/cart/${sid}/items`, { sku: 'rug-9x12', qty: 1 }));
    expect(afterAdd.line_items.find((l) => l.sku === 'rug-9x12')?.qty).toBe(2);
    expect(afterAdd.line_items).toHaveLength(2);

    // remove one line
    const afterRemove = await json<CartV>(await call('DELETE', `/homegoods/cart/${sid}/items/lamp-arc`));
    expect(afterRemove.line_items).toHaveLength(1);
    expect(afterRemove.subtotal.amount).toBe(24000); // 2 × $120.00 rug

    // checkout → signed UCP checkout with the LCP reference welded in
    const co = await json<CheckoutV>(await call('POST', `/homegoods/cart/${sid}/checkout`));
    expect(co.checkout_jwt).toBeTruthy();
    expect(co.session_id).toBe(sid);
    expect(co.checkout.extensions['org.legalcontextprotocol.legal-context']!.value).toMatch(/^0x[0-9a-f]{64}$/);

    // pay: buyer submits the AP2 mandate bundle → authorized receipt + captured payment
    const bundle = await buildMandateBundle({
      checkout_jwt: co.checkout_jwt,
      checkout_hash: co.checkout_hash,
      payee: { id: co.checkout.merchant.id, name: co.checkout.merchant.name },
      amount: co.checkout.total,
      buyerKey: await buyerKey(),
      iat: 1_800_000_000,
    });
    const receipt = await json<ReceiptV>(await call('POST', '/homegoods/ap2/receipt', { checkout_jwt: co.checkout_jwt, bundle }));
    expect(receipt.status).toBe('authorized');
    expect(receipt.payment.status).toBe('captured');
    expect(receipt.payment.handler).toBe('dev.ucp.mock_payment');
    expect(receipt.payment.amount.amount).toBe(24000);
  });

  it('rejects an unknown sku and a double checkout', async () => {
    const sid = (await json<CartV>(await call('POST', '/apihub/cart'))).session_id;
    const bad = await call('POST', `/apihub/cart/${sid}/items`, { sku: 'not-a-sku', qty: 1 });
    expect(bad.status).toBe(400);

    await call('POST', `/apihub/cart/${sid}/items`, { sku: 'premium-call', qty: 1 });
    const first = await call('POST', `/apihub/cart/${sid}/checkout`);
    expect(first.status).toBe(200);
    const second = await call('POST', `/apihub/cart/${sid}/checkout`);
    expect(second.status).toBe(400); // already checked out
  });
});
