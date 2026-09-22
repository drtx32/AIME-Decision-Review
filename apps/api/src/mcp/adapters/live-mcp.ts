/**
 * Live MCP adapter — drives the McpStreamableHttpClient and converts the
 * tool-call response into Evidence[].
 *
 * The registry builds one of these per configured server key when the
 * operator has supplied credentials. The intent→tool mapping is taken from
 * the registry (which reads it from env), so we never fabricate tool names.
 *
 * Evidence shape contract (docs/SPEC.md §9):
 *   { id, type, title, content, source, sourceUrl?, publishedAt,
 *     retrievedAt, relationToDecision, confidence?, metadata? }
 *
 * Items lacking `publishedAt` are dropped silently (returned as empty). We
 * never substitute `retrievedAt` for `publishedAt` — a missing time stamp
 * means we cannot place the item around T0, so it cannot be used.
 *
 * Tool-call result parsing accepts two shapes that real MCP servers emit:
 *   1. JSON inside `content[0].text` whose value is `{ items: Evidence[] }`
 *      or just an array of evidence-like items.
 *   2. JSON content where the body itself is an array.
 *
 * If neither parses, the adapter falls back to `empty` rather than
 * fabricating items — failure to map a real upstream shape must not become
 * a fabricated evidence list.
 */

import type { Evidence, McpServerKey, ToolResult } from "../../types/index.ts";
import type {
  AdapterCredentials,
  AdapterIntent,
  AdapterRequest,
  EvidenceAdapter,
} from "./types.ts";
import {
  wrapSuccess,
  wrapEmpty,
  wrapTransientError,
  wrapPermanentError,
} from "./types.ts";
import {
  McpStreamableHttpClient,
  PermanentMcpError,
  TransientMcpError,
  type McpClientInit,
  type McpToolInfo,
} from "./mcp-client.ts";

export interface LiveMcpAdapterInit {
  provider: "fuyao" | "ifind";
  serverKey: McpServerKey;
  endpoint: string;
  credentials: AdapterCredentials;
  /** Per-intent tool name. Required for the adapter to claim canHandle. */
  toolForIntent: (intent: AdapterIntent) => string | null;
  /** Default timeout. */
  timeoutMs?: number;
  /** Override fetch (tests use this). */
  fetchImpl?: typeof fetch;
}

export class LiveMcpAdapter implements EvidenceAdapter {
  readonly serverKey: McpServerKey;
  readonly provider: "fuyao" | "ifind";
  private readonly endpoint: string;
  private readonly credentials: AdapterCredentials;
  private readonly toolForIntent: (intent: AdapterIntent) => string | null;
  private readonly timeoutMs: number;
  private readonly fetchImpl?: typeof fetch;

  private client?: McpStreamableHttpClient;

  constructor(init: LiveMcpAdapterInit) {
    this.serverKey = init.serverKey;
    this.provider = init.provider;
    this.endpoint = init.endpoint;
    this.credentials = init.credentials;
    this.toolForIntent = init.toolForIntent;
    this.timeoutMs = init.timeoutMs ?? 8_000;
    this.fetchImpl = init.fetchImpl;
  }

  canHandle(intent: AdapterIntent): boolean {
    return this.toolForIntent(intent) !== null;
  }

  async fetch(req: AdapterRequest): Promise<ToolResult<Evidence[]>> {
    const start = Date.now();
    const retrievedAt = new Date().toISOString();
    const toolName = this.toolForIntent(req.intent);
    if (!toolName) {
      return wrapEmpty(retrievedAt, Date.now() - start);
    }
    if (!this.endpoint) {
      return wrapPermanentError(
        `${this.provider.toUpperCase()}_LIVE_NO_ENDPOINT`,
        "Live MCP adapter constructed without endpoint; refusing to call.",
        retrievedAt,
        Date.now() - start
      );
    }
    try {
      const client = this.getClient();
      const result = await client.callTool(toolName, {
        symbol: req.symbol,
        market: req.market ?? "CN",
        T0: req.T0,
        limit: req.limit ?? 5,
        intent: req.intent,
      });
      if (result.isError) {
        return wrapPermanentError(
          `${this.provider.toUpperCase()}_TOOL_ERROR`,
          `Upstream tool ${toolName} reported isError=true`,
          retrievedAt,
          Date.now() - start
        );
      }
      const items = parseToolContent(result.content);
      if (items.length === 0) {
        return wrapEmpty(retrievedAt, Date.now() - start);
      }
      const evidence = normalizeItems(items, retrievedAt, this.provider, this.serverKey);
      if (evidence.length === 0) {
        return wrapEmpty(retrievedAt, Date.now() - start);
      }
      return wrapSuccess(evidence, retrievedAt, Date.now() - start);
    } catch (e) {
      if (e instanceof TransientMcpError) {
        return wrapTransientError(e.code, e.message, retrievedAt, Date.now() - start);
      }
      if (e instanceof PermanentMcpError) {
        return wrapPermanentError(e.code, e.message, retrievedAt, Date.now() - start);
      }
      return wrapPermanentError(
        `${this.provider.toUpperCase()}_UNKNOWN`,
        e instanceof Error ? e.message : String(e),
        retrievedAt,
        Date.now() - start
      );
    }
  }

  /** Lazy client construction; only built when the registry asks for it. */
  private getClient(): McpStreamableHttpClient {
    if (this.client) return this.client;
    const init: McpClientInit = {
      endpoint: this.endpoint,
      serverKey: String(this.serverKey),
      provider: this.provider,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      buildAuthHeaders: () => {
        if (this.provider === "fuyao") {
          const headers: Record<string, string> = {};
          if (this.credentials.apiKey) {
            headers["x-api-key"] = this.credentials.apiKey;
            headers["authorization"] = `Bearer ${this.credentials.apiKey}`;
          }
          return headers;
        }
        // iFinD
        if (this.credentials.authorization) {
          return { authorization: this.credentials.authorization };
        }
        return {};
      },
    };
    this.client = new McpStreamableHttpClient(init);
    return this.client;
  }

  /** Test/diagnostic hook — non-secret snapshot. */
  async dumpDiagnostics(): Promise<ReturnType<McpStreamableHttpClient["dumpDiagnostics"]>> {
    return this.getClient().dumpDiagnostics();
  }

  /** Test/diagnostic hook — explicit tool list. */
  async listTools(): Promise<McpToolInfo[]> {
    return this.getClient().listTools();
  }

  /** Test/diagnostic hook — close the underlying client. */
  async close(): Promise<void> {
    if (!this.client) return;
    await this.client.close();
    this.client = undefined;
  }
}

// ─── Parsing + normalization helpers (exported for tests) ─────────────────

/** Pull structured evidence-like items out of an MCP tool-call content array. */
export function parseToolContent(
  content: Array<{ type: string; text: string }>
): unknown[] {
  if (!Array.isArray(content) || content.length === 0) return [];
  const items: unknown[] = [];
  for (const part of content) {
    if (!part || part.type !== "text") continue;
    const text = part.text;
    if (!text) continue;
    // The server may return a JSON array, an object with `items`, or a single
    // object. Try them in order.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Treat plain text as a single unstructured item (title=content snippet,
      // content=text, publishedAt missing → will be rejected by normalize).
      items.push({ title: text.slice(0, 80), content: text });
      continue;
    }
    if (Array.isArray(parsed)) {
      items.push(...parsed);
    } else if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.items)) {
        items.push(...obj.items);
      } else if (Array.isArray(obj.data)) {
        items.push(...obj.data);
      } else if (Array.isArray(obj.results)) {
        items.push(...obj.results);
      } else {
        items.push(obj);
      }
    }
  }
  return items;
}

/**
 * Convert upstream items to Evidence. Items without a parseable
 * `publishedAt` are dropped (we never substitute `retrievedAt`).
 */
export function normalizeItems(
  rawItems: unknown[],
  retrievedAt: string,
  provider: "fuyao" | "ifind",
  serverKey: McpServerKey
): Evidence[] {
  const out: Evidence[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const publishedAt =
      typeof item.publishedAt === "string"
        ? item.publishedAt
        : typeof item.publish_time === "string"
          ? item.publish_time
          : typeof item.pub_time === "string"
            ? item.pub_time
            : typeof item.time === "string"
              ? item.time
              : null;
    const title =
      typeof item.title === "string"
        ? item.title
        : typeof item.name === "string"
          ? item.name
          : null;
    const content =
      typeof item.content === "string"
        ? item.content
        : typeof item.summary === "string"
          ? item.summary
        : typeof item.text === "string"
          ? item.text
          : title;
    if (!publishedAt || !title || !content) continue;
    const ms = Date.parse(publishedAt);
    if (Number.isNaN(ms)) continue;
    const id =
      typeof item.id === "string" && item.id
        ? item.id
        : `${provider}-${serverKey}-${ms}-${out.length}`;
    const type =
      typeof item.type === "string" && item.type
        ? (item.type as Evidence["type"])
        : inferType(String(serverKey), provider);
    const source =
      typeof item.source === "string" && item.source
        ? item.source
        : `${provider}:${serverKey}`;
    const sourceUrl =
      typeof item.sourceUrl === "string" && item.sourceUrl
        ? item.sourceUrl
        : undefined;
    const relation =
      typeof item.relationToDecision === "string" &&
      (item.relationToDecision === "ex_ante" || item.relationToDecision === "ex_post")
        ? item.relationToDecision
        : ms <= Date.now()
          ? "ex_ante"
          : "ex_post";
    const confidence =
      typeof item.confidence === "number" && item.confidence >= 0 && item.confidence <= 1
        ? item.confidence
        : undefined;
    const metadata =
      item.metadata && typeof item.metadata === "object"
        ? (item.metadata as Record<string, unknown>)
        : undefined;
    out.push({
      id,
      type,
      title,
      content,
      source,
      sourceUrl,
      publishedAt: new Date(ms).toISOString(),
      retrievedAt,
      relationToDecision: relation,
      confidence,
      metadata,
    });
  }
  return out;
}

function inferType(serverKey: string, provider: "fuyao" | "ifind"): Evidence["type"] {
  const k = serverKey.toLowerCase();
  if (k.includes("news")) return "news";
  if (k.includes("announce")) return "announcement";
  if (k.includes("fin")) return "financial";
  if (k.includes("fund")) return "fund";
  if (k.includes("future")) return "futures";
  if (k.includes("option")) return "options";
  if (k.includes("law")) return "legal";
  if (k.includes("enterprise")) return "enterprise";
  if (k.includes("index") || k.includes("industry")) return "market";
  if (k.includes("edb") || k.includes("macro") || k.includes("bond")) return "macro";
  return provider === "fuyao" ? "price" : "price";
}
