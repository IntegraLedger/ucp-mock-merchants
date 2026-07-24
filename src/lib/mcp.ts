// MCP (Model Context Protocol) — exposes a merchant as a tool server so MCP
// agents (Claude, etc.) can browse the catalog, quote, and check out. JSON-RPC
// 2.0 over HTTP (POST /:m/mcp). Same catalog + same LCP reference as every other
// rail — the legal context is surfaced in `initialize` instructions and every
// checkout result carries `lcp_reference`.

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export const MCP_TOOLS = [
  {
    name: 'search_catalog',
    description: 'List/search the merchant catalog. Optional case-insensitive substring `query` over name/sku/category.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  },
  {
    name: 'get_product',
    description: 'Get one product by sku.',
    inputSchema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
  },
  {
    name: 'quote_order',
    description: 'Price an order (shipping, tax, promo) without signing. Returns the full order totals.',
    inputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' }, variantSku: { type: 'string' }, qty: { type: 'number' } }, required: ['sku'] } },
        shippingOptionId: { type: 'string' },
        region: { type: 'string' },
        promoCode: { type: 'string' },
      },
      required: ['items'],
    },
  },
  {
    name: 'create_checkout',
    description: 'Create a signed UCP checkout (with the LCP reference welded in) for the given items. Returns checkout_jwt, checkout_hash, order_id, lcp_reference.',
    inputSchema: {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' }, variantSku: { type: 'string' }, qty: { type: 'number' } }, required: ['sku'] } } },
      required: ['items'],
    },
  },
] as const;

export interface OrderItem {
  sku: string;
  variantSku?: string;
  qty?: number;
}

export interface McpDeps {
  serverName: string;
  legalContext: { atrHash: string; terms: string };
  searchCatalog(query?: string): Promise<unknown>;
  getProduct(sku: string): Promise<unknown>;
  quoteOrder(items: OrderItem[], opts: { shippingOptionId?: string; region?: string; promoCode?: string }): Promise<unknown>;
  createCheckout(items: OrderItem[]): Promise<unknown>;
}

const ok = (id: JsonRpcResponse['id'], result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id: JsonRpcResponse['id'], code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

async function callTool(name: string, args: Record<string, unknown>, deps: McpDeps): Promise<unknown> {
  switch (name) {
    case 'search_catalog':
      return deps.searchCatalog(args.query as string | undefined);
    case 'get_product':
      if (!args.sku) throw new Error('sku is required');
      return deps.getProduct(String(args.sku));
    case 'quote_order':
      return deps.quoteOrder((args.items ?? []) as OrderItem[], { shippingOptionId: args.shippingOptionId as string, region: args.region as string, promoCode: args.promoCode as string });
    case 'create_checkout':
      return deps.createCheckout((args.items ?? []) as OrderItem[]);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/** Handle one JSON-RPC message. Returns null for notifications (no response). */
export async function handleMcp(req: JsonRpcRequest, deps: McpDeps): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  if (req.method.startsWith('notifications/')) return null; // e.g. notifications/initialized
  switch (req.method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: deps.serverName, version: '0.1.0' },
        capabilities: { tools: {} },
        instructions: `Mock UCP merchant. All purchases are governed by legal context lcp:sha256:${deps.legalContext.atrHash} (terms: ${deps.legalContext.terms}).`,
      });
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const params = req.params ?? {};
      const name = String(params.name ?? '');
      try {
        const result = await callTool(name, (params.arguments ?? {}) as Record<string, unknown>, deps);
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
      } catch (err) {
        // MCP convention: tool errors are a result with isError, not a protocol error.
        return ok(id, { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true });
      }
    }
    default:
      return rpcErr(id, -32601, `method not found: ${req.method}`);
  }
}
