/**
 * Generic live HTTP adapter — used by Fuyao / iFinD when credentials are
 * configured.
 *
 * The MCP endpoints we talk to are expected to accept a POST of
 * `{ symbol, market, T0, limit, intent }` and respond with
 * `{ items: Evidence[] }` (see docs/SPEC.md §9). This adapter:
 *   - sends the request with a per-call timeout
 *   - normalizes each item (validates publishedAt; rejects if missing or
 *     unparseable — never silently substitutes retrievedAt)
 *   - maps 5xx / timeout → transient_error
 *   - maps 4xx / schema mismatch → permanent_error
 *   - maps empty / 200-with-no-items → empty
 *   - otherwise returns success with the normalized evidence
 *
 * The HTTP transport does not log Authorization or API keys; we only surface
 * the resulting evidence list back to the agent harness.
 *
 * If a real upstream payload uses a different field name (e.g. `data`,
 * `results`, `list`), adapters should override `mapResponseBody`.
 */

import type { Evidence, McpServerKey, ToolResult } from "../../types/index.ts";
import type {
  AdapterCredentials,
  AdapterIntent,
  AdapterRequest,
  EvidenceAdapter,
  LiveAdapterOptions,
} from "./types.ts";
import {
  wrapSuccess,
  wrapEmpty,
  wrapTransientError,
  wrapPermanentError,
} from "./types.ts";

export interface LiveHttpAdapterInit {
  provider: "fuyao" | "ifind";
  serverKey: McpServerKey;
  credentials: AdapterCredentials;
  /** Map the server key + intent to a URL path on `baseUrl`. */
  pathFor: (key: string, intent: AdapterIntent) => string;
  /** Authorization header value (already computed; do NOT log). */
  buildAuthHeader?: () => string | undefined;
  /** Field name for the upstream item array (default: `items`). */
  itemsField?: string;
  /** Intents this server can answer. Defaults to all intents. */
  supportedIntents?: AdapterIntent[];
  options?: LiveAdapterOptions;
}

export class LiveHttpAdapter implements EvidenceAdapter {
  readonly serverKey: McpServerKey;
  readonly provider: "fuyao" | "ifind";
  private readonly credentials: AdapterCredentials;
  private readonly pathFor: LiveHttpAdapterInit["pathFor"];
  private readonly buildAuthHeader?: LiveHttpAdapterInit["buildAuthHeader"];
  private readonly itemsField: string;
  private readonly supportedIntents?: ReadonlySet<AdapterIntent>;
  private readonly timeoutMs: number;

  constructor(init: LiveHttpAdapterInit) {
    this.serverKey = init.serverKey;
    this.provider = init.provider;
    this.credentials = init.credentials;
    this.pathFor = init.pathFor;
    this.buildAuthHeader = init.buildAuthHeader;
    this.itemsField = init.itemsField ?? "items";
    this.supportedIntents = init.supportedIntents
      ? new Set(init.supportedIntents)
      : undefined;
    this.timeoutMs = init.options?.timeoutMs ?? 8_000;
  }

  canHandle(intent: AdapterIntent): boolean {
    if (!this.supportedIntents) return true;
    return this.supportedIntents.has(intent);
  }

  async fetch(req: AdapterRequest): Promise<ToolResult<Evidence[]>> {
    const start = Date.now();
    const retrievedAt = new Date().toISOString();
    const baseUrl = this.credentials.baseUrl;
    if (!baseUrl) {
      return wrapPermanentError(
        `${this.provider.toUpperCase()}_LIVE_NO_BASE_URL`,
        "Live adapter constructed without baseUrl; refusing to call.",
        retrievedAt,
        Date.now() - start
      );
    }
    const path = this.pathFor(this.serverKey, req.intent);
    const url = joinUrl(baseUrl, path);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      const auth = this.buildAuthHeader?.();
      if (auth) headers["authorization"] = auth;
      if (this.provider === "fuyao" && this.credentials.apiKey) {
        headers["x-api-key"] = this.credentials.apiKey;
      }

      const body = JSON.stringify({
        symbol: req.symbol,
        market: req.market ?? "CN",
        T0: req.T0,
        intent: req.intent,
        limit: req.limit ?? 5,
      });

      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      if (res.status >= 500) {
        return wrapTransientError(
          `${this.provider.toUpperCase()}_HTTP_${res.status}`,
          `Upstream ${this.provider} ${res.status} for ${this.serverKey}:${req.intent}`,
          retrievedAt,
          Date.now() - start
        );
      }
      if (res.status === 404 || res.status === 410) {
        return wrapPermanentError(
          `${this.provider.toUpperCase()}_HTTP_${res.status}`,
          `Upstream ${this.provider} ${res.status} (unsupported) for ${this.serverKey}:${req.intent}`,
          retrievedAt,
          Date.now() - start
        );
      }
      if (res.status >= 400) {
        return wrapPermanentError(
          `${this.provider.toUpperCase()}_HTTP_${res.status}`,
          `Upstream ${this.provider} ${res.status} (invalid request) for ${this.serverKey}:${req.intent}`,
          retrievedAt,
          Date.now() - start
        );
      }

      const json = (await res.json().catch(() => null)) as unknown;
      if (!json || typeof json !== "object") {
        return wrapPermanentError(
          `${this.provider.toUpperCase()}_BAD_BODY`,
          "Upstream returned non-JSON body.",
          retrievedAt,
          Date.now() - start
        );
      }
      const rawItems = (json as Record<string, unknown>)[this.itemsField];
      if (!Array.isArray(rawItems) || rawItems.length === 0) {
        return wrapEmpty(retrievedAt, Date.now() - start);
      }
      const evidence = this.normalize(rawItems, retrievedAt);
      if (evidence.length === 0) {
        return wrapEmpty(retrievedAt, Date.now() - start);
      }
      return wrapSuccess(evidence, retrievedAt, Date.now() - start);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isAbort = /abort/i.test(msg);
      return wrapTransientError(
        isAbort ? `${this.provider.toUpperCase()}_TIMEOUT` : `${this.provider.toUpperCase()}_NETWORK`,
        isAbort
          ? `Upstream ${this.provider} timed out after ${this.timeoutMs}ms`
          : `Upstream ${this.provider} network error: ${msg}`,
        retrievedAt,
        Date.now() - start
      );
    } finally {
      clearTimeout(t);
    }
  }

  private normalize(rawItems: unknown[], retrievedAt: string): Evidence[] {
    const out: Evidence[] = [];
    for (const raw of rawItems) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const publishedAt = typeof item.publishedAt === "string" ? item.publishedAt : null;
      const title = typeof item.title === "string" ? item.title : null;
      const content = typeof item.content === "string" ? item.content : null;
      if (!publishedAt || !title || !content) continue;
      const ms = Date.parse(publishedAt);
      if (Number.isNaN(ms)) continue;
      const id =
        typeof item.id === "string" && item.id
          ? item.id
          : `${this.provider}-${this.serverKey}-${ms}-${out.length}`;
      const type =
        typeof item.type === "string" && item.type
          ? (item.type as Evidence["type"])
          : inferType(this.serverKey, this.provider);
      const source =
        typeof item.source === "string" && item.source
          ? item.source
          : `${this.provider}:${this.serverKey}`;
      const sourceUrl =
        typeof item.sourceUrl === "string" && item.sourceUrl ? item.sourceUrl : undefined;
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

function joinUrl(base: string, path: string): string {
  if (path.startsWith("/")) return `${base.replace(/\/$/, "")}${path}`;
  return `${base.replace(/\/$/, "")}/${path}`;
}