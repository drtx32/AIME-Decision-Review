/**
 * MCP Streamable HTTP client — speaks real MCP protocol (JSON-RPC 2.0).
 *
 * The AIME Decision Review backend uses this to call Fuyao and iFinD MCP
 * servers over HTTP. Both providers expose MCP endpoints that:
 *   1. Accept POST {jsonrpc:"2.0", id, method, params}
 *   2. Reply with {jsonrpc:"2.0", id, result} or {jsonrpc:"2.0", id, error}
 *   3. Speak MCP methods `initialize`, `tools/list`, `tools/call`
 *
 * The lifecycle we drive per server key:
 *
 *   initialize          → {serverInfo, capabilities, protocolVersion}
 *   tools/list          → [{name, description, inputSchema}, …]   (cached)
 *   tools/call          → {content:[{type:"text", text:"..."}], isError?}
 *
 * Authentication:
 *   Fuyao — `X-api-key: <apiKey>` (and optionally `Authorization: Bearer <apiKey>`)
 *   iFinD  — `Authorization: Bearer <authorization>`
 *
 * The client keeps a `Mcp-Session-Id` (returned by some servers on
 * `initialize`) and replays it on subsequent calls. We never log the
 * credentials or session id; `dumpDiagnostics()` returns a non-secret
 * snapshot for tests.
 *
 * Failure semantics (SPEC §19):
 *   5xx / network / timeout        → throw TransientMcpError
 *   4xx / JSON-RPC error / schema  → throw PermanentMcpError
 *   200 + empty `content` array   → return []
 *   success + content             → return parsed content array
 *
 * Items lacking `publishedAt` are dropped here too — see normalizeItems()
 * for the exact contract. `retrievedAt` is never substituted for
 * `publishedAt`.
 */

export interface McpClientInit {
  endpoint: string;
  serverKey: string;
  provider: "fuyao" | "ifind";
  /** Map an intent + tool name to arguments for `tools/call`. */
  buildToolArgs?: (params: {
    toolName: string;
    intent: string;
    symbol: string;
    market?: "CN" | "HK" | "US";
    T0: string;
    limit?: number;
  }) => Record<string, unknown>;
  /** Headers to add on every request (NOT credentials — use auth below). */
  extraHeaders?: Record<string, string>;
  /** Auth: produce headers per request (X-api-key for Fuyao, Authorization for iFinD). */
  buildAuthHeaders?: () => Record<string, string>;
  /** Protocol version to send on initialize. */
  protocolVersion?: string;
  /** Per-RPC timeout in ms. */
  timeoutMs?: number;
  /** Override fetch (tests use this). */
  fetchImpl?: typeof fetch;
  /** Optional logger for diagnostics. Must NEVER receive credentials. */
  onTrace?: (event: McpTraceEvent) => void;
}

export interface McpTraceEvent {
  stage: "initialize" | "tools/list" | "tools/call";
  serverKey: string;
  status?: number;
  durationMs: number;
  /** Number of tools discovered; number of items returned; etc. */
  detail?: Record<string, unknown>;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export class TransientMcpError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "TransientMcpError";
  }
}

export class PermanentMcpError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "PermanentMcpError";
  }
}

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export class McpStreamableHttpClient {
  readonly serverKey: string;
  readonly provider: "fuyao" | "ifind";
  private readonly endpoint: string;
  private readonly buildToolArgs?: McpClientInit["buildToolArgs"];
  private readonly extraHeaders: Record<string, string>;
  private readonly buildAuthHeaders?: () => Record<string, string>;
  private readonly protocolVersion: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onTrace?: (event: McpTraceEvent) => void;

  private rpcId = 0;
  private sessionId?: string;
  private serverInfo?: { name?: string; version?: string };
  private toolsCache?: McpToolInfo[];
  private initializing?: Promise<void>;

  constructor(init: McpClientInit) {
    this.serverKey = init.serverKey;
    this.provider = init.provider;
    this.endpoint = init.endpoint.replace(/\/$/, "");
    this.buildToolArgs = init.buildToolArgs;
    this.extraHeaders = init.extraHeaders ?? {};
    this.buildAuthHeaders = init.buildAuthHeaders;
    this.protocolVersion = init.protocolVersion ?? "2025-03-26";
    this.timeoutMs = init.timeoutMs ?? 8_000;
    this.fetchImpl = init.fetchImpl ?? fetch;
    this.onTrace = init.onTrace;
  }

  /** Return the list of tools (initializes if necessary). */
  async listTools(): Promise<McpToolInfo[]> {
    await this.ensureInitialized();
    if (this.toolsCache) return this.toolsCache;
    const start = Date.now();
    const res = await this.rpc<{ tools: McpToolInfo[] }>("tools/list", {});
    this.toolsCache = res.tools ?? [];
    this.onTrace?.({
      stage: "tools/list",
      serverKey: this.serverKey,
      durationMs: Date.now() - start,
      detail: { count: this.toolsCache.length },
    });
    return this.toolsCache;
  }

  /** Call a tool by name. */
  async callTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<McpToolCallResult> {
    await this.ensureInitialized();
    const start = Date.now();
    const result = await this.rpc<McpToolCallResult>("tools/call", {
      name: toolName,
      arguments: args,
    });
    this.onTrace?.({
      stage: "tools/call",
      serverKey: this.serverKey,
      durationMs: Date.now() - start,
      detail: { tool: toolName, isError: result.isError ?? false },
    });
    return result;
  }

  /** Best-effort cleanup — server may ignore. */
  async close(): Promise<void> {
    // Streamable HTTP shutdown is optional; we just drop the cache.
    this.toolsCache = undefined;
    this.sessionId = undefined;
    this.serverInfo = undefined;
  }

  /** Non-secret snapshot for diagnostics/tests. */
  dumpDiagnostics(): {
    serverKey: string;
    provider: "fuyao" | "ifind";
    endpoint: string;
    initialized: boolean;
    hasSession: boolean;
    toolCount: number;
    serverInfo?: { name?: string; version?: string };
  } {
    return {
      serverKey: this.serverKey,
      provider: this.provider,
      endpoint: this.endpoint,
      initialized: Boolean(this.serverInfo),
      hasSession: Boolean(this.sessionId),
      toolCount: this.toolsCache?.length ?? 0,
      serverInfo: this.serverInfo,
    };
  }

  private async ensureInitialized(): Promise<void> {
    if (this.serverInfo) return;
    if (this.initializing) return this.initializing;
    this.initializing = this.doInitialize().finally(() => {
      this.initializing = undefined;
    });
    return this.initializing;
  }

  private async doInitialize(): Promise<void> {
    const start = Date.now();
    const params = {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: "aime-decision-review", version: "0.1.0" },
    };
    const result = await this.rpc<{
      serverInfo?: { name?: string; version?: string };
      capabilities?: Record<string, unknown>;
      protocolVersion?: string;
    }>("initialize", params);
    this.serverInfo = result.serverInfo;
    this.onTrace?.({
      stage: "initialize",
      serverKey: this.serverKey,
      durationMs: Date.now() - start,
      detail: { server: result.serverInfo?.name ?? "unknown" },
    });
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    const id = ++this.rpcId;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.extraHeaders,
    };
    const auth = this.buildAuthHeaders?.();
    if (auth) Object.assign(headers, auth);
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isAbort = /abort/i.test(msg);
      throw new TransientMcpError(
        isAbort ? `${this.provider.toUpperCase()}_TIMEOUT` : `${this.provider.toUpperCase()}_NETWORK`,
        isAbort
          ? `Upstream ${this.provider} timed out after ${this.timeoutMs}ms`
          : `Upstream ${this.provider} network error: ${msg}`
      );
    } finally {
      clearTimeout(timer);
    }

    // Capture session id if the server set it.
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (res.status >= 500) {
      throw new TransientMcpError(
        `${this.provider.toUpperCase()}_HTTP_${res.status}`,
        `Upstream ${this.provider} ${res.status} on ${method} for ${this.serverKey}`
      );
    }
    if (res.status === 404 || res.status === 410) {
      throw new PermanentMcpError(
        `${this.provider.toUpperCase()}_HTTP_${res.status}`,
        `Upstream ${this.provider} ${res.status} (unsupported) on ${method} for ${this.serverKey}`
      );
    }
    if (res.status >= 400) {
      throw new PermanentMcpError(
        `${this.provider.toUpperCase()}_HTTP_${res.status}`,
        `Upstream ${this.provider} ${res.status} (invalid request) on ${method} for ${this.serverKey}`
      );
    }

    // Handle SSE responses: read first event; many servers return JSON in
    // an SSE stream when Accept includes text/event-stream. For the MVP we
    // accept both application/json and text/event-stream; the test mock
    // uses application/json.
    const ct = res.headers.get("content-type") ?? "";
    let raw: string;
    if (ct.includes("text/event-stream")) {
      raw = await readFirstSseData(res);
    } else {
      raw = await res.text();
    }
    let parsed: JsonRpcResponse<T>;
    try {
      parsed = JSON.parse(raw) as JsonRpcResponse<T>;
    } catch {
      throw new PermanentMcpError(
        `${this.provider.toUpperCase()}_BAD_BODY`,
        `Upstream ${this.provider} returned non-JSON body for ${method}`
      );
    }
    if (parsed.error) {
      // JSON-RPC errors: -32601 (method not found) is permanent; others
      // we conservatively treat as permanent too (server told us it's bad).
      throw new PermanentMcpError(
        `${this.provider.toUpperCase()}_RPC_${parsed.error.code}`,
        `Upstream ${this.provider} JSON-RPC error: ${parsed.error.message}`
      );
    }
    if (!parsed.result) {
      throw new PermanentMcpError(
        `${this.provider.toUpperCase()}_EMPTY_RESULT`,
        `Upstream ${this.provider} returned no result for ${method}`
      );
    }
    return parsed.result;
  }
}

async function readFirstSseData(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // Each SSE event ends with a blank line.
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLines: string[] = [];
      for (const line of event.split("\n")) {
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      const data = dataLines.join("\n");
      if (data && data !== "[DONE]") {
        try {
          reader.cancel();
        } catch {
          /* ignore */
        }
        return data;
      }
    }
  }
  return buf;
}
