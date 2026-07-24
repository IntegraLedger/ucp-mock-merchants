import { describe, it, expect } from 'vitest';
import app from '../src/index.js';
import { LCP_EXTENSION_KEY } from '../src/lib/lcp.js';

const H = { 'content-type': 'application/json' };
const call = (method: string, path: string, body?: unknown) =>
  app.fetch(new Request(`https://mock.local${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined }));
const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;

describe('MCP tool server', () => {
  it('initializes, lists tools, and creates a checkout via tools/call', async () => {
    const init = await json<{ result: { protocolVersion: string; instructions: string } }>(await call('POST', '/homegoods/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    expect(init.result.protocolVersion).toBeTruthy();
    expect(init.result.instructions).toContain('lcp:sha256:0x'); // LCP surfaced

    const list = await json<{ result: { tools: Array<{ name: string }> } }>(await call('POST', '/homegoods/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    expect(list.result.tools.map((t) => t.name)).toContain('create_checkout');

    const callRes = await json<{ result: { content: Array<{ text: string }> } }>(await call('POST', '/homegoods/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_checkout', arguments: { items: [{ sku: 'rug-9x12', qty: 1 }] } } }));
    const payload = JSON.parse(callRes.result.content[0]!.text) as { checkout_jwt: string; lcp_reference: string };
    expect(payload.checkout_jwt).toBeTruthy();
    expect(payload.lcp_reference).toMatch(/^lcp:sha256:0x/);
  });
});

describe('A2A agent', () => {
  it('serves an agent card with skills + LCP, and completes a checkout task', async () => {
    const card = await json<Record<string, unknown>>(await call('GET', '/apihub/.well-known/agent.json'));
    expect((card.skills as unknown[]).length).toBeGreaterThan(0);
    expect((card[LCP_EXTENSION_KEY] as { value: string }).value).toMatch(/^0x[0-9a-f]{64}$/);

    const task = await json<{ result: { status: { state: string }; artifacts: Array<{ parts: Array<{ data: { checkout_jwt?: string } }> }> } }>(
      await call('POST', '/apihub/a2a', { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', parts: [{ kind: 'data', data: { action: 'checkout', items: [{ sku: 'premium-call', qty: 2 }] } }] } } }),
    );
    expect(task.result.status.state).toBe('completed');
    expect(task.result.artifacts[0]!.parts[0]!.data.checkout_jwt).toBeTruthy();
  });
});

describe('ACP checkout sessions', () => {
  it('creates a ready session, updates it, and completes it', async () => {
    const create = await json<{ id: string; status: string; totals: Array<{ type: string; amount: number }> }>(
      await call('POST', '/makermart/acp/checkout_sessions', { items: [{ sku: 'mug-handmade', qty: 2 }], fulfillment_address: { name: 'R', line1: '1', city: 'SF', region: 'CA', postal: '94000', country: 'US' } }),
    );
    expect(create.status).toBe('ready_for_payment');
    expect(create.totals.find((t) => t.type === 'total')!.amount).toBeGreaterThan(0);

    const complete = await json<{ status: string; order?: { status: string } }>(await call('POST', `/makermart/acp/checkout_sessions/${create.id}/complete`));
    expect(complete.status).toBe('completed');
    expect(complete.order?.status).toBe('paid');
  });
});
