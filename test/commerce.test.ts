import { describe, it, expect } from 'vitest';
import app from '../src/index.js';
import { buildMandateBundle } from '../src/lib/ap2.js';
import type { PrivateJwk } from '../src/lib/crypto.js';

const H = { 'content-type': 'application/json' };
const call = (method: string, path: string, body?: unknown) =>
  app.fetch(new Request(`https://mock.local${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined }));
const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;

async function buyerKey(): Promise<PrivateJwk> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as PrivateJwk;
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d };
}

describe('catalog management (add / update / remove / import)', () => {
  it('creates, reads, updates and deletes a product', async () => {
    const create = await call('POST', '/makermart/products', { sku: 'test-lamp', name: 'Test Lamp', price: { amount: 5000, currency: 'USD' } });
    expect(create.status).toBe(201);

    const got = await json<{ sku: string; images: string[]; variants: unknown[] }>(await call('GET', '/makermart/products/test-lamp'));
    expect(got.sku).toBe('test-lamp');
    expect(Array.isArray(got.images)).toBe(true); // validation filled defaults

    const updated = await json<{ price: { amount: number } }>(await call('PUT', '/makermart/products/test-lamp', { price: { amount: 6000, currency: 'USD' } }));
    expect(updated.price.amount).toBe(6000);

    expect((await call('DELETE', '/makermart/products/test-lamp')).status).toBe(200);
    expect((await call('GET', '/makermart/products/test-lamp')).status).toBe(404);
  });

  it('rejects an invalid product and imports a batch', async () => {
    expect((await call('POST', '/makermart/products', { name: 'no sku', price: { amount: 1, currency: 'USD' } })).status).toBe(400);

    const imp = await json<{ count: number }>(await call('POST', '/makermart/products/import', {
      products: [
        { sku: 'imp-1', name: 'Import One', price: { amount: 100, currency: 'USD' } },
        { sku: 'imp-2', name: 'Import Two', price: { amount: 200, currency: 'USD' } },
      ],
    }));
    expect(imp.count).toBe(2);
    await call('DELETE', '/makermart/products/imp-1');
    await call('DELETE', '/makermart/products/imp-2');
  });
});

describe('rich order pricing (shipping + tax + promo)', () => {
  it('prices a quote with a shipping option, destination tax and a promo code', async () => {
    const order = await json<{ totals: { subtotal: { amount: number }; discount: { amount: number }; shipping: { amount: number }; tax: { amount: number }; total: { amount: number } } }>(
      await call('POST', '/homegoods/orders/quote', {
        items: [{ sku: 'lamp-arc', qty: 1 }], // $149.00, standard class, $9.00 handling, not free
        shippingOptionId: 'standard', // $12.99
        shippingAddress: { name: 'A Buyer', line1: '1 Main', city: 'NYC', region: 'NY', postal: '10001', country: 'US' }, // NY 8.88%
        promoCode: 'SAVE10', // 10% off subtotal
      }),
    );
    expect(order.totals.subtotal.amount).toBe(14900);
    expect(order.totals.discount.amount).toBe(1490); // 10%
    expect(order.totals.shipping.amount).toBe(2199); // 1299 option + 900 handling
    expect(order.totals.tax.amount).toBe(1191); // round((14900-1490) * 0.0888)
    expect(order.totals.total.amount).toBe(16800); // 13410 + 2199 + 1191
  });

  it('variant selection uses the variant price', async () => {
    const order = await json<{ line_items: Array<{ variant_sku?: string; unit_price: { amount: number } }> }>(
      await call('POST', '/homegoods/orders/quote', { items: [{ sku: 'sofa-3seat', variantSku: 'sofa-3seat-forest', qty: 1 }] }),
    );
    expect(order.line_items[0]!.variant_sku).toBe('sofa-3seat-forest');
    expect(order.line_items[0]!.unit_price.amount).toBe(94900); // forest variant overrides base 89900
  });
});

describe('order lifecycle (created → paid → fulfilled → shipped → delivered)', () => {
  it('advances a paid order through fulfillment and blocks illegal transitions', async () => {
    // checkout → order created
    const co = await json<{ order_id: string; checkout_jwt: string; checkout_hash: string; checkout: { merchant: { id: string; name: string }; total: { amount: number; currency: string } } }>(
      await call('POST', '/apihub/checkout', { items: [{ sku: 'premium-call', qty: 3 }] }),
    );

    // pay
    const bundle = await buildMandateBundle({
      checkout_jwt: co.checkout_jwt,
      checkout_hash: co.checkout_hash,
      payee: co.checkout.merchant,
      amount: co.checkout.total,
      buyerKey: await buyerKey(),
      iat: 1_800_000_000,
    });
    const receipt = await json<{ status: string; order_status: string }>(await call('POST', '/apihub/ap2/receipt', { checkout_jwt: co.checkout_jwt, bundle }));
    expect(receipt.status).toBe('authorized');
    expect(receipt.order_status).toBe('paid');

    // fulfill → ship → deliver
    expect((await json<{ status: string }>(await call('POST', `/apihub/orders/${co.order_id}/fulfill`))).status).toBe('fulfilled');
    expect((await json<{ status: string }>(await call('POST', `/apihub/orders/${co.order_id}/ship`))).status).toBe('shipped');
    expect((await json<{ status: string }>(await call('POST', `/apihub/orders/${co.order_id}/deliver`))).status).toBe('delivered');

    // illegal: cannot fulfill a delivered order
    expect((await call('POST', `/apihub/orders/${co.order_id}/fulfill`)).status).toBe(400);
  });
});
