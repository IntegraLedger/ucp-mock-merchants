// Self-contained crypto for the mock merchants — Web Crypto only (runs in both
// Cloudflare Workers and Node 20+). No external LCP packages; field shapes are
// kept byte-identical to @legalcontext/{core,protocol-ucp,protocol-ap2}.
//
// Primitives: base64url, SHA-256 (→ atrHash / checkout_hash), and ES256 (ECDSA
// P-256) JWS sign/verify — exactly the JWS the AP2 mandates and UCP checkout use.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const utf8 = (s: string): Uint8Array => enc.encode(s);
export const fromUtf8 = (b: Uint8Array): string => dec.decode(b);

export function bytesToB64u(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let h = '';
  for (const b of bytes) h += b.toString(16).padStart(2, '0');
  return h;
}

/** SHA-256 of bytes → lowercase hex (no 0x prefix). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return bytesToHex(new Uint8Array(d));
}

/** SHA-256 of bytes → base64url (the AP2 `checkout_hash` construction). */
export async function sha256B64u(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return bytesToB64u(new Uint8Array(d));
}

/** The LCP `atrHash`: `0x` + SHA-256(byte-stable terms), lowercase hex (66 chars). */
export async function atrHashOf(termsText: string): Promise<string> {
  return '0x' + (await sha256Hex(utf8(termsText)));
}

/** AP2 `checkout_hash` = base64url(SHA-256(checkout_jwt utf8 bytes)). */
export async function checkoutHashOf(checkoutJwt: string): Promise<string> {
  return sha256B64u(utf8(checkoutJwt));
}

// --- ES256 (ECDSA P-256) JWS ---------------------------------------------

export interface PrivateJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  d: string;
}
export interface PublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

async function importPrivate(jwk: PrivateJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk as JsonWebKey, ALG, false, ['sign']);
}
async function importPublic(jwk: PublicJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk as JsonWebKey, ALG, false, ['verify']);
}

/** Sign a compact JWS (ES256). `header.kid` names the signing key. */
export async function signJws(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  priv: PrivateJwk,
): Promise<string> {
  const h = bytesToB64u(utf8(JSON.stringify({ alg: 'ES256', typ: 'JWT', ...header })));
  const p = bytesToB64u(utf8(JSON.stringify(payload)));
  const input = `${h}.${p}`;
  const key = await importPrivate(priv);
  const sig = new Uint8Array(await crypto.subtle.sign(SIGN, key, utf8(input) as BufferSource));
  return `${input}.${bytesToB64u(sig)}`;
}

export interface JwsVerifyResult {
  ok: boolean;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

/** Verify a compact JWS (ES256) against a public JWK. Fail-fast: throws on a
 *  structurally malformed token; returns { ok:false } on a bad signature. */
export async function verifyJws(jws: string, pub: PublicJwk): Promise<JwsVerifyResult> {
  const parts = jws.split('.');
  if (parts.length !== 3) throw new Error('malformed JWS (expected three segments)');
  const [h, p, s] = parts as [string, string, string];
  const key = await importPublic(pub);
  const ok = await crypto.subtle.verify(SIGN, key, b64uToBytes(s) as BufferSource, utf8(`${h}.${p}`) as BufferSource);
  return {
    ok,
    header: JSON.parse(fromUtf8(b64uToBytes(h))) as Record<string, unknown>,
    payload: JSON.parse(fromUtf8(b64uToBytes(p))) as Record<string, unknown>,
  };
}

/** Public view of a private JWK (drops `d`) — for the manifest `signing_keys`. */
export function publicOf(priv: PrivateJwk): PublicJwk {
  return { kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y };
}
