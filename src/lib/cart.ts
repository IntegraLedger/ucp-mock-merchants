// A mutable cart / checkout session — the stateful layer under add-item /
// remove-item / view before the checkout is signed.
//
// Storage is an in-memory Map (MOCK/DEV posture): fine for `wrangler dev` (one
// local isolate) and in-process tests, but NOT durable across production isolates.
// For a real deployment, back these same operations with D1 or a Durable Object
// (one row/object per session) — the function shapes stay identical.

import type { CatalogItem, Merchant } from '../merchants.js';

export interface CartLine {
  sku: string;
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

/** A cart priced against the merchant catalog — the view returned to clients. */
export interface CartView {
  session_id: string;
  merchant: string;
  status: 'open' | 'checked_out';
  line_items: Array<{ sku: string; name: string; qty: number; unit_price: { amount: number; currency: string } }>;
  total: { amount: number; currency: string };
  created_at: string;
}

function catalogItem(catalog: CatalogItem[], sku: string): CatalogItem {
  const it = catalog.find((c) => c.sku === sku);
  if (!it) throw new Error(`sku not in catalog: ${sku}`); // fail-fast, no fallback
  return it;
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

/** Add `qty` of `sku` (increments if already present). Validates against the catalog. */
export function addItem(store: CartStore, merchant: Merchant, id: string, sku: string, qty: number): CartSession {
  const c = getCart(store, merchant.id, id);
  if (c.status !== 'open') throw new Error('cart is already checked out');
  catalogItem(merchant.catalog, sku); // validate the sku exists
  if (!Number.isInteger(qty) || qty < 1) throw new Error(`invalid qty: ${qty}`);
  const line = c.items.find((l) => l.sku === sku);
  if (line) line.qty += qty;
  else c.items.push({ sku, qty });
  return c;
}

/** Remove a line entirely (idempotent — removing an absent sku is a no-op error). */
export function removeItem(store: CartStore, merchant: string, id: string, sku: string): CartSession {
  const c = getCart(store, merchant, id);
  if (c.status !== 'open') throw new Error('cart is already checked out');
  const before = c.items.length;
  c.items = c.items.filter((l) => l.sku !== sku);
  if (c.items.length === before) throw new Error(`sku not in cart: ${sku}`);
  return c;
}

/** Mark a session checked out (one-way). Returns its items for signing. */
export function markCheckedOut(store: CartStore, merchant: string, id: string): CartSession {
  const c = getCart(store, merchant, id);
  if (c.status !== 'open') throw new Error('cart is already checked out');
  if (c.items.length === 0) throw new Error('cannot check out an empty cart');
  c.status = 'checked_out';
  return c;
}

/** Price a session against the merchant catalog → the client-facing view. */
export function cartView(merchant: Merchant, c: CartSession): CartView {
  const line_items = c.items.map((l) => {
    const it = catalogItem(merchant.catalog, l.sku);
    return { sku: it.sku, name: it.name, qty: l.qty, unit_price: it.price };
  });
  const currency = line_items[0]?.unit_price.currency ?? 'USD';
  const amount = line_items.reduce((sum, li) => sum + li.unit_price.amount * li.qty, 0);
  return {
    session_id: c.id,
    merchant: c.merchant,
    status: c.status,
    line_items,
    total: { amount, currency },
    created_at: c.created_at,
  };
}
