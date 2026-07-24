// AP2 (Agent Payments Protocol) — the mandate + receipt layer.
//
// Simplified to compact ES256 JWS VCs (no SD-JWT selective-disclosure) — the same
// simplification the demo's own protocol-ap2 makes. The buyer wraps the merchant's
// `checkout_jwt` in a Checkout Mandate + Payment Mandate bound by `checkout_hash`;
// the merchant verifies the bundle and issues a signed receipt. Payment handler is
// mock (`dev.ucp.mock_payment`) — no settlement.

import { checkoutHashOf, signJws, verifyJws, publicOf, type PrivateJwk, type PublicJwk } from './crypto.js';
import type { Merchant } from '../merchants.js';

export interface MandateBundle {
  buyer_public_jwk: PublicJwk;
  checkout_mandate: string; // JWS, vct mandate.checkout.1
  payment_mandate: string; // JWS, vct mandate.payment.1
}

/** BUYER side — wrap a merchant checkout in the two AP2 mandates. */
export async function buildMandateBundle(opts: {
  checkout_jwt: string;
  checkout_hash: string;
  payee: { id: string; name: string };
  amount: { amount: number; currency: string };
  buyerKey: PrivateJwk;
  iat: number; // injected epoch seconds (no Date.now inside)
}): Promise<MandateBundle> {
  const checkout_mandate = await signJws(
    { typ: 'kb+sd-jwt' },
    { vct: 'mandate.checkout.1', checkout_jwt: opts.checkout_jwt, checkout_hash: opts.checkout_hash, iat: opts.iat },
    opts.buyerKey,
  );
  const payment_mandate = await signJws(
    { typ: 'kb+sd-jwt' },
    {
      vct: 'mandate.payment.1',
      transaction_id: opts.checkout_hash, // = base64url(sha256(checkout_jwt)) — the binding
      payee: opts.payee,
      payment_amount: opts.amount,
      payment_instrument: { type: 'dev.ucp.mock_payment', id: 'mock-instrument-1' },
      iat: opts.iat,
    },
    opts.buyerKey,
  );
  return { buyer_public_jwk: publicOf(opts.buyerKey), checkout_mandate, payment_mandate };
}

export interface Payment {
  handler: string; // the UCP payment handler (mock: dev.ucp.mock_payment)
  instrument_id: string;
  amount: { amount: number; currency: string };
  status: 'captured'; // mock: no real settlement, but the mandate authorized the charge
}

export interface Receipt {
  status: 'authorized' | 'declined';
  checkout_id: string;
  checkout_hash: string;
  order_id?: string;
  payment?: Payment; // what was "received" (mock capture)
  error?: string;
  iat: number;
  receipt_jws: string; // merchant-signed
}

/** MERCHANT side — verify the mandate bundle against a fresh checkout, issue a receipt.
 *  Fails loud on any mismatch: bad checkout signature, bad mandate signature, or a
 *  checkout_hash / transaction_id that doesn't bind to THIS checkout. */
export async function verifyAndReceipt(opts: {
  merchant: Merchant;
  checkout_jwt: string;
  bundle: MandateBundle;
  orderId: string;
  iat: number;
}): Promise<Receipt> {
  const { merchant, checkout_jwt, bundle } = opts;

  // 1. The checkout must be THIS merchant's signed object.
  const co = await verifyJws(checkout_jwt, publicOf(merchant.signingKey));
  if (!co.ok) throw new Error('checkout_jwt signature invalid for this merchant');
  const checkout_id = String((co.payload as Record<string, unknown>).checkout_id ?? '');
  if (!checkout_id) throw new Error('checkout_jwt missing checkout_id');

  // 2. Recompute the binding hash from the exact checkout_jwt bytes.
  const checkout_hash = await checkoutHashOf(checkout_jwt);

  // 3. Both mandates must verify under the buyer's key AND bind to checkout_hash.
  const cm = await verifyJws(bundle.checkout_mandate, bundle.buyer_public_jwk);
  const pm = await verifyJws(bundle.payment_mandate, bundle.buyer_public_jwk);
  if (!cm.ok || !pm.ok) throw new Error('mandate signature invalid');
  if ((cm.payload as Record<string, unknown>).checkout_hash !== checkout_hash) {
    throw new Error('checkout mandate checkout_hash does not bind to this checkout');
  }
  if ((pm.payload as Record<string, unknown>).transaction_id !== checkout_hash) {
    throw new Error('payment mandate transaction_id does not bind to this checkout');
  }

  // 4. "Receive" the payment: read the authorized instrument + amount from the
  //    Payment Mandate. Mock capture — no settlement, but the charge is authorized.
  const pmp = pm.payload as Record<string, unknown>;
  const instrument = (pmp.payment_instrument ?? {}) as { type?: string; id?: string };
  const amt = (pmp.payment_amount ?? {}) as { amount?: number; currency?: string };
  if (!instrument.type) throw new Error('payment mandate missing payment_instrument');
  const payment: Payment = {
    handler: instrument.type,
    instrument_id: instrument.id ?? '',
    amount: { amount: amt.amount ?? 0, currency: amt.currency ?? '' },
    status: 'captured',
  };

  const receipt_jws = await signJws(
    { kid: merchant.kid },
    { status: 'authorized', checkout_id, checkout_hash, order_id: opts.orderId, payment, iat: opts.iat },
    merchant.signingKey,
  );
  return { status: 'authorized', checkout_id, checkout_hash, order_id: opts.orderId, payment, iat: opts.iat, receipt_jws };
}
