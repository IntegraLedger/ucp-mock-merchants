// A2A (Agent2Agent) — publishes each merchant as an A2A agent: a discoverable
// Agent Card at /:m/.well-known/agent.json plus a JSON-RPC task endpoint
// (POST /:m/a2a, method `message/send`). Same catalog + same LCP reference; the
// card advertises the legal context and checkout artifacts carry lcp_reference.

import type { JsonRpcRequest, JsonRpcResponse, McpDeps, OrderItem } from './mcp.js';
import { LCP_EXTENSION_KEY } from './lcp.js';

export interface AgentCardInput {
  name: string;
  description: string;
  url: string; // the A2A endpoint URL
  atrHash: string;
  termsUrl: string;
}

/** The A2A Agent Card (spec §5) with an LCP extension. */
export function agentCard(i: AgentCardInput): Record<string, unknown> {
  return {
    protocolVersion: '0.3.0',
    name: i.name,
    description: i.description,
    url: i.url,
    preferredTransport: 'JSONRPC',
    version: '0.1.0',
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      { id: 'search_catalog', name: 'Search catalog', description: 'Browse or search the merchant catalog.', tags: ['commerce', 'catalog'], examples: ['show me sofas'] },
      { id: 'quote_order', name: 'Quote order', description: 'Price an order incl. shipping, tax and promo codes.', tags: ['commerce'] },
      { id: 'checkout', name: 'Checkout', description: 'Create a signed UCP checkout (LCP reference welded in).', tags: ['commerce', 'payments'] },
    ],
    // LCP extension — the legal context this agent transacts under.
    [LCP_EXTENSION_KEY]: { type: 'sha256', value: i.atrHash, terms: i.termsUrl },
  };
}

export interface A2AAction {
  action?: 'search' | 'quote' | 'checkout';
  query?: string;
  items?: OrderItem[];
  shippingOptionId?: string;
  region?: string;
  promoCode?: string;
}

interface Part {
  kind?: string;
  text?: string;
  data?: A2AAction;
}

/** Pull the intended action from an A2A message's parts (a `data` part, or a
 *  best-effort read of a text part). */
function actionFromMessage(params: Record<string, unknown>): A2AAction {
  const message = (params.message ?? {}) as { parts?: Part[] };
  const parts = message.parts ?? [];
  const dataPart = parts.find((p) => p.data || p.kind === 'data');
  if (dataPart?.data) return dataPart.data;
  const text = parts.find((p) => typeof p.text === 'string')?.text?.toLowerCase() ?? '';
  if (text.includes('checkout')) return { action: 'checkout', items: [] };
  if (text.includes('quote')) return { action: 'quote', items: [] };
  return { action: 'search', query: text || undefined };
}

async function runAction(a: A2AAction, deps: McpDeps): Promise<unknown> {
  switch (a.action) {
    case 'quote':
      return deps.quoteOrder(a.items ?? [], { shippingOptionId: a.shippingOptionId, region: a.region, promoCode: a.promoCode });
    case 'checkout':
      return deps.createCheckout(a.items ?? []);
    case 'search':
    default:
      return deps.searchCatalog(a.query);
  }
}

const rpcErr = (id: JsonRpcResponse['id'], code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

/** Handle an A2A JSON-RPC request. `taskId`/`contextId` are injected. */
export async function handleA2A(req: JsonRpcRequest, deps: McpDeps, ids: { taskId: string; contextId: string; ts: string }): Promise<JsonRpcResponse> {
  const id = req.id ?? null;
  if (req.method !== 'message/send') return rpcErr(id, -32601, `method not found: ${req.method}`);
  try {
    const action = actionFromMessage(req.params ?? {});
    const result = await runAction(action, deps);
    return {
      jsonrpc: '2.0',
      id,
      result: {
        kind: 'task',
        id: ids.taskId,
        contextId: ids.contextId,
        status: { state: 'completed', timestamp: ids.ts },
        artifacts: [{ artifactId: 'result', name: `${action.action ?? 'search'}-result`, parts: [{ kind: 'data', data: result as Record<string, unknown> }] }],
      },
    };
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        kind: 'task',
        id: ids.taskId,
        contextId: ids.contextId,
        status: { state: 'failed', timestamp: ids.ts, message: { role: 'agent', parts: [{ kind: 'text', text: err instanceof Error ? err.message : String(err) }] } },
      },
    };
  }
}
