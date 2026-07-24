// ACP (Agentic Commerce Protocol, OpenAI/Stripe) — the checkout-session flavor of
// agentic commerce, a discovery/checkout standard parallel to UCP. Implemented as
// a view over our Order model: create/update/complete a `checkout_session`. Same
// catalog + same LCP reference (surfaced in `links` + an extension).
//
// Session lifecycle maps onto the order status: created → ready_for_payment,
// paid/fulfilled/… → completed, cancelled → canceled.

import { LCP_EXTENSION_KEY } from './lcp.js';
import type { Order, OrderStatus } from './order.js';

export type AcpStatus = 'not_ready_for_payment' | 'ready_for_payment' | 'completed' | 'canceled';

export interface AcpTotal {
  type: 'items_base_amount' | 'discount' | 'fulfillment' | 'tax' | 'total';
  display_text: string;
  amount: number; // minor units
}

export interface AcpSession {
  id: string;
  status: AcpStatus;
  currency: string;
  line_items: Array<{ id: string; item: { id: string; quantity: number }; base_amount: number; subtotal: number }>;
  totals: AcpTotal[];
  fulfillment_address?: Order['shipping_address'];
  fulfillment_options: Array<{ type: string; id: string; title: string; subtotal: number; earliest?: string; latest?: string }>;
  messages: Array<{ type: string; text: string }>;
  links: Array<{ type: string; url: string }>;
  order?: { id: string; checkout_hash?: string; status: OrderStatus };
}

export function acpStatus(order: Order): AcpStatus {
  switch (order.status) {
    case 'created':
      return order.shipping_address ? 'ready_for_payment' : 'not_ready_for_payment';
    case 'cancelled':
      return 'canceled';
    default:
      return 'completed'; // paid / fulfilled / shipped / delivered
  }
}

/** Build the ACP checkout_session view of an Order. */
export function buildAcpSession(order: Order, opts: { termsUrl: string; atrHash: string }): AcpSession {
  const t = order.totals;
  const totals: AcpTotal[] = [
    { type: 'items_base_amount', display_text: 'Subtotal', amount: t.subtotal.amount },
    ...(t.discount.amount ? [{ type: 'discount' as const, display_text: 'Discount', amount: -t.discount.amount }] : []),
    { type: 'fulfillment', display_text: 'Shipping', amount: t.shipping.amount },
    { type: 'tax', display_text: 'Tax', amount: t.tax.amount },
    { type: 'total', display_text: 'Total', amount: t.total.amount },
  ];
  const opt = order.shipping_option;
  return {
    id: order.order_id,
    status: acpStatus(order),
    currency: t.currency.toLowerCase(),
    line_items: order.line_items.map((li) => ({
      id: li.variant_sku ?? li.sku,
      item: { id: li.variant_sku ?? li.sku, quantity: li.qty },
      base_amount: li.unit_price.amount,
      subtotal: li.line_total.amount,
    })),
    totals,
    fulfillment_address: order.shipping_address,
    fulfillment_options: opt ? [{ type: 'shipping', id: opt.id, title: opt.label, subtotal: opt.amount.amount, earliest: order.delivery_estimate?.earliest, latest: order.delivery_estimate?.latest }] : [],
    messages: [],
    links: [{ type: 'terms_of_service', url: opts.termsUrl }],
    order: order.status === 'created' ? undefined : { id: order.order_id, checkout_hash: order.checkout_hash, status: order.status },
    [LCP_EXTENSION_KEY]: { type: 'sha256', value: opts.atrHash },
  } as AcpSession & Record<string, unknown>;
}
