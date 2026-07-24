// The catalog — a Wayfair-style product model plus a pluggable ProductStore so a
// merchant's catalog can be set up and edited at runtime (add/update/remove
// products). Two backends: an in-memory store (mock/dev, seeded — works in the
// in-process tests) and a D1 store (durable, for a real deployment). The Worker
// picks by whether a D1 binding is present; the function shapes are identical.

// --- the product model ----------------------------------------------------

export interface Money {
  amount: number; // minor units (cents)
  currency: string;
}

export interface Dimensions {
  length: number;
  width: number;
  height: number;
  unit: 'in' | 'cm';
}

export interface Weight {
  value: number;
  unit: 'lb' | 'kg';
}

/** A selectable variant (e.g. color/size) with its own SKU, price, inventory. */
export interface Variant {
  sku: string;
  options: Record<string, string>; // { color: 'Navy', size: 'Queen' }
  price?: Money; // overrides the base price when present
  inventory: number;
  image?: string;
}

export type ShippingClass = 'small_parcel' | 'standard' | 'freight' | 'digital';

export interface Shipping {
  class: ShippingClass;
  freeShipping: boolean;
  estimatedDaysMin: number;
  estimatedDaysMax: number;
  handlingFee?: Money; // per-order handling for this class
}

export interface Product {
  sku: string;
  name: string;
  description?: string;
  brand?: string;
  category?: string;
  price: Money; // base price (a variant may override)
  images: string[];
  dimensions?: Dimensions;
  weight?: Weight;
  attributes: Record<string, string>; // material, assembly, warranty, …
  variants: Variant[];
  inventory: number; // base inventory when there are no variants
  shipping: Shipping;
  taxCode?: string;
}

// --- validation (fail-fast, no silent coercion of required fields) ---------

const SKU_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function money(v: unknown, ctx: string): Money {
  const m = v as Money;
  if (!m || typeof m.amount !== 'number' || !Number.isInteger(m.amount) || m.amount < 0) {
    throw new Error(`${ctx}: price.amount must be a non-negative integer (minor units)`);
  }
  if (typeof m.currency !== 'string' || m.currency.length !== 3) {
    throw new Error(`${ctx}: price.currency must be a 3-letter code`);
  }
  return { amount: m.amount, currency: m.currency.toUpperCase() };
}

/** Validate + normalize an untrusted product payload. Throws on any bad field. */
export function validateProduct(input: unknown): Product {
  const p = (input ?? {}) as Partial<Product>;
  if (typeof p.sku !== 'string' || !SKU_RE.test(p.sku)) throw new Error('product.sku is required (alphanumeric . _ -, ≤64)');
  if (typeof p.name !== 'string' || !p.name.trim()) throw new Error('product.name is required');
  const price = money(p.price, 'product');

  const variants: Variant[] = (p.variants ?? []).map((v, i) => {
    if (typeof v.sku !== 'string' || !SKU_RE.test(v.sku)) throw new Error(`variant[${i}].sku is required`);
    if (!v.options || typeof v.options !== 'object') throw new Error(`variant[${i}].options must be an object`);
    if (!Number.isInteger(v.inventory) || v.inventory < 0) throw new Error(`variant[${i}].inventory must be a non-negative integer`);
    return {
      sku: v.sku,
      options: v.options,
      price: v.price ? money(v.price, `variant[${i}]`) : undefined,
      inventory: v.inventory,
      image: typeof v.image === 'string' ? v.image : undefined,
    };
  });

  const sh = (p.shipping ?? {}) as Partial<Shipping>;
  const shippingClass: ShippingClass = sh.class ?? 'standard';
  if (!['small_parcel', 'standard', 'freight', 'digital'].includes(shippingClass)) {
    throw new Error(`product.shipping.class invalid: ${shippingClass}`);
  }
  const shipping: Shipping = {
    class: shippingClass,
    freeShipping: sh.freeShipping ?? false,
    estimatedDaysMin: Number.isInteger(sh.estimatedDaysMin) ? (sh.estimatedDaysMin as number) : 3,
    estimatedDaysMax: Number.isInteger(sh.estimatedDaysMax) ? (sh.estimatedDaysMax as number) : 7,
    handlingFee: sh.handlingFee ? money(sh.handlingFee, 'product.shipping.handlingFee') : undefined,
  };
  if (shipping.estimatedDaysMin > shipping.estimatedDaysMax) throw new Error('shipping.estimatedDaysMin exceeds estimatedDaysMax');

  if (p.inventory !== undefined && (!Number.isInteger(p.inventory) || p.inventory < 0)) {
    throw new Error('product.inventory must be a non-negative integer');
  }

  return {
    sku: p.sku,
    name: p.name,
    description: typeof p.description === 'string' ? p.description : undefined,
    brand: typeof p.brand === 'string' ? p.brand : undefined,
    category: typeof p.category === 'string' ? p.category : undefined,
    price,
    images: Array.isArray(p.images) ? p.images.filter((x): x is string => typeof x === 'string') : [],
    dimensions: p.dimensions,
    weight: p.weight,
    attributes: p.attributes && typeof p.attributes === 'object' ? p.attributes : {},
    variants,
    inventory: Number.isInteger(p.inventory) ? (p.inventory as number) : 0,
    shipping,
    taxCode: typeof p.taxCode === 'string' ? p.taxCode : undefined,
  };
}

/** Resolve the effective unit price + inventory for a (product, variantSku?). */
export function resolveVariant(product: Product, variantSku?: string): { unit_price: Money; variant?: Variant } {
  if (!variantSku) return { unit_price: product.price };
  const v = product.variants.find((x) => x.sku === variantSku);
  if (!v) throw new Error(`variant not found on ${product.sku}: ${variantSku}`);
  return { unit_price: v.price ?? product.price, variant: v };
}

// --- store ----------------------------------------------------------------

export interface ProductStore {
  list(merchant: string): Promise<Product[]>;
  get(merchant: string, sku: string): Promise<Product | null>;
  create(merchant: string, product: Product): Promise<Product>;
  update(merchant: string, sku: string, patch: Partial<Product>): Promise<Product>;
  remove(merchant: string, sku: string): Promise<void>;
}

/** In-memory store, seeded from SEED. Mock/dev: not durable across isolates. */
export class MemoryProductStore implements ProductStore {
  private data = new Map<string, Map<string, Product>>();

  constructor(seed: Record<string, Product[]> = SEED) {
    for (const [merchant, products] of Object.entries(seed)) {
      const m = new Map<string, Product>();
      for (const p of products) m.set(p.sku, structuredClone(p));
      this.data.set(merchant, m);
    }
  }

  private bucket(merchant: string): Map<string, Product> {
    let m = this.data.get(merchant);
    if (!m) {
      m = new Map();
      this.data.set(merchant, m);
    }
    return m;
  }

  async list(merchant: string): Promise<Product[]> {
    return [...this.bucket(merchant).values()].map((p) => structuredClone(p));
  }
  async get(merchant: string, sku: string): Promise<Product | null> {
    const p = this.bucket(merchant).get(sku);
    return p ? structuredClone(p) : null;
  }
  async create(merchant: string, product: Product): Promise<Product> {
    const b = this.bucket(merchant);
    if (b.has(product.sku)) throw new Error(`product already exists: ${product.sku}`);
    b.set(product.sku, structuredClone(product));
    return product;
  }
  async update(merchant: string, sku: string, patch: Partial<Product>): Promise<Product> {
    const b = this.bucket(merchant);
    const cur = b.get(sku);
    if (!cur) throw new Error(`unknown product: ${sku}`);
    const merged = validateProduct({ ...cur, ...patch, sku }); // sku is immutable
    b.set(sku, merged);
    return merged;
  }
  async remove(merchant: string, sku: string): Promise<void> {
    if (!this.bucket(merchant).delete(sku)) throw new Error(`unknown product: ${sku}`);
  }
}

/** D1-backed store — one row per (merchant, sku) with the product as JSON.
 *  Requires the schema in db/schema.sql. Durable across isolates. */
export interface D1Like {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = unknown>(col?: string): Promise<T | null>;
      run(): Promise<unknown>;
      all<T = unknown>(): Promise<{ results: T[] }>;
    };
  };
}

export class D1ProductStore implements ProductStore {
  constructor(private db: D1Like) {}

  async list(merchant: string): Promise<Product[]> {
    const { results } = await this.db.prepare('SELECT json FROM products WHERE merchant = ? ORDER BY sku').bind(merchant).all<{ json: string }>();
    return results.map((r) => JSON.parse(r.json) as Product);
  }
  async get(merchant: string, sku: string): Promise<Product | null> {
    const row = await this.db.prepare('SELECT json FROM products WHERE merchant = ? AND sku = ?').bind(merchant, sku).first<{ json: string }>();
    return row ? (JSON.parse(row.json) as Product) : null;
  }
  async create(merchant: string, product: Product): Promise<Product> {
    if (await this.get(merchant, product.sku)) throw new Error(`product already exists: ${product.sku}`);
    await this.db.prepare('INSERT INTO products (merchant, sku, json) VALUES (?, ?, ?)').bind(merchant, product.sku, JSON.stringify(product)).run();
    return product;
  }
  async update(merchant: string, sku: string, patch: Partial<Product>): Promise<Product> {
    const cur = await this.get(merchant, sku);
    if (!cur) throw new Error(`unknown product: ${sku}`);
    const merged = validateProduct({ ...cur, ...patch, sku });
    await this.db.prepare('UPDATE products SET json = ? WHERE merchant = ? AND sku = ?').bind(JSON.stringify(merged), merchant, sku).run();
    return merged;
  }
  async remove(merchant: string, sku: string): Promise<void> {
    const cur = await this.get(merchant, sku);
    if (!cur) throw new Error(`unknown product: ${sku}`);
    await this.db.prepare('DELETE FROM products WHERE merchant = ? AND sku = ?').bind(merchant, sku).run();
  }
}

// --- seed data (rich, Wayfair-style) --------------------------------------

export const SEED: Record<string, Product[]> = {
  homegoods: [
    {
      sku: 'sofa-3seat',
      name: 'Marlow 3-Seat Sofa',
      description: 'Mid-century 3-seat sofa with solid oak legs and stain-resistant weave.',
      brand: 'Marlow',
      category: 'Living Room / Sofas',
      price: { amount: 89900, currency: 'USD' },
      images: ['https://mock.cdn/homegoods/sofa-3seat-navy.jpg'],
      dimensions: { length: 84, width: 36, height: 34, unit: 'in' },
      weight: { value: 118, unit: 'lb' },
      attributes: { material: 'Polyester weave / oak', assembly: 'Legs attach (no tools)', warranty: '5 years' },
      variants: [
        { sku: 'sofa-3seat-navy', options: { color: 'Navy' }, inventory: 12, image: 'https://mock.cdn/homegoods/sofa-3seat-navy.jpg' },
        { sku: 'sofa-3seat-grey', options: { color: 'Heather Grey' }, inventory: 7, image: 'https://mock.cdn/homegoods/sofa-3seat-grey.jpg' },
        { sku: 'sofa-3seat-forest', options: { color: 'Forest Green' }, price: { amount: 94900, currency: 'USD' }, inventory: 3 },
      ],
      inventory: 0,
      shipping: { class: 'freight', freeShipping: true, estimatedDaysMin: 7, estimatedDaysMax: 14, handlingFee: { amount: 0, currency: 'USD' } },
      taxCode: 'furniture',
    },
    {
      sku: 'rug-9x12',
      name: '9×12 Hand-Loomed Area Rug',
      brand: 'Loomcraft',
      category: 'Decor / Rugs',
      price: { amount: 12000, currency: 'USD' },
      images: ['https://mock.cdn/homegoods/rug-9x12.jpg'],
      dimensions: { length: 144, width: 108, height: 1, unit: 'in' },
      weight: { value: 34, unit: 'lb' },
      attributes: { material: 'Wool blend', pile: 'Medium', origin: 'India' },
      variants: [
        { sku: 'rug-9x12-ivory', options: { color: 'Ivory' }, inventory: 25 },
        { sku: 'rug-9x12-charcoal', options: { color: 'Charcoal' }, inventory: 18 },
      ],
      inventory: 0,
      shipping: { class: 'standard', freeShipping: true, estimatedDaysMin: 4, estimatedDaysMax: 8 },
      taxCode: 'home_textiles',
    },
    {
      sku: 'lamp-arc',
      name: 'Arc Floor Lamp',
      brand: 'Lumen',
      category: 'Lighting / Floor Lamps',
      price: { amount: 14900, currency: 'USD' },
      images: ['https://mock.cdn/homegoods/lamp-arc.jpg'],
      dimensions: { length: 12, width: 72, height: 80, unit: 'in' },
      weight: { value: 22, unit: 'lb' },
      attributes: { material: 'Brushed steel', bulb: 'E26, not included' },
      variants: [],
      inventory: 40,
      shipping: { class: 'standard', freeShipping: false, estimatedDaysMin: 3, estimatedDaysMax: 6, handlingFee: { amount: 900, currency: 'USD' } },
      taxCode: 'lighting',
    },
    {
      sku: 'table-coffee',
      name: 'Oak Coffee Table',
      brand: 'Marlow',
      category: 'Living Room / Tables',
      price: { amount: 32900, currency: 'USD' },
      images: ['https://mock.cdn/homegoods/table-coffee.jpg'],
      dimensions: { length: 48, width: 24, height: 18, unit: 'in' },
      weight: { value: 46, unit: 'lb' },
      attributes: { material: 'Solid white oak', assembly: 'Required (tools included)' },
      variants: [],
      inventory: 15,
      shipping: { class: 'freight', freeShipping: true, estimatedDaysMin: 6, estimatedDaysMax: 12 },
      taxCode: 'furniture',
    },
    {
      sku: 'pillow-set4',
      name: 'Throw Pillow Set (4)',
      brand: 'Loomcraft',
      category: 'Decor / Pillows',
      price: { amount: 5900, currency: 'USD' },
      images: ['https://mock.cdn/homegoods/pillow-set4.jpg'],
      weight: { value: 5, unit: 'lb' },
      attributes: { material: 'Cotton, feather fill', count: '4' },
      variants: [
        { sku: 'pillow-set4-neutral', options: { palette: 'Neutral' }, inventory: 60 },
        { sku: 'pillow-set4-jewel', options: { palette: 'Jewel' }, inventory: 44 },
      ],
      inventory: 0,
      shipping: { class: 'small_parcel', freeShipping: false, estimatedDaysMin: 2, estimatedDaysMax: 5 },
      taxCode: 'home_textiles',
    },
  ],
  apihub: [
    {
      sku: 'premium-call',
      name: 'Premium API Call',
      category: 'API / Metered',
      price: { amount: 100, currency: 'USD' },
      images: [],
      attributes: { unit: '1 call', rateLimit: '100/s' },
      variants: [],
      inventory: 1_000_000,
      shipping: { class: 'digital', freeShipping: true, estimatedDaysMin: 0, estimatedDaysMax: 0 },
      taxCode: 'digital_service',
    },
    {
      sku: 'bulk-1k',
      name: 'Bulk Pack — 1,000 Calls',
      category: 'API / Bundles',
      price: { amount: 90000, currency: 'USD' },
      images: [],
      attributes: { unit: '1,000 calls', expiry: '12 months' },
      variants: [],
      inventory: 1_000_000,
      shipping: { class: 'digital', freeShipping: true, estimatedDaysMin: 0, estimatedDaysMax: 0 },
      taxCode: 'digital_service',
    },
    {
      sku: 'priority-call',
      name: 'Priority (Low-Latency) Call',
      category: 'API / Metered',
      price: { amount: 250, currency: 'USD' },
      images: [],
      attributes: { unit: '1 call', sla: 'p99 < 50ms' },
      variants: [],
      inventory: 1_000_000,
      shipping: { class: 'digital', freeShipping: true, estimatedDaysMin: 0, estimatedDaysMax: 0 },
      taxCode: 'digital_service',
    },
  ],
  makermart: [
    {
      sku: 'mug-handmade',
      name: 'Handmade Ceramic Mug',
      brand: 'Kiln & Co.',
      category: 'Kitchen / Drinkware',
      price: { amount: 2800, currency: 'USD' },
      images: ['https://mock.cdn/makermart/mug.jpg'],
      weight: { value: 1, unit: 'lb' },
      attributes: { material: 'Stoneware', dishwasher: 'Safe' },
      variants: [
        { sku: 'mug-handmade-sky', options: { glaze: 'Sky' }, inventory: 30 },
        { sku: 'mug-handmade-rust', options: { glaze: 'Rust' }, inventory: 22 },
      ],
      inventory: 0,
      shipping: { class: 'small_parcel', freeShipping: false, estimatedDaysMin: 3, estimatedDaysMax: 7 },
      taxCode: 'general',
    },
    {
      sku: 'scarf-wool',
      name: 'Hand-Knit Wool Scarf',
      brand: 'Highland',
      category: 'Apparel / Accessories',
      price: { amount: 4500, currency: 'USD' },
      images: ['https://mock.cdn/makermart/scarf.jpg'],
      attributes: { material: '100% merino wool' },
      variants: [],
      inventory: 18,
      shipping: { class: 'small_parcel', freeShipping: true, estimatedDaysMin: 4, estimatedDaysMax: 9 },
      taxCode: 'apparel',
    },
    {
      sku: 'bowl-walnut',
      name: 'Turned Walnut Bowl',
      brand: 'Grain',
      category: 'Kitchen / Serveware',
      price: { amount: 6200, currency: 'USD' },
      images: ['https://mock.cdn/makermart/bowl.jpg'],
      weight: { value: 2, unit: 'lb' },
      attributes: { material: 'Black walnut', finish: 'Food-safe oil' },
      variants: [],
      inventory: 9,
      shipping: { class: 'small_parcel', freeShipping: false, estimatedDaysMin: 3, estimatedDaysMax: 7 },
      taxCode: 'general',
    },
    {
      sku: 'journal-leather',
      name: 'Hand-Bound Leather Journal',
      brand: 'Foxed',
      category: 'Stationery',
      price: { amount: 3900, currency: 'USD' },
      images: ['https://mock.cdn/makermart/journal.jpg'],
      attributes: { pages: '192', paper: '120gsm' },
      variants: [
        { sku: 'journal-leather-tan', options: { color: 'Tan' }, inventory: 26 },
        { sku: 'journal-leather-oxblood', options: { color: 'Oxblood' }, inventory: 14 },
      ],
      inventory: 0,
      shipping: { class: 'small_parcel', freeShipping: false, estimatedDaysMin: 3, estimatedDaysMax: 7 },
      taxCode: 'general',
    },
  ],
};
