// Build + sign the UCP Checkout object, with the LCP reference welded in.
//
// The Checkout object carries the LCP reference two ways (Tier A `links` +
// Tier B `extensions`); the merchant signs it → `checkout_jwt`; AP2 binds it via
// `checkout_hash = base64url(sha256(checkout_jwt))`. Field shapes match
// @legalcontext/protocol-ucp / protocol-ap2.

import { checkoutHashOf, signJws } from './crypto.js';
import { buildLcpExtension, buildTermsLink, type DisputeResolution } from './lcp.js';
import type { CatalogItem, Merchant } from '../merchants.js';

export interface CheckoutLineItem {
  sku: string;
  name: string;
  qty: number;
  unit_price: { amount: number; currency: string };
}

export interface CheckoutObject {
  checkout_id: string;
  merchant: { id: string; name: string };
  line_items: CheckoutLineItem[];
  total: { amount: number; currency: string };
  currency: string;
  links: Array<{ type: string; url: string }>;
  extensions: Record<string, unknown>;
  created_at: string;
}

export interface CheckoutResult {
  checkout: CheckoutObject;
  checkout_jwt: string;
  checkout_hash: string;
}

export interface BuildCheckoutInput {
  merchant: Merchant;
  items: Array<{ sku: string; qty: number }>;
  atrHash: string;
  legalContextUrl: string; // Tier-A link target (the /.well-known/legal-context.json)
  disputeResolution?: DisputeResolution;
  checkoutId: string;
  createdAt: string; // ISO — injected (no Date.now inside, keeps it testable)
}

function resolveLine(catalog: CatalogItem[], sku: string, qty: number): CheckoutLineItem {
  const item = catalog.find((c) => c.sku === sku);
  if (!item) throw new Error(`sku not in catalog: ${sku}`); // fail-fast, no fallback
  if (!Number.isInteger(qty) || qty < 1) throw new Error(`invalid qty for ${sku}: ${qty}`);
  return { sku: item.sku, name: item.name, qty, unit_price: item.price };
}

/** Build the Checkout object, sign it (ES256 → checkout_jwt), compute checkout_hash. */
export async function buildSignedCheckout(input: BuildCheckoutInput): Promise<CheckoutResult> {
  const { merchant } = input;
  if (input.items.length === 0) throw new Error('checkout requires at least one item');
  const line_items = input.items.map((i) => resolveLine(merchant.catalog, i.sku, i.qty));
  const currency = line_items[0]!.unit_price.currency;
  const amount = line_items.reduce((sum, li) => sum + li.unit_price.amount * li.qty, 0);

  const checkout: CheckoutObject = {
    checkout_id: input.checkoutId,
    merchant: { id: merchant.id, name: merchant.name },
    line_items,
    total: { amount, currency },
    currency,
    // Tier A (discovery) + Tier B (integrity) LCP carriers, both in the signed object.
    links: [buildTermsLink(input.legalContextUrl)],
    extensions: buildLcpExtension(input.atrHash, input.disputeResolution),
    created_at: input.createdAt,
  };

  const checkout_jwt = await signJws({ kid: merchant.kid }, checkout as unknown as Record<string, unknown>, merchant.signingKey);
  const checkout_hash = await checkoutHashOf(checkout_jwt);
  return { checkout, checkout_jwt, checkout_hash };
}
