// A mutable cart / checkout session — the stateful layer under add-item /
// remove-item / view before the checkout is signed. Lines carry an optional
// variant. Pricing/validation resolve against the product list the caller passes
// in (from the ProductStore), so the cart never holds stale prices.
//
// Storage is an in-memory Map (MOCK/DEV): fine for `wrangler dev` and in-process
// tests, NOT durable across production isolates. Back with D1 / a Durable Object
// for real use — the function shapes stay the same.

import { type Product, resolveVariant } from './catalog.js';

export interface CartLine {
  sku: string;
  variant_sku?: string;
  qty: number;
}

export interface CartSession {
  id: string;
  merchant: string; // merchant id that owns the session
  status: 'open' | 'checked_out';
  items: CartLine[];
  created_at: string;
}

export type CartStore = Map<string, CartSession>;

export interface CartView {
  session_id: string;
  merchant: string;
  status: 'open' | 'checked_out';
  line_items: Array<{ sku: string; variant_sku?: string; name: string; options?: Record<string, string>; qty: number; unit_price: { amount: number; currency: string }; line_total: { amount: number; currency: string } }>;
  subtotal: { amount: number; currency: string };
  created_at: string;
}

function sameLine(l: CartLine, sku: string, variantSku?: string): boolean {
  return l.sku === sku && (l.variant_sku ?? undefined) === (variantSku ?? undefined);
}

function requireProduct(products: Product[], sku: string): Product {
  const p = products.find((x) => x.sku === sku);
  if (!p) throw new Error(`sku not in catalog: ${sku}`); // fail-fast, no fallback
  return p;
}

/** Fetch a session, asserting it belongs to this merchant. Throws if missing. */
export function getCart(store: CartStore, merchant: string, id: string): CartSession {
  const c = store.get(id);
  if (!c) throw new Error(`unknown cart session: ${id}`);
  if (c.merchant !== merchant) throw new Error('cart session belongs to a different merchant');
  return c;
}

/** Open a new empty cart session. `id`/`createdAt` are injected by the caller. */
export function createCart(store: CartStore, merchant: string, id: string, createdAt: string): CartSession {
  const c: CartSession = { id, merchant, status: 'open', items: [], created_at: createdAt };
  store.set(id, c);
  return c;
}

/** Add `qty` of (sku, variant?) — increments a matching line. Validates the catalog. */
export function addItem(store: CartStore, merchant: string, id: string, products: Product[], sku: string, variantSku: string | undefined, qty: number): CartSession {
  const c = getCart(store, merchant, id);
  if (c.status !== 'open') throw new Error('cart is already checked out');
  const product = requireProduct(products, sku);
  resolveVariant(product, variantSku); // validates the variant exists (throws otherwise)
  if (!Number.isInteger(qty) || qty < 1) throw new Error(`invalid qty: ${qty}`);
  const line = c.items.find((l) => sameLine(l, sku, variantSku));
  if (line) line.qty += qty;
  else c.items.push({ sku, variant_sku: variantSku, qty });
  return c;
}

/** Remove a matching line entirely. Throws if the line isn't in the cart. */
export function removeItem(store: CartStore, merchant: string, id: string, sku: string, variantSku?: string): CartSession {
  const c = getCart(store, merchant, id);
  if (c.status !== 'open') throw new Error('cart is already checked out');
  const before = c.items.length;
  c.items = c.items.filter((l) => !sameLine(l, sku, variantSku));
  if (c.items.length === before) throw new Error(`line not in cart: ${sku}${variantSku ? ` / ${variantSku}` : ''}`);
  return c;
}

/** Mark a session checked out (one-way). */
export function markCheckedOut(store: CartStore, merchant: string, id: string): CartSession {
  const c = getCart(store, merchant, id);
  if (c.status !== 'open') throw new Error('cart is already checked out');
  if (c.items.length === 0) throw new Error('cannot check out an empty cart');
  c.status = 'checked_out';
  return c;
}

/** Price a session against the product list → the client-facing view (subtotal only;
 *  shipping/tax are computed at checkout once an address + option are known). */
export function cartView(products: Product[], c: CartSession): CartView {
  const line_items = c.items.map((l) => {
    const product = requireProduct(products, l.sku);
    const { unit_price, variant } = resolveVariant(product, l.variant_sku);
    return {
      sku: product.sku,
      variant_sku: variant?.sku,
      name: product.name,
      options: variant?.options,
      qty: l.qty,
      unit_price,
      line_total: { amount: unit_price.amount * l.qty, currency: unit_price.currency },
    };
  });
  const currency = line_items[0]?.unit_price.currency ?? 'USD';
  const amount = line_items.reduce((sum, li) => sum + li.line_total.amount, 0);
  return { session_id: c.id, merchant: c.merchant, status: c.status, line_items, subtotal: { amount, currency }, created_at: c.created_at };
}
