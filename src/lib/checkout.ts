// Build + sign the UCP Checkout object from a priced Order, with the LCP
// reference welded in.
//
// The Checkout carries the full order (line items, totals breakdown, shipping,
// address, delivery estimate) AND the LCP reference two ways (Tier A `links` +
// Tier B `extensions`). The merchant signs it → `checkout_jwt`; AP2 binds it via
// `checkout_hash = base64url(sha256(checkout_jwt))`.

import { checkoutHashOf, signJws } from './crypto.js';
import { buildLcpExtension, buildTermsLink, type DisputeResolution } from './lcp.js';
import type { Merchant } from '../merchants.js';
import type { Money } from './catalog.js';
import type { Order } from './order.js';

export interface CheckoutObject {
  checkout_id: string;
  merchant: { id: string; name: string };
  order: Order; // the full priced order
  total: Money; // = order.totals.total (surfaced for convenience)
  currency: string;
  links: Array<{ type: string; url: string }>; // Tier A (discovery)
  extensions: Record<string, unknown>; // Tier B (integrity)
  created_at: string;
}

export interface CheckoutResult {
  checkout: CheckoutObject;
  checkout_jwt: string;
  checkout_hash: string;
}

export interface BuildCheckoutInput {
  merchant: Merchant;
  order: Order;
  atrHash: string;
  legalContextUrl: string; // Tier-A link target (the /.well-known/legal-context.json)
  disputeResolution?: DisputeResolution;
  createdAt: string; // ISO — injected (no Date.now inside, keeps it testable)
}

/** Build the Checkout object from an Order, sign it (ES256 → checkout_jwt),
 *  compute checkout_hash. */
export async function buildSignedCheckout(input: BuildCheckoutInput): Promise<CheckoutResult> {
  const { merchant, order } = input;
  if (order.line_items.length === 0) throw new Error('checkout requires at least one line item');

  const checkout: CheckoutObject = {
    checkout_id: order.order_id,
    merchant: { id: merchant.id, name: merchant.name },
    order,
    total: order.totals.total,
    currency: order.totals.currency,
    links: [buildTermsLink(input.legalContextUrl)],
    extensions: buildLcpExtension(input.atrHash, input.disputeResolution),
    created_at: input.createdAt,
  };

  const checkout_jwt = await signJws({ kid: merchant.kid }, checkout as unknown as Record<string, unknown>, merchant.signingKey);
  const checkout_hash = await checkoutHashOf(checkout_jwt);
  return { checkout, checkout_jwt, checkout_hash };
}
