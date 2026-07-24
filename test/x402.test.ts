import { describe, it, expect } from 'vitest';
import app from '../src/index.js';
import { buildMockPaymentHeader, type PaymentRequirements } from '../src/lib/x402.js';
import { LCP_EXTENSION_KEY } from '../src/lib/lcp.js';

const get = (path: string, headers?: Record<string, string>) =>
  app.fetch(new Request(`https://mock.local${path}`, { headers }));

describe('x402 (HTTP-402 pay-per-request)', () => {
  it('challenges with 402 + LCP-welded requirements, then settles on payment', async () => {
    // no payment → 402 with requirements
    const chal = await get('/apihub/x402/premium-call');
    expect(chal.status).toBe(402);
    const body = (await chal.json()) as { x402Version: number; accepts: PaymentRequirements[] };
    const rq = body.accepts[0]!;
    expect(rq.scheme).toBe('exact');
    expect(rq.network).toBe('base-sepolia');
    expect(rq.maxAmountRequired).toBe('1000000'); // $1.00 → 1_000_000 atomic USDC (6dp)
    expect(rq.payTo).toBe('0x2222222222222222222222222222222222222222');

    // the SAME LCP reference rides the x402 requirement (Tier B)
    const atr = (await (await get('/apihub/.well-known/legal-context.json')).json()) as { atrHash: string };
    expect((rq.extra[LCP_EXTENSION_KEY] as { value: string }).value).toBe(atr.atrHash);

    // pay → 200 + settlement + X-PAYMENT-RESPONSE
    const header = buildMockPaymentHeader(rq, '0x' + 'ab'.repeat(20));
    const paid = await get('/apihub/x402/premium-call', { 'X-PAYMENT': header });
    expect(paid.status).toBe(200);
    expect(paid.headers.get('X-PAYMENT-RESPONSE')).toBeTruthy();
    const pj = (await paid.json()) as { paid: boolean; settlement: { success: boolean; transaction: string }; lcp_reference: string };
    expect(pj.paid).toBe(true);
    expect(pj.settlement.success).toBe(true);
    expect(pj.settlement.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    expect(pj.lcp_reference).toBe('lcp:sha256:' + atr.atrHash);
  });

  it('rejects an underpaying / wrong-recipient payment', async () => {
    const chal = await get('/apihub/x402/bulk-1k');
    const rq = ((await chal.json()) as { accepts: PaymentRequirements[] }).accepts[0]!;
    // tamper the amount down
    const bad = { ...rq, maxAmountRequired: '1' };
    const header = buildMockPaymentHeader(bad, '0x' + 'ab'.repeat(20));
    const paid = await get('/apihub/x402/bulk-1k', { 'X-PAYMENT': header });
    expect(paid.status).toBe(402); // insufficient amount → still 402
  });
});
