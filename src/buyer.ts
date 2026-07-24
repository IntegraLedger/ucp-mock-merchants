// A reference LCP-aware BUYER agent — the guide Fisher builds a real buyer from.
//
// It drives the full agentic purchase against a UCP merchant over HTTP:
//   discover UCP + LCP → GATE on the terms (recompute the hash BEFORE paying) →
//   checkout → verify the merchant's signature + the welded LCP reference →
//   apply a buyer policy → sign the AP2 mandates → submit → verify the receipt.
//
// The load-bearing idea: a buyer must never pay against terms it hasn't verified.
// Steps 2–3 (fetch the terms, recompute the atrHash, require it to equal the
// reference the merchant signed) are the "buyer gate". Everything downstream is
// only meaningful because that gate passed — change one byte of the terms and the
// recomputed hash won't match, so the buyer refuses to transact.
//
// Transport-agnostic: `fetch` can be the global fetch (a live URL) or a Worker's
// own `app.fetch` (in-process, no server) — see scripts/buyer.ts.

import { atrHashOf, verifyJws, type PrivateJwk, type PublicJwk } from './lib/crypto.js';
import { buildMandateBundle } from './lib/ap2.js';
import { LCP_EXTENSION_KEY } from './lib/lcp.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** A buyer's guardrails — checked before any value moves. */
export interface BuyerPolicy {
  maxTotal?: { amount: number; currency: string }; // decline if the total exceeds this
  requireDisputeResolution?: boolean; // require a dispute-resolution clause to be declared
  allowedJurisdictions?: string[]; // optional substring allowlist for the DR jurisdiction
}

export interface BuyerStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface BuyerOutcome {
  authorized: boolean;
  declinedReason?: string;
  steps: BuyerStep[];
  atrHash?: string;
  checkout_hash?: string;
  receipt?: unknown;
}

export interface RunBuyerOptions {
  merchantBase: string; // e.g. https://host/homegoods (trailing slash tolerated)
  items: Array<{ sku: string; qty: number }>;
  buyerKey: PrivateJwk;
  iat: number; // injected epoch seconds (no Date.now inside — keeps it testable)
  fetch: FetchLike;
  policy?: BuyerPolicy;
}

// Minimal response shapes for the merchant surfaces this buyer consumes.
interface ManifestResponse {
  signing_keys: Array<{ kid: string; kty: 'EC'; crv: 'P-256'; x: string; y: string; alg: string }>;
}
interface LegalContextResponse {
  terms: string;
  atrHash: string;
  disputeResolution?: { method?: string; jurisdiction?: string };
}
interface CheckoutResponse {
  checkout_jwt: string;
  checkout_hash: string;
  lcp_reference: string;
  checkout: {
    merchant: { id: string; name: string };
    total: { amount: number; currency: string };
    extensions: Record<string, unknown>;
    links: Array<{ type: string; url: string }>;
  };
}
interface ReceiptResponse {
  status: string;
  error?: string;
  checkout_hash?: string;
  order_id?: string;
}

/** Internal signal: a clean, expected refusal (vs. an unexpected throw). */
class Decline extends Error {}

/** Run the full buyer flow. Never throws — always resolves to a BuyerOutcome
 *  whose `steps` are a readable trace and whose `authorized` says whether the
 *  purchase completed. */
export async function runBuyer(o: RunBuyerOptions): Promise<BuyerOutcome> {
  const steps: BuyerStep[] = [];
  const base = o.merchantBase.replace(/\/+$/, '');
  const policy = o.policy ?? {};
  const pass = (step: string, detail: string): void => {
    steps.push({ step, ok: true, detail });
  };

  try {
    // 1. Discover the UCP manifest → the merchant's public signing key.
    const manifest = await getJson<ManifestResponse>(o.fetch, `${base}/.well-known/ucp`);
    const sk = manifest.signing_keys[0];
    if (!sk) throw new Decline('UCP manifest has no signing key');
    const merchantPub: PublicJwk = { kty: sk.kty, crv: sk.crv, x: sk.x, y: sk.y };
    pass('discover-ucp', `merchant key kid=${sk.kid} alg=${sk.alg}`);

    // 2. Discover the LCP legal-context → terms URL, declared atrHash, dispute path.
    const lc = await getJson<LegalContextResponse>(o.fetch, `${base}/.well-known/legal-context.json`);
    if (!lc.atrHash) throw new Decline('legal-context.json has no atrHash');
    pass('discover-lcp', `atrHash=${lc.atrHash} DR=${lc.disputeResolution?.method ?? 'none'}`);

    // 3. THE BUYER GATE — fetch the terms bytes, recompute the hash, and require
    //    it to equal the declared reference (LCP Level 2, integrity). If it
    //    doesn't match, the terms were changed after publication → refuse.
    const termsRes = await o.fetch(lc.terms);
    if (!termsRes.ok) throw new Decline(`terms fetch failed: HTTP ${termsRes.status}`);
    const recomputed = await atrHashOf(await termsRes.text());
    if (recomputed !== lc.atrHash) {
      throw new Decline(`terms hash mismatch: recomputed ${recomputed} != declared ${lc.atrHash}`);
    }
    pass('verify-terms-hash', `recomputed atrHash matches declared (${recomputed.slice(0, 12)}…)`);

    // 4. Policy gate on the legal context (before any spend commitment).
    if (policy.requireDisputeResolution && !lc.disputeResolution?.method) {
      throw new Decline('policy: a dispute-resolution clause is required, none declared');
    }
    if (policy.allowedJurisdictions?.length) {
      const j = lc.disputeResolution?.jurisdiction ?? '';
      if (!policy.allowedJurisdictions.some((a) => j.includes(a))) {
        throw new Decline(`policy: jurisdiction "${j}" is not on the allowlist`);
      }
    }
    pass('policy-legal', 'legal-context policy satisfied');

    // 5. Checkout — the merchant signs a UCP Checkout with the LCP reference welded in.
    const co = await postJson<CheckoutResponse>(o.fetch, `${base}/checkout`, { items: o.items });
    if (!co.checkout_jwt || !co.checkout_hash) throw new Decline('checkout response missing checkout_jwt/checkout_hash');
    pass('checkout', `total ${co.checkout.total.amount} ${co.checkout.total.currency} · checkout_hash=${co.checkout_hash.slice(0, 12)}…`);

    // 6. Verify the checkout is genuinely signed by the manifest's merchant key.
    const cov = await verifyJws(co.checkout_jwt, merchantPub);
    if (!cov.ok) throw new Decline('checkout_jwt signature does not verify under the manifest key');
    pass('verify-checkout-sig', 'checkout_jwt verifies under the merchant key');

    // 7. Verify the welded LCP reference in the SIGNED checkout equals the terms we gated on.
    const ext = co.checkout.extensions[LCP_EXTENSION_KEY] as { type?: string; value?: string } | undefined;
    if (!ext?.value) throw new Decline('signed checkout has no legal-context extension (Tier B)');
    if (ext.value !== lc.atrHash) throw new Decline(`signed checkout LCP reference ${ext.value} != verified terms ${lc.atrHash}`);
    const hasTierA = co.checkout.links.some((l) => l.type === 'terms_of_service');
    pass('verify-checkout-lcp', `signed checkout carries the verified atrHash (Tier B${hasTierA ? ' + Tier A' : ''})`);

    // 8. Spend policy — the total must be within budget.
    if (policy.maxTotal) {
      const t = co.checkout.total;
      if (t.currency !== policy.maxTotal.currency || t.amount > policy.maxTotal.amount) {
        throw new Decline(`policy: total ${t.amount} ${t.currency} exceeds budget ${policy.maxTotal.amount} ${policy.maxTotal.currency}`);
      }
      pass('policy-spend', `total within budget (${t.amount} ≤ ${policy.maxTotal.amount} ${t.currency})`);
    }

    // 9. Sign the AP2 mandate bundle (Checkout + Payment mandates, bound by checkout_hash).
    const bundle = await buildMandateBundle({
      checkout_jwt: co.checkout_jwt,
      checkout_hash: co.checkout_hash,
      payee: { id: co.checkout.merchant.id, name: co.checkout.merchant.name },
      amount: co.checkout.total,
      buyerKey: o.buyerKey,
      iat: o.iat,
    });
    pass('sign-mandates', 'Checkout + Payment mandates signed by the buyer key');

    // 10. Submit the bundle; the merchant verifies it and returns a signed receipt.
    const receipt = await postJson<ReceiptResponse>(o.fetch, `${base}/ap2/receipt`, {
      checkout_jwt: co.checkout_jwt,
      bundle,
    });
    if (receipt.status !== 'authorized') throw new Decline(`merchant declined: ${receipt.error ?? 'unknown reason'}`);
    if (receipt.checkout_hash !== co.checkout_hash) throw new Decline('receipt checkout_hash does not match the checkout');
    pass('receipt', `authorized · order ${receipt.order_id}`);

    return { authorized: true, steps, atrHash: lc.atrHash, checkout_hash: co.checkout_hash, receipt };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    steps.push({ step: 'declined', ok: false, detail: reason });
    return { authorized: false, declinedReason: reason, steps };
  }
}

async function getJson<T>(f: FetchLike, url: string): Promise<T> {
  const r = await f(url);
  if (!r.ok) throw new Error(`GET ${url} → HTTP ${r.status}`);
  return (await r.json()) as T;
}

async function postJson<T>(f: FetchLike, url: string, body: unknown): Promise<T> {
  const r = await f(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // /ap2/receipt returns 422 + a JSON body on decline — read the body either way,
  // and only treat it as a hard error if there's no structured status to report.
  const j = (await r.json().catch(() => ({}))) as T & { status?: string };
  if (!r.ok && !j.status) throw new Error(`POST ${url} → HTTP ${r.status}`);
  return j;
}
