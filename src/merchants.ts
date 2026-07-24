// The mock-merchant registry. Each merchant has a stable ES256 signing key
// (DEV/THROWAWAY — testnet/mock posture, never real value), a byte-stable terms
// document (with an illustrative AAA dispute clause), a small catalog, and a
// dispute-resolution declaration.
//
// ⚠️ The `d` (private) values below are throwaway demo keys committed on purpose
// (mirrors the demo's own posture). Do NOT reuse for anything real.

import type { PrivateJwk } from './lib/crypto.js';
import type { DisputeResolution } from './lib/lcp.js';

export interface CatalogItem {
  sku: string;
  name: string;
  price: { amount: number; currency: string }; // amount in minor units (cents)
}

export interface Merchant {
  id: string;
  name: string;
  kid: string;
  signingKey: PrivateJwk;
  terms: string; // the byte-stable terms document (exact bytes get hashed)
  disputeResolution: DisputeResolution;
  catalog: CatalogItem[];
}

const HOMEGOODS_TERMS = `# Homegoods Co. — Terms of Sale

**Effective Date:** 2026-07-24

By initiating an agentic purchase, the Buyer agrees to these Terms.

## 1. Sale
Homegoods Co. sells home furnishings on a per-order basis, settled in USDC.

## 2. Returns
Unused items may be returned within thirty (30) days of delivery.

## 3. Dispute Resolution
Any dispute arising out of these Terms shall be resolved by binding arbitration
administered by the American Arbitration Association under its Commercial
Arbitration Rules by a single arbitrator; the seat of arbitration shall be New York, NY.
`;

const APIHUB_TERMS = `# ApiHub — Terms of Service

**Effective Date:** 2026-07-24

By calling the Premium Resource endpoint, the Buyer agrees to these Terms.

## 1. Service
Metered API access on a pay-per-call basis, one (1) USDC per call, payable in advance.

## 2. Refunds
On confirmed provider error, a full refund is issued within seven (7) business days.

## 3. Dispute Resolution
Disputes are resolved by AAA Expedited Procedures (documents-only, single arbitrator);
the seat of arbitration shall be Boston, MA.
`;

const MAKERMART_TERMS = `# MakerMart — Marketplace Terms

**Effective Date:** 2026-07-24

By purchasing a listed item, the Buyer agrees to these Terms and the seller's listing terms.

## 1. Marketplace
MakerMart facilitates sales of handmade items between independent sellers and buyers.

## 2. Dispute Resolution
Disputes are resolved by binding arbitration administered by the American Arbitration
Association under its Commercial Arbitration Rules; the seat of arbitration shall be San Francisco, CA.
`;

export const MERCHANTS: Record<string, Merchant> = {
  homegoods: {
    id: 'homegoods',
    name: 'Homegoods Co.',
    kid: 'homegoods-key-1',
    signingKey: {
      kty: 'EC', crv: 'P-256',
      x: 'uxX3vXpG93ovj9FWXM_zaVqNh7ZWMkfwI43vf3tgCSM',
      y: '45EYBxsFMgwwAhiFdlufKkL2Z2lizW-vxslcwwGCp98',
      d: 'P9yf3rliqMFurPfshEbg6hw3gd04LzLAi--mbxDlG4M',
    },
    terms: HOMEGOODS_TERMS,
    disputeResolution: { method: 'AAA Commercial Arbitration Rules', jurisdiction: 'New York, USA' },
    catalog: [
      { sku: 'rug-9x12', name: '9×12 Area Rug', price: { amount: 12000, currency: 'USD' } },
      { sku: 'sofa-3seat', name: '3-Seat Sofa', price: { amount: 89900, currency: 'USD' } },
      { sku: 'lamp-arc', name: 'Arc Floor Lamp', price: { amount: 14900, currency: 'USD' } },
      { sku: 'table-coffee', name: 'Oak Coffee Table', price: { amount: 32900, currency: 'USD' } },
      { sku: 'pillow-set4', name: 'Throw Pillow Set (4)', price: { amount: 5900, currency: 'USD' } },
    ],
  },
  apihub: {
    id: 'apihub',
    name: 'ApiHub',
    kid: 'apihub-key-1',
    signingKey: {
      kty: 'EC', crv: 'P-256',
      x: 'tR6Sjr-l_69LB0oyL6pdFmPlzVjaIOS-7CnZdSXnXyg',
      y: 'eVhPTEGq-EogiQZwInVgsOo2ZuYTct_viglD0vmN4ac',
      d: 'Fnz4OB7yoeOmhidXim9FW8qr65xqiudEPc_aSd86E9M',
    },
    terms: APIHUB_TERMS,
    disputeResolution: { method: 'AAA Expedited Procedures', jurisdiction: 'Massachusetts, USA' },
    catalog: [
      { sku: 'premium-call', name: 'Premium API Call', price: { amount: 100, currency: 'USD' } },
      { sku: 'bulk-1k', name: 'Bulk Pack — 1,000 Calls', price: { amount: 90000, currency: 'USD' } },
      { sku: 'priority-call', name: 'Priority (Low-Latency) Call', price: { amount: 250, currency: 'USD' } },
    ],
  },
  makermart: {
    id: 'makermart',
    name: 'MakerMart',
    kid: 'makermart-key-1',
    signingKey: {
      kty: 'EC', crv: 'P-256',
      x: 'Pck4enRUM75kW3w7wMp7XootGAf1j9UyDy4W56q2_Ds',
      y: 'I65wew9_1-nxQSlEeiCKcgIZhFjRfDioT6CL3vEOJ-s',
      d: 'DQ4vJIXY_pi0gA0xY1jqpwit0Fk9W9Njn8WoppPAIv0',
    },
    terms: MAKERMART_TERMS,
    disputeResolution: { method: 'AAA Commercial Arbitration Rules', jurisdiction: 'California, USA' },
    catalog: [
      { sku: 'mug-handmade', name: 'Handmade Ceramic Mug', price: { amount: 2800, currency: 'USD' } },
      { sku: 'scarf-wool', name: 'Hand-Knit Wool Scarf', price: { amount: 4500, currency: 'USD' } },
      { sku: 'bowl-walnut', name: 'Turned Walnut Bowl', price: { amount: 6200, currency: 'USD' } },
      { sku: 'journal-leather', name: 'Hand-Bound Leather Journal', price: { amount: 3900, currency: 'USD' } },
    ],
  },
};

export function getMerchant(id: string): Merchant {
  const m = MERCHANTS[id];
  if (!m) throw new Error(`unknown merchant: ${id}`);
  return m;
}

export const MERCHANT_IDS = Object.keys(MERCHANTS);
