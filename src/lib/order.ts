// The order — everything a real (e.g. Wayfair) order carries beyond a line list:
// selected variants, a shipping address, shipping options + cost, tax, promo-code
// discounts, a totals breakdown, a delivery estimate, and a status lifecycle.
//
// Pure + deterministic: `createdAt` is injected (no Date.now inside), so the same
// inputs always price the same way — which is what makes the signed checkout and
// the AP2 binding reproducible.

import { type Money, type Product, type ShippingClass, resolveVariant } from './catalog.js';

export interface Address {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  region: string; // state / province (drives tax)
  postal: string;
  country: string;
}

export interface ShippingOption {
  id: string;
  label: string;
  amount: Money;
  estimatedDaysMin: number;
  estimatedDaysMax: number;
}

export interface OrderLine {
  sku: string; // product sku
  variant_sku?: string;
  name: string;
  options?: Record<string, string>;
  qty: number;
  unit_price: Money;
  line_total: Money;
}

export interface OrderTotals {
  subtotal: Money;
  discount: Money;
  shipping: Money;
  tax: Money;
  total: Money;
  currency: string;
}

export type OrderStatus = 'created' | 'paid' | 'fulfilled' | 'shipped' | 'delivered' | 'cancelled';

export interface Order {
  order_id: string;
  merchant: string;
  status: OrderStatus;
  line_items: OrderLine[];
  shipping_address?: Address;
  shipping_option?: ShippingOption;
  promo_code?: string;
  totals: OrderTotals;
  delivery_estimate?: { earliest: string; latest: string }; // ISO dates
  created_at: string;
  updated_at: string;
  checkout_hash?: string;
  payment?: unknown;
}

// --- money helpers ---------------------------------------------------------

const m0 = (currency: string): Money => ({ amount: 0, currency });
const add = (a: Money, b: Money): Money => {
  if (a.currency !== b.currency) throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
  return { amount: a.amount + b.amount, currency: a.currency };
};
const mul = (a: Money, n: number): Money => ({ amount: a.amount * n, currency: a.currency });
const sub = (a: Money, b: Money): Money => add(a, { amount: -b.amount, currency: b.currency });

// --- shipping --------------------------------------------------------------

const CLASS_RANK: Record<ShippingClass, number> = { digital: 0, small_parcel: 1, standard: 2, freight: 3 };

// Base option amounts (minor units) per effective order shipping class.
const SHIPPING_TABLE: Record<ShippingClass, Array<{ id: string; label: string; amount: number; min: number; max: number }>> = {
  digital: [{ id: 'instant', label: 'Instant (digital delivery)', amount: 0, min: 0, max: 0 }],
  small_parcel: [
    { id: 'standard', label: 'Standard', amount: 699, min: 3, max: 7 },
    { id: 'expedited', label: 'Expedited', amount: 1499, min: 2, max: 3 },
    { id: 'two_day', label: 'Two-Day', amount: 2499, min: 2, max: 2 },
  ],
  standard: [
    { id: 'standard', label: 'Standard', amount: 1299, min: 4, max: 8 },
    { id: 'expedited', label: 'Expedited', amount: 2999, min: 2, max: 4 },
  ],
  freight: [
    { id: 'curbside', label: 'Curbside Freight', amount: 7900, min: 7, max: 14 },
    { id: 'white_glove', label: 'White-Glove Delivery', amount: 19900, min: 10, max: 18 },
  ],
};

function effectiveClass(products: Product[]): ShippingClass {
  let best: ShippingClass = 'digital';
  for (const p of products) if (CLASS_RANK[p.shipping.class] > CLASS_RANK[best]) best = p.shipping.class;
  return best;
}

/** The shipping options offered for a set of products, in the order currency.
 *  If every product is free-shipping, the cheapest option is $0 (upgrades paid). */
export function shippingOptionsFor(products: Product[], currency: string): ShippingOption[] {
  const cls = effectiveClass(products);
  const allFree = products.length > 0 && products.every((p) => p.shipping.freeShipping);
  const rows = SHIPPING_TABLE[cls];
  return rows.map((r, i) => ({
    id: r.id,
    label: allFree && i === 0 ? `${r.label} (Free)` : r.label,
    amount: { amount: allFree && i === 0 ? 0 : r.amount, currency },
    estimatedDaysMin: r.min,
    estimatedDaysMax: r.max,
  }));
}

// --- tax + promo -----------------------------------------------------------

// Illustrative destination tax rates by US state (basis points). Unknown region
// with an address falls back to 700 bps; no address → no tax computed here.
const TAX_BPS: Record<string, number> = {
  NY: 888, 'NEW YORK': 888,
  MA: 625, MASSACHUSETTS: 625,
  CA: 950, CALIFORNIA: 950,
  TX: 825, TEXAS: 825,
  FL: 700, FLORIDA: 700,
  WA: 1025, WASHINGTON: 1025,
  DE: 0, DELAWARE: 0, OR: 0, OREGON: 0, MT: 0, MONTANA: 0, NH: 0, 'NEW HAMPSHIRE': 0,
};

export function taxBpsFor(region?: string): number {
  if (!region) return 0;
  const key = region.trim().toUpperCase();
  return TAX_BPS[key] ?? 700;
}

interface Promo {
  code: string;
  kind: 'percent' | 'flat' | 'free_shipping';
  value: number; // percent (whole %) or flat minor units; 0 for free_shipping
}

const PROMOS: Record<string, Promo> = {
  SAVE10: { code: 'SAVE10', kind: 'percent', value: 10 },
  WELCOME15: { code: 'WELCOME15', kind: 'percent', value: 15 },
  FLAT20: { code: 'FLAT20', kind: 'flat', value: 2000 },
  FREESHIP: { code: 'FREESHIP', kind: 'free_shipping', value: 0 },
};

export function resolvePromo(code?: string): Promo | null {
  if (!code) return null;
  const p = PROMOS[code.trim().toUpperCase()];
  if (!p) throw new Error(`unknown promo code: ${code}`); // fail-fast, no silent ignore
  return p;
}

// --- build the order -------------------------------------------------------

export interface BuildOrderInput {
  orderId: string;
  merchant: string;
  items: Array<{ sku: string; variantSku?: string; qty: number }>;
  products: Product[]; // the catalog to resolve against
  shippingOptionId?: string; // default: cheapest offered
  shippingAddress?: Address;
  promoCode?: string;
  createdAt: string; // injected ISO timestamp
}

function lineFor(products: Product[], item: { sku: string; variantSku?: string; qty: number }): { line: OrderLine; product: Product } {
  const product = products.find((p) => p.sku === item.sku);
  if (!product) throw new Error(`sku not in catalog: ${item.sku}`);
  if (!Number.isInteger(item.qty) || item.qty < 1) throw new Error(`invalid qty for ${item.sku}: ${item.qty}`);
  const { unit_price, variant } = resolveVariant(product, item.variantSku);
  const line: OrderLine = {
    sku: product.sku,
    variant_sku: variant?.sku,
    name: product.name,
    options: variant?.options,
    qty: item.qty,
    unit_price,
    line_total: mul(unit_price, item.qty),
  };
  return { line, product };
}

function isoPlusDays(iso: string, days: number): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) throw new Error(`invalid createdAt: ${iso}`);
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/** Resolve items → priced order with shipping, tax, discount, totals, delivery. */
export function buildOrder(input: BuildOrderInput): Order {
  if (input.items.length === 0) throw new Error('order requires at least one item');
  const resolved = input.items.map((it) => lineFor(input.products, it));
  const lines = resolved.map((r) => r.line);
  const products = resolved.map((r) => r.product);

  const currency = lines[0]!.unit_price.currency;
  for (const l of lines) if (l.unit_price.currency !== currency) throw new Error('mixed-currency order not supported');

  const subtotal = lines.reduce((s, l) => add(s, l.line_total), m0(currency));

  const promo = resolvePromo(input.promoCode);
  let discount = m0(currency);
  if (promo?.kind === 'percent') discount = { amount: Math.round((subtotal.amount * promo.value) / 100), currency };
  else if (promo?.kind === 'flat') discount = { amount: Math.min(promo.value, subtotal.amount), currency };

  const options = shippingOptionsFor(products, currency);
  const chosen = input.shippingOptionId ? options.find((o) => o.id === input.shippingOptionId) : options[0];
  if (input.shippingOptionId && !chosen) throw new Error(`shipping option not available: ${input.shippingOptionId}`);
  const handling = products.reduce((s, p) => (p.shipping.handlingFee ? add(s, p.shipping.handlingFee) : s), m0(currency));
  let shipping = chosen ? add(chosen.amount, handling) : m0(currency);
  if (promo?.kind === 'free_shipping') shipping = m0(currency);

  // Tax on (subtotal - discount) at the destination rate.
  const taxable = sub(subtotal, discount);
  const tax = { amount: Math.round((taxable.amount * taxBpsFor(input.shippingAddress?.region)) / 10_000), currency };

  const total = add(add(sub(subtotal, discount), shipping), tax);

  const delivery_estimate = chosen
    ? { earliest: isoPlusDays(input.createdAt, chosen.estimatedDaysMin), latest: isoPlusDays(input.createdAt, chosen.estimatedDaysMax) }
    : undefined;

  return {
    order_id: input.orderId,
    merchant: input.merchant,
    status: 'created',
    line_items: lines,
    shipping_address: input.shippingAddress,
    shipping_option: chosen,
    promo_code: promo?.code,
    totals: { subtotal, discount, shipping, tax, total, currency },
    delivery_estimate,
    created_at: input.createdAt,
    updated_at: input.createdAt,
  };
}

// --- status lifecycle ------------------------------------------------------

const NEXT: Record<OrderStatus, OrderStatus[]> = {
  created: ['paid', 'cancelled'],
  paid: ['fulfilled', 'cancelled'],
  fulfilled: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

/** Advance an order's status, enforcing the allowed transitions. `at` injected. */
export function advanceStatus(order: Order, to: OrderStatus, at: string): Order {
  if (!NEXT[order.status].includes(to)) throw new Error(`illegal status transition: ${order.status} → ${to}`);
  order.status = to;
  order.updated_at = at;
  return order;
}

// --- order store (in-memory; mock/dev) -------------------------------------

export class OrderStore {
  private data = new Map<string, Order>();
  private key(merchant: string, id: string): string {
    return `${merchant}/${id}`;
  }
  put(order: Order): Order {
    this.data.set(this.key(order.merchant, order.order_id), order);
    return order;
  }
  get(merchant: string, id: string): Order {
    const o = this.data.get(this.key(merchant, id));
    if (!o) throw new Error(`unknown order: ${id}`);
    return o;
  }
}
