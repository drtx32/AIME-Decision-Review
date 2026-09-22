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
 *
 * The adapter threads the review's T0 into `normalizeItems` so that
 * `relationToDecision` is derived against T0 (not the wall clock). An
 * item whose `publishedAt` is strictly after T0 must be labelled `ex_post`
 * even when the entire review is historical; using `Date.now()` would
 * mislabel post-T0 items as `ex_ante` and break SPEC §9 (T0 hard wall).
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
      const tools = await client.listTools();
      if (!tools.some((tool) => tool.name === toolName)) {
        return wrapEmpty(retrievedAt, Date.now() - start);
      }
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
      const evidence = normalizeItems(items, retrievedAt, this.provider, this.serverKey, req.T0);
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
      continue;
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      // Some gateways (e.g. Fuyao) wrap successful payloads as
      //   { code, message, data: { item | items | data | results | [...] , timestamp } }
      // We unwrap the envelope, propagate any upstream `data.timestamp` (ms
      // epoch) as each item's `publishedAt` source so T0 hard wall remains
      // intact (the timestamp comes from upstream, not from `retrievedAt`).
      const envelope = unwrapEnvelope(obj);
      const envelopeTs = envelope ? readEnvelopeTimestamp(obj) : null;
      if (envelope) {
        for (const child of envelope) {
          if (child && typeof child === "object" && envelopeTs !== null) {
            items.push(decorateWithPublishedAt(child as Record<string, unknown>, envelopeTs));
          } else {
            items.push(child);
          }
        }
        continue;
      }
      if (Array.isArray(obj.items)) {
        for (const child of obj.items) {
          if (child && typeof child === "object" && envelopeTs !== null) {
            items.push(decorateWithPublishedAt(child as Record<string, unknown>, envelopeTs));
          } else {
            items.push(child);
          }
        }
      } else if (Array.isArray(obj.data)) {
        for (const child of obj.data) {
          if (child && typeof child === "object" && envelopeTs !== null) {
            items.push(decorateWithPublishedAt(child as Record<string, unknown>, envelopeTs));
          } else {
            items.push(child);
          }
        }
      } else if (Array.isArray(obj.results)) {
        for (const child of obj.results) {
          if (child && typeof child === "object" && envelopeTs !== null) {
            items.push(decorateWithPublishedAt(child as Record<string, unknown>, envelopeTs));
          } else {
            items.push(child);
          }
        }
      } else {
        items.push(obj);
      }
    }
  }
  return items;
}

/** Recognize a `{code, message, data: <payload>}` gateway envelope. */
function unwrapEnvelope(obj: Record<string, unknown>): unknown[] | null {
  const data = obj.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  for (const key of ["item", "items", "data", "results"]) {
    if (Array.isArray(d[key])) return d[key] as unknown[];
  }
  return null;
}

/** Read the envelope's `data.timestamp` (ms epoch) as a Number, or null. */
function readEnvelopeTimestamp(obj: Record<string, unknown>): number | null {
  const data = obj.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return readEpochMs((data as Record<string, unknown>).timestamp);
}

/** Read a numeric epoch-ms field as ms, or null if not a valid time. */
function readEpochMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    // Heuristic: > 10^12 means ms; otherwise treat as seconds.
    return v > 1e12 ? v : v * 1000;
  }
  return null;
}

/** Stamp an item with a publishedAt derived from the envelope's timestamp. */
function decorateWithPublishedAt(
  item: Record<string, unknown>,
  epochMs: number
): Record<string, unknown> {
  if (typeof item.publishedAt === "string" || typeof item.publish_time === "string") return item;
  return { ...item, publishedAt: new Date(epochMs).toISOString() };
}

/**
 * Convert upstream items to Evidence. Items without a parseable
 * `publishedAt` are dropped (we never substitute `retrievedAt`).
 */
export function normalizeItems(
  rawItems: unknown[],
  retrievedAt: string,
  provider: "fuyao" | "ifind",
  serverKey: McpServerKey,
  T0?: string
): Evidence[] {
  const t0Ms = T0 ? Date.parse(T0) : Number.NaN;
  const useT0 = T0 !== undefined && !Number.isNaN(t0Ms);
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
          : deriveTitle(item, serverKey);
    const content =
      typeof item.content === "string"
        ? item.content
        : typeof item.summary === "string"
          ? item.summary
        : typeof item.text === "string"
          ? item.text
          : deriveContent(item);
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
    // T0-aware alignment: when the upstream payload lacks an explicit
    // relationToDecision, we derive it from the decision T0, not from the
    // current wall clock. Items whose publishedAt is strictly after T0 must
    // be marked `ex_post` even when the entire review is historical. Falling
    // back to `Date.now()` would silently label a later-than-T0 historical
    // item as `ex_ante`, violating SPEC §9 (T0 hard wall).
    let relation: Evidence["relationToDecision"];
    if (
      typeof item.relationToDecision === "string" &&
      (item.relationToDecision === "ex_ante" || item.relationToDecision === "ex_post")
    ) {
      relation = item.relationToDecision;
    } else if (useT0) {
      relation = ms > t0Ms ? "ex_post" : "ex_ante";
    } else if (ms <= Date.now()) {
      relation = "ex_ante";
    } else {
      relation = "ex_post";
    }
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

/**
 * Build a deterministic Evidence `title` from upstream item fields. Only uses
 * the symbol / ticker / server key — never the URL, never the credentials.
 */
function deriveTitle(item: Record<string, unknown>, serverKey: string): string | null {
  for (const key of ["thscode", "ticker", "symbol", "code"]) {
    const v = item[key];
    if (typeof v === "string" && v.trim()) return `${serverKey} ${v.trim()}`;
  }
  return null;
}

/**
 * Build a deterministic `content` string from the upstream item's structured
 * fields. The content is a compact key=value list so a reviewer can see what
 * the upstream actually returned, without inflating the structured record
 * with every possible field.
 */
function deriveContent(item: Record<string, unknown>): string | null {
  const preferred = [
    "thscode",
    "ticker",
    "last_price",
    "open_price",
    "high_price",
    "low_price",
    "prev_price",
    "price_change",
    "price_change_ratio_pct",
    "volume",
    "turnover",
    "title",
    "headline",
    "name",
    "summary",
  ];
  const parts: string[] = [];
  for (const k of preferred) {
    const v = item[k];
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  if (parts.length === 0) {
    try {
      const s = JSON.stringify(item);
      return s.length > 400 ? s.slice(0, 400) + "…" : s;
    } catch {
      return null;
    }
  }
  return parts.join("; ");
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
