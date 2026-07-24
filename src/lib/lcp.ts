// The LCP layer — self-contained, field-identical to @legalcontext/core +
// @legalcontext/protocol-ucp. LCP is "a hash in a field": we build the
// legal-context.json discovery doc, the `lcp:sha256:0x…` reference, and the two
// UCP carriers (Tier-A `links` discovery / Tier-B `extensions` integrity).

import { atrHashOf } from './crypto.js';

/** The Level-4 dispute-resolution hook (§2.5). All members optional. */
export interface DisputeResolution {
  method?: string; // e.g. "AAA Commercial Arbitration Rules"
  jurisdiction?: string; // e.g. "New York, USA"
  clauseId?: string; // sha256:0x<hex> content-address of the clause
  contact?: string;
  source?: string;
  catalog?: string;
}

/** The `/.well-known/legal-context.json` discovery document (spec §2). */
export interface LegalContextDoc {
  terms: string; // absolute HTTPS URL to the byte-stable terms file
  termsFormat?: 'markdown' | 'json' | 'plain' | 'html' | 'pdf';
  atrHash: string; // 0x + 64 hex — SHA-256 of the terms bytes
  disputeResolution?: DisputeResolution;
}

/** The UCP reverse-domain extension key that carries the LCP reference (Tier B). */
export const LCP_EXTENSION_KEY = 'org.legalcontextprotocol.legal-context';

/** UCP Tier-A well-known link type (discovery, §8.3.7). */
export const UCP_TERMS_LINK_TYPE = 'terms_of_service';

/** The canonical string reference (§8.1/§8.2): `lcp:sha256:0x<64hex>`. */
export function lcpReference(atrHash: string): string {
  return `lcp:sha256:${atrHash}`;
}

/** Tier-B carrier: the structured `extensions[…]` entry (integrity, Level 2+). */
export interface LcpExtension {
  type: 'sha256';
  value: string; // the atrHash
  disputeResolution?: DisputeResolution;
}

export function buildLcpExtension(atrHash: string, dr?: DisputeResolution): Record<string, LcpExtension> {
  const ext: LcpExtension = { type: 'sha256', value: atrHash };
  if (dr) ext.disputeResolution = dr;
  return { [LCP_EXTENSION_KEY]: ext };
}

/** Tier-A carrier: a UCP checkout `links[]` entry pointing at the terms/discovery. */
export function buildTermsLink(url: string): { type: string; url: string } {
  return { type: UCP_TERMS_LINK_TYPE, url };
}

/** Build (and validate) a legal-context.json for a merchant's byte-stable terms. */
export async function buildLegalContext(opts: {
  termsUrl: string;
  termsText: string;
  disputeResolution?: DisputeResolution;
}): Promise<LegalContextDoc> {
  if (!opts.termsUrl.startsWith('https://')) throw new Error('terms URL must be absolute HTTPS (§2.4)');
  const atrHash = await atrHashOf(opts.termsText);
  const doc: LegalContextDoc = { terms: opts.termsUrl, termsFormat: 'markdown', atrHash };
  if (opts.disputeResolution) doc.disputeResolution = opts.disputeResolution;
  return doc;
}

/** Verify that terms bytes reproduce a claimed atrHash (the L2 tamper-evidence check). */
export async function verifyTermsHash(termsText: string, claimedAtrHash: string): Promise<boolean> {
  return (await atrHashOf(termsText)) === claimedAtrHash.toLowerCase();
}
