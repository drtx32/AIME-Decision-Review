import type { Evidence, IFindServerKey, FuyaoServerKey, ToolResult } from "../../types/index.ts";
import type { AdapterCredentials, AdapterIntent, AdapterRequest, EvidenceAdapter } from "./types.ts";
import { wrapEmpty, wrapPermanentError, wrapSuccess, wrapTransientError } from "./types.ts";

type JsonRpc = { jsonrpc: "2.0"; id: number; result?: any; error?: { code?: number; message?: string } };
const FUYAO: Record<FuyaoServerKey, AdapterIntent[]> = { meta: ["financial"], "a-share": ["price", "financial", "announcement"], "a-share-index": ["index", "industry"], fund: ["fund"], futures: ["futures"], options: ["options"] };
const IFIND: Record<IFindServerKey, AdapterIntent[]> = { ds: [], enterprise: ["enterprise"], law: ["legal"], stock: ["price", "financial", "announcement"], fund: ["fund"], edb: ["macro"], news: ["news"], bond: ["macro"], "global-stock": ["price", "financial"], index: ["index"], futures: ["futures"] };

/** Minimal MCP Streamable HTTP client: initialize -> tools/list -> tools/call. */
export class LiveMcpAdapter implements EvidenceAdapter {
  readonly provider: "fuyao" | "ifind";
  constructor(readonly serverKey: FuyaoServerKey | IFindServerKey, private readonly credentials: AdapterCredentials) { this.provider = Object.hasOwn(FUYAO, serverKey) ? "fuyao" : "ifind"; }
  canHandle(intent: AdapterIntent) { return (this.provider === "fuyao" ? FUYAO[this.serverKey as FuyaoServerKey] : IFIND[this.serverKey as IFindServerKey]).includes(intent); }
  async fetch(req: AdapterRequest): Promise<ToolResult<Evidence[]>> {
    const started = Date.now(); const retrievedAt = new Date().toISOString();
    if (!this.credentials.baseUrl) return wrapPermanentError("MCP_ENDPOINT_MISSING", "MCP endpoint is not configured", retrievedAt);
    try {
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      if (this.credentials.apiKey) headers.authorization = `Bearer ${this.credentials.apiKey}`;
      if (this.credentials.authorization) headers.authorization = this.credentials.authorization;
      const rpc = async (method: string, params: Record<string, unknown> = {}): Promise<any> => {
        const response = await fetch(this.credentials.baseUrl!, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }) });
        if (!response.ok) throw Object.assign(new Error(`MCP HTTP ${response.status}`), { code: `MCP_HTTP_${response.status}`, retryable: response.status >= 500 });
        const text = await response.text(); const line = text.split("\n").find((item) => item.startsWith("data:"));
        const payload = JSON.parse(line ? line.slice(5).trim() : text) as JsonRpc;
        if (payload.error) throw Object.assign(new Error(payload.error.message || "MCP JSON-RPC error"), { code: `MCP_RPC_${payload.error.code ?? "ERROR"}` });
        return payload.result;
      };
      await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "aime-decision-review", version: "0.1.0" } });
      const listed = await rpc("tools/list", {}); const tools = Array.isArray(listed?.tools) ? listed.tools : [];
      let symbol = req.symbol;
      if (req.market === "CN" && !/^\d{6}$/.test(symbol)) {
        const resolver = tools.find((item: any) => /resolve|security|symbol|stock.*search/i.test(`${item.name} ${item.description || ""}`));
        if (resolver) {
          const resolved = await rpc("tools/call", { name: resolver.name, arguments: { keyword: symbol, query: symbol, market: req.market } });
          const text = JSON.stringify(resolved);
          const code = text.match(/\b[036]\d{5}\b/)?.[0];
          if (code) symbol = code;
        }
      }
      const tool = tools.find((item: any) => new RegExp(`${req.intent}|${req.intent === "price" ? "quote|market" : ""}`, "i").test(`${item.name} ${item.description || ""}`));
      if (!tool) return wrapEmpty(retrievedAt, Date.now() - started);
      const called = await rpc("tools/call", { name: tool.name, arguments: { symbol, market: req.market, executedAt: req.T0, limit: req.limit ?? 20 } });
      const rows = normalizeToolContent(called?.content ?? called?.structuredContent, this.provider, String(this.serverKey), req);
      return rows.length ? wrapSuccess(rows, retrievedAt, Date.now() - started) : wrapEmpty(retrievedAt, Date.now() - started);
    } catch (error) {
      const e = error as Error & { code?: string; retryable?: boolean };
      return e.retryable || /HTTP 5\d\d|timeout|network|fetch/i.test(e.message) ? wrapTransientError(e.code ?? "MCP_TRANSPORT", e.message, retrievedAt, Date.now() - started) : wrapPermanentError(e.code ?? "MCP_CALL_FAILED", e.message, retrievedAt, Date.now() - started);
    }
  }
}

function normalizeToolContent(content: unknown, provider: string, server: string, req: AdapterRequest): Evidence[] {
  const items = Array.isArray(content) ? content : content && typeof content === "object" && Array.isArray((content as any).items) ? (content as any).items : [content];
  return items.filter(Boolean).map((item: any, index) => {
    const text = typeof item === "string" ? item : item.text ?? item.content ?? JSON.stringify(item);
    const publishedAt = item.publishedAt ?? item.published_at ?? item.date ?? req.T0;
    return { id: `mcp-${provider}-${server}-${req.intent}-${index}-${Date.now()}`, type: req.intent === "price" ? "price" : req.intent === "news" ? "news" : req.intent === "announcement" ? "announcement" : req.intent === "index" || req.intent === "industry" ? "industry" : "financial", title: item.title ?? `${req.intent} from ${server}`, content: text, source: `${provider}:${server}`, sourceUrl: item.url ?? item.sourceUrl, publishedAt: new Date(publishedAt).toISOString(), retrievedAt: new Date().toISOString(), relationToDecision: Date.parse(publishedAt) <= Date.parse(req.T0) ? "ex_ante" : "ex_post", confidence: typeof item.confidence === "number" ? item.confidence : undefined, metadata: { liveMcp: true, tool: item.tool } } as Evidence;
  });
}
