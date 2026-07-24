// x402 — the HTTP-402 "pay-per-request" rail (Coinbase's open standard), priced
// from the SAME catalog as UCP/AP2 and welding the SAME LCP reference. This is the
// point of doing it here: one product model, one legal-context, three payment rails.
//
// Flow (per the x402 spec, v1):
//   1. client requests a protected resource with no payment
//   2. server → 402 + { x402Version, accepts: [PaymentRequirements] }
//   3. client resends with an `X-PAYMENT` header (base64 of a PaymentPayload)
//   4. server verifies + settles → 200 + `X-PAYMENT-RESPONSE` header (settlement)
//
// MOCK posture: signatures are not cryptographically verified on-chain and nothing
// settles for real — the merchant checks the payload shape + amount and returns a
// mock settlement (a fake tx hash). Testnet asset/network are the real base-sepolia
// USDC values so the shapes match a real integration.

import { sha256Hex, utf8 } from './crypto.js';
import { LCP_EXTENSION_KEY, lcpReference } from './lcp.js';
import type { Money, Product } from './catalog.js';

// Real base-sepolia USDC (testnet) so the requirement shapes are faithful.
export const X402_NETWORK = 'base-sepolia';
export const X402_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const X402_USDC_DECIMALS = 6;

export interface PaymentRequirements {
  scheme: 'exact';
  network: string;
  maxAmountRequired: string; // atomic units of `asset` (string, per spec)
  resource: string;
  description: string;
  mimeType: string;
  payTo: string; // merchant receiving address
  maxTimeoutSeconds: number;
  asset: string; // token contract
  extra: Record<string, unknown>; // EIP-712 name/version + the LCP reference + terms url
}

export interface PaymentRequiredBody {
  x402Version: number;
  accepts: PaymentRequirements[];
  error?: string;
}

export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: string;
    authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };
  };
}

export interface Settlement {
  success: boolean;
  transaction: string; // tx hash (mock)
  network: string;
  payer: string;
}

/** USD minor units (cents, 2dp) → USDC atomic units (6dp). */
export function centsToUsdcAtomic(cents: number): string {
  return String(cents * 10 ** (X402_USDC_DECIMALS - 2));
}

export interface BuildRequirementsInput {
  product: Product;
  unitPrice: Money; // resolved (variant-aware) price
  resource: string; // absolute resource URL
  atrHash: string;
  termsUrl: string;
  payTo: string;
}

/** Build the x402 PaymentRequirements for a catalog product, welding LCP in `extra`. */
export function buildX402Requirements(i: BuildRequirementsInput): PaymentRequirements {
  return {
    scheme: 'exact',
    network: X402_NETWORK,
    maxAmountRequired: centsToUsdcAtomic(i.unitPrice.amount),
    resource: i.resource,
    description: i.product.name,
    mimeType: 'application/json',
    payTo: i.payTo,
    maxTimeoutSeconds: 60,
    asset: X402_USDC,
    extra: {
      name: 'USDC',
      version: '2',
      terms: i.termsUrl,
      [LCP_EXTENSION_KEY]: { type: 'sha256', value: i.atrHash }, // Tier-B weld, same key as UCP
    },
  };
}

export function build402Body(accepts: PaymentRequirements[], error: string): PaymentRequiredBody {
  return { x402Version: 1, accepts, error };
}

/** Decode + verify an X-PAYMENT header against a requirement, then "settle" (mock).
 *  Fails loud on scheme/network/asset/amount/recipient mismatch. */
export async function verifyX402Payment(headerB64: string, req: PaymentRequirements): Promise<Settlement> {
  let payment: PaymentPayload;
  try {
    payment = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(headerB64), (ch) => ch.charCodeAt(0)))) as PaymentPayload;
  } catch {
    throw new Error('X-PAYMENT is not valid base64 JSON');
  }
  if (payment.scheme !== req.scheme) throw new Error(`scheme mismatch: ${payment.scheme} != ${req.scheme}`);
  if (payment.network !== req.network) throw new Error(`network mismatch: ${payment.network} != ${req.network}`);
  const a = payment.payload?.authorization;
  if (!a) throw new Error('payment payload missing authorization');
  if (!payment.payload.signature) throw new Error('payment payload missing signature');
  if (a.to.toLowerCase() !== req.payTo.toLowerCase()) throw new Error('authorization.to is not the merchant payTo');
  if (BigInt(a.value) < BigInt(req.maxAmountRequired)) throw new Error(`insufficient amount: ${a.value} < ${req.maxAmountRequired}`);

  // Mock settlement: a deterministic fake tx hash over the payment bytes.
  const transaction = '0x' + (await sha256Hex(utf8(headerB64)));
  return { success: true, transaction, network: req.network, payer: a.from };
}

/** Encode a settlement for the `X-PAYMENT-RESPONSE` header (base64 JSON). */
export function encodeSettlement(s: Settlement): string {
  return btoa(JSON.stringify(s));
}

/** Build a MOCK X-PAYMENT header that satisfies a requirement — for clients that
 *  don't have a wallet (the console, the report, a reference buyer). Real clients
 *  replace this with an EIP-3009 `transferWithAuthorization` signature. */
export function buildMockPaymentHeader(req: PaymentRequirements, from: string): string {
  const payload: PaymentPayload = {
    x402Version: 1,
    scheme: 'exact',
    network: req.network,
    payload: {
      signature: '0xmock',
      authorization: {
        from,
        to: req.payTo,
        value: req.maxAmountRequired,
        validAfter: '0',
        validBefore: '99999999999',
        nonce: '0x' + '0'.repeat(64),
      },
    },
  };
  return btoa(JSON.stringify(payload));
}

export const x402LcpReference = lcpReference;
