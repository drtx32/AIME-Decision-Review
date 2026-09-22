/**
 * Integration tests for the live MCP transport.
 *
 * These tests mock a real MCP server (JSON-RPC 2.0 over Streamable HTTP)
 * using Bun.serve, then exercise McpStreamableHttpClient and LiveMcpAdapter
 * end-to-end. They prove:
 *
 *   - The client performs the real MCP protocol:
 *       initialize → tools/list → tools/call.
 *   - Tools/list is cached after the first call (lazy load — no schema dump).
 *   - Tool-call result `content[]` is parsed to Evidence[].
 *   - Items lacking `publishedAt` are dropped (never substituted with
 *     `retrievedAt`).
 *   - 5xx → TransientMcpError / transient_error result.
 *   - 4xx → PermanentMcpError / permanent_error result.
 *   - JSON-RPC error → permanent_error.
 *   - Timeout (server stalls) → transient_error.
 *   - Authorization / X-api-key headers are forwarded on every call.
 *   - Credentials are never echoed in thrown error messages.
 *
 * They also exercise the registry wiring:
 *   - With credentials but no tool map → no LiveMcpAdapter (we don't fabricate).
 *   - With credentials + tool map → LiveMcpAdapter drives the real protocol.
 *   - T18 vertical slice: real Fuyao + real iFinD side-by-side via JSON-RPC.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { McpStreamableHttpClient } from "../src/mcp/adapters/mcp-client.ts";
import { LiveMcpAdapter, parseToolContent, normalizeItems } from "../src/mcp/adapters/live-mcp.ts";
import { buildMcpRegistry } from "../src/mcp/registry.ts";
import { makeTestConfig } from "./helpers.ts";

// ─── MCP mock helper ────────────────────────────────────────────────────────

type RpcHandler = (req: { method: string; params: unknown }) => unknown;

interface FakeMcpOptions {
  /** Override tool-list response (defaults to a single `get_price` tool). */
  toolsList?: Array<{ name: string; description?: string }>;
  /** Override tool-call handler. */
  onToolCall?: RpcHandler;
  /** Force a specific HTTP status on a given method. */
  forceStatus?: { method?: string; status: number };
  /** Force a JSON-RPC error for a given method. */
  forceRpcError?: { method?: string; code: number; message: string };
  /** Capture all inbound requests (for assertion). */
  onRequest?: (info: { method: string; headers: Record<string, string>; body: unknown }) => void;
  /** Hold the response open (used for timeout tests). */
  stall?: boolean;
}

async function startFakeMcpServer(opts: FakeMcpOptions = {}): Promise<{
  url: string;
  captured: Array<{ method: string; headers: Record<string, string>; body: unknown }>;
  close: () => void;
}> {
  const captured: Array<{ method: string; headers: Record<string, string>; body: unknown }> = [];
  const initialTools = opts.toolsList ?? [{ name: "get_price", description: "Get price" }];

  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      let body: any = null;
      try {
        body = await req.json();
      } catch {
        /* empty body */
      }
      captured.push({ method: req.method + " " + url.pathname, headers, body });
      if (opts.stall) {
        return new Promise<Response>(() => {});
      }
      const rpc = body as { method: string; params?: unknown; id?: number | string };
      const id = rpc?.id ?? 0;

      if (opts.forceStatus) {
        return new Response(JSON.stringify({ error: "forced" }), { status: opts.forceStatus.status });
      }
      if (opts.forceRpcError && (!opts.forceRpcError.method || opts.forceRpcError.method === rpc?.method)) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: opts.forceRpcError.code, message: opts.forceRpcError.message },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (rpc?.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-03-26",
              serverInfo: { name: "fake-mcp", version: "1.0.0" },
              capabilities: { tools: {} },
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "fake-session-123",
            },
          }
        );
      }
      if (rpc?.method === "notifications/initialized") {
        return new Response("", { status: 204 });
      }
      if (rpc?.method === "tools/list") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { tools: initialTools },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (rpc?.method === "tools/call") {
        const handler = opts.onToolCall ?? (() => ({ content: [] }));
        const result = handler({ method: rpc.method, params: rpc.params });
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id, result }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  });

  return {
    url: `http://localhost:${server.port}/mcp`,
    captured,
    close: () => server.stop(true),
  };
}

function fuyaoAuthHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    authorization: `Bearer ${apiKey}`,
  };
}

function ifindAuthHeaders(auth: string): Record<string, string> {
  return { authorization: auth };
}

// ─── Client-level tests ─────────────────────────────────────────────────────

describe("McpStreamableHttpClient — real MCP protocol", () => {
  test("initialize → tools/list → tools/call round-trip", async () => {
    const fake = await startFakeMcpServer({
      toolsList: [
        { name: "get_price" },
        { name: "get_news" },
      ],
      onToolCall: () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify([
              {
                id: "x1",
                type: "price",
                title: "A-share close, pre-T0",
                content: "Closing price 30 days before T0: 1620.50 (CN).",
                source: "fuyao:a-share:price",
                publishedAt: "2024-03-14T00:00:00Z",
                metadata: { field: "close" },
              },
            ]),
          },
        ],
      }),
    });
    const client = new McpStreamableHttpClient({
      endpoint: fake.url,
      serverKey: "a-share",
      provider: "fuyao",
      buildAuthHeaders: () => fuyaoAuthHeaders("test-key"),
    });
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["get_price", "get_news"]);
    const result = await client.callTool("get_price", { symbol: "600519" });
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)[0].id).toBe("x1");
    const diag = client.dumpDiagnostics();
    expect(diag.initialized).toBe(true);
    expect(diag.hasSession).toBe(true);
    expect(diag.toolCount).toBe(2);
    expect(diag.serverInfo?.name).toBe("fake-mcp");
    await client.close();
    fake.close();
  });

  test("Authorization + X-api-key headers forwarded on every call", async () => {
    const fake = await startFakeMcpServer();
    const client = new McpStreamableHttpClient({
      endpoint: fake.url,
      serverKey: "a-share",
      provider: "fuyao",
      buildAuthHeaders: () => fuyaoAuthHeaders("test-key-secret"),
    });
    await client.listTools();
    await client.callTool("get_price", { symbol: "600519" });
    const authHeaders = fake.captured
      .map((c) => c.headers.authorization)
      .filter((v): v is string => !!v);
    const apiKeyHeaders = fake.captured
      .map((c) => c.headers["x-api-key"])
      .filter((v): v is string => !!v);
    expect(authHeaders.length).toBeGreaterThan(0);
    expect(authHeaders.every((h) => h === "Bearer test-key-secret")).toBe(true);
    expect(apiKeyHeaders.every((h) => h === "test-key-secret")).toBe(true);
    await client.close();
    fake.close();
  });

  test("Authorization header forwarded for iFinD", async () => {
    const fake = await startFakeMcpServer();
    const client = new McpStreamableHttpClient({
      endpoint: fake.url,
      serverKey: "news",
      provider: "ifind",
      buildAuthHeaders: () => ifindAuthHeaders("Bearer ifind-token-xyz"),
    });
    await client.listTools();
    await client.callTool("get_news", { symbol: "600519" });
    const authHeaders = fake.captured
      .map((c) => c.headers.authorization)
      .filter((v): v is string => !!v);
    expect(authHeaders.every((h) => h === "Bearer ifind-token-xyz")).toBe(true);
    expect(fake.captured.every((c) => c.headers["x-api-key"] === undefined)).toBe(true);
    await client.close();
    fake.close();
  });

  test("5xx → TransientMcpError; no api key in message", async () => {
    const fake = await startFakeMcpServer({ forceStatus: { status: 503 } });
    const client = new McpStreamableHttpClient({
      endpoint: fake.url,
      serverKey: "a-share",
      provider: "fuyao",
      buildAuthHeaders: () => fuyaoAuthHeaders("test-key-secret"),
    });
    let err: Error | null = null;
    try {
      await client.listTools();
    } catch (e) {
      err = e as Error;
    }
    fake.close();
    expect(err).not.toBeNull();
    expect(err!.name).toBe("TransientMcpError");
    expect((err as any).code).toContain("503");
    expect(err!.message).not.toContain("test-key-secret");
    expect(err!.message).not.toContain("Bearer");
  });

  test("404 → PermanentMcpError", async () => {
    const fake = await startFakeMcpServer({ forceStatus: { status: 404 } });
    const client = new McpStreamableHttpClient({
      endpoint: fake.url,
      serverKey: "missing",
      provider: "fuyao",
      buildAuthHeaders: () => fuyaoAuthHeaders("test"),
    });
    let err: Error | null = null;
    try {
      await client.listTools();
    } catch (e) {
      err = e as Error;
    }
    fake.close();
    expect(err?.name).toBe("PermanentMcpError");
    expect((err as any).code).toContain("404");
  });

  test("JSON-RPC error → PermanentMcpError", async () => {
    const fake = await startFakeMcpServer({
      forceRpcError: { method: "tools/call", code: -32601, message: "no such tool" },
    });
    const client = new McpStreamableHttpClient({
      endpoint: fake.url,
      serverKey: "a-share",
      provider: "fuyao",
      buildAuthHeaders: () => fuyaoAuthHeaders("test"),
    });
    let err: Error | null = null;
    try {
      await client.callTool("nonexistent", {});
    } catch (e) {
      err = e as Error;
    }
    fake.close();
    expect(err?.name).toBe("PermanentMcpError");
    expect((err as any).code).toContain("32601");
  });

  test("server stalls → timeout → TransientMcpError", async () => {
    const fake = await startFakeMcpServer({ stall: true });
    const client = new McpStreamableHttpClient({
      endpoint: fake.url,
      serverKey: "a-share",
      provider: "fuyao",
      timeoutMs: 200,
      buildAuthHeaders: () => fuyaoAuthHeaders("test"),
    });
    let err: Error | null = null;
    try {
      await client.listTools();
    } catch (e) {
      err = e as Error;
    }
    fake.close();
    expect(err?.name).toBe("TransientMcpError");
    expect((err as any).code).toContain("TIMEOUT");
  });
});

// ─── Adapter-level tests ────────────────────────────────────────────────────

describe("LiveMcpAdapter — registry-driven intent → tool", () => {
  test("success: tools/call returns Evidence[] with real publishedAt", async () => {
    const fake = await startFakeMcpServer({
      onToolCall: () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify([
              {
                id: "real-fuyao-1",
                type: "price",
                title: "Fuyao live close",
                content: "Real upstream Fuyao returned 1620.50.",
                source: "fuyao:a-share:price",
                publishedAt: "2024-03-14T00:00:00Z",
              },
            ]),
          },
        ],
      }),
    });
    const adapter = new LiveMcpAdapter({
      provider: "fuyao",
      serverKey: "a-share",
      endpoint: fake.url,
      credentials: { baseUrl: fake.url, apiKey: "test-key" },
      toolForIntent: (intent) => (intent === "price" ? "get_price" : null),
    });
    const res = await adapter.fetch({
      intent: "price",
      symbol: "600519",
      market: "CN",
      T0: "2024-03-15T00:00:00Z",
    });
    fake.close();
    expect(res.status).toBe("success");
    expect(res.data).toHaveLength(1);
    expect(res.data![0].source).toBe("fuyao:a-share:price");
    expect(res.data![0].publishedAt).toBe("2024-03-14T00:00:00.000Z");
  });

  test("missing publishedAt → empty (rejected, never fabricated)", async () => {
    const fake = await startFakeMcpServer({
      onToolCall: () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify([
              { id: "x", type: "price", title: "no timestamp", content: "should be rejected" },
            ]),
          },
        ],
      }),
    });
    const adapter = new LiveMcpAdapter({
      provider: "fuyao",
      serverKey: "a-share",
      endpoint: fake.url,
      credentials: { baseUrl: fake.url, apiKey: "test" },
      toolForIntent: () => "get_price",
    });
    const res = await adapter.fetch({
      intent: "price",
      symbol: "600519",
      T0: "2024-03-15T00:00:00Z",
    });
    fake.close();
    expect(res.status).toBe("empty");
  });

  test("canHandle returns false when no tool is configured for the intent", () => {
    const adapter = new LiveMcpAdapter({
      provider: "fuyao",
      serverKey: "a-share",
      endpoint: "http://localhost:0/mcp",
      credentials: {},
      toolForIntent: () => null,
    });
    expect(adapter.canHandle("price")).toBe(false);
    expect(adapter.canHandle("news")).toBe(false);
  });

  test("upstream isError=true → permanent_error", async () => {
    const fake = await startFakeMcpServer({
      onToolCall: () => ({ content: [], isError: true }),
    });
    const adapter = new LiveMcpAdapter({
      provider: "fuyao",
      serverKey: "a-share",
      endpoint: fake.url,
      credentials: { baseUrl: fake.url, apiKey: "test" },
      toolForIntent: () => "get_price",
    });
    const res = await adapter.fetch({
      intent: "price",
      symbol: "600519",
      T0: "2024-03-15T00:00:00Z",
    });
    fake.close();
    expect(res.status).toBe("permanent_error");
    expect(res.error?.code).toContain("TOOL_ERROR");
  });

  test("plain-text tool content (non-JSON) → not fabricated; dropped", () => {
    const out = parseToolContent([
      { type: "text", text: "just a plain string, no JSON" },
    ]);
    expect(out).toHaveLength(1);
    const norm = normalizeItems(out, "2024-03-15T00:00:00.000Z", "fuyao", "a-share");
    expect(norm).toHaveLength(0); // dropped because publishedAt missing
  });

  test("parseToolContent accepts items / data / results / array / single object", () => {
    expect(parseToolContent([{ type: "text", text: JSON.stringify([{ a: 1 }]) }])).toEqual([{ a: 1 }]);
    expect(parseToolContent([{ type: "text", text: JSON.stringify({ items: [{ a: 1 }, { a: 2 }] }) }])).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseToolContent([{ type: "text", text: JSON.stringify({ data: [{ a: 1 }] }) }])).toEqual([{ a: 1 }]);
    expect(parseToolContent([{ type: "text", text: JSON.stringify({ results: [{ a: 1 }] }) }])).toEqual([{ a: 1 }]);
    expect(parseToolContent([{ type: "text", text: JSON.stringify({ a: 1 }) }])).toEqual([{ a: 1 }]);
  });

  test("parseToolContent unwraps {code,message,data:{item,timestamp}} gateway envelope and stamps per-item publishedAt from envelope", () => {
    // Real Fuyao `a-share` price-snapshot response shape.
    const text = JSON.stringify({
      code: 0,
      message: "success",
      request_id: "abc-123",
      data: {
        timestamp: 1790091665000,
        total: 2,
        item: [
          { thscode: "600519.SH", ticker: "600519", last_price: 1253.8, volume: 2457294 },
          { thscode: "000001.SZ", ticker: "000001", last_price: 11.71, volume: 75945732 },
        ],
      },
    });
    const out = parseToolContent([{ type: "text", text }]);
    expect(out).toHaveLength(2);
    // Each child should carry a publishedAt derived from the envelope timestamp.
    expect((out[0] as Record<string, unknown>).publishedAt).toBe(new Date(1790091665000).toISOString());
    expect((out[1] as Record<string, unknown>).publishedAt).toBe(new Date(1790091665000).toISOString());
  });

  test("normalizeItems: derives title + content from upstream fields when missing (Fuyao price-snapshot shape)", () => {
    const norm = normalizeItems(
      [
        {
          thscode: "600519.SH",
          ticker: "600519",
          last_price: 1253.8,
          open_price: 1252.15,
          high_price: 1265.88,
          low_price: 1248.1,
          prev_price: 1252.57,
          volume: 2457294,
          turnover: 3088526100,
          publishedAt: "2026-09-22T07:41:05.000Z",
        },
      ],
      "2026-09-22T15:40:52.049Z",
      "fuyao",
      "a-share"
    );
    expect(norm).toHaveLength(1);
    expect(norm[0].title).toBe("a-share 600519.SH");
    expect(norm[0].content).toMatch(/thscode=600519\.SH/);
    expect(norm[0].content).toMatch(/last_price=1253\.8/);
    expect(norm[0].source).toBe("fuyao:a-share");
  });

  test("normalizeItems: alternate timestamp fields + missing fields", () => {
    const norm = normalizeItems(
      [
        { title: "x", content: "y", publish_time: "2024-03-14T00:00:00Z" },
        { title: "x", content: "y", pub_time: "2024-03-14T00:00:00Z" },
        { title: "x", content: "y", time: "2024-03-14T00:00:00Z" },
        { title: "x", content: "y", publishedAt: "not-a-date" }, // rejected
        { title: "x", content: "y", publishedAt: "2024-03-14T00:00:00Z" }, // accepted
      ],
      "2024-03-15T00:00:00.000Z",
      "fuyao",
      "a-share"
    );
    expect(norm).toHaveLength(4);
    expect(norm.every((e) => e.publishedAt === "2024-03-14T00:00:00.000Z")).toBe(true);
  });

  // Regression: a historical review with T0 in the past used to mislabel
  // items published *after* T0 as `ex_ante` because the fallback rule was
  // `publishedAt <= Date.now()`. SPEC §9 requires `ex_post` for any item
  // whose `publishedAt` is strictly after T0. Threading T0 into normalize
  // must flip the label even though the wall clock is well past everything.
  test("normalizeItems: T0-aware — post-T0 historical item is saved as ex_post", () => {
    const norm = normalizeItems(
      [
        {
          title: "post-T0 close",
          content: "Closing print after the decision.",
          source: "fuyao:a-share",
          publishedAt: "2024-03-16T00:00:00Z", // after T0
        },
        {
          title: "pre-T0 close",
          content: "Closing print before the decision.",
          source: "fuyao:a-share",
          publishedAt: "2024-03-14T00:00:00Z", // before T0
        },
      ],
      "2026-09-22T15:00:00.000Z", // far future retrievedAt — irrelevant to label
      "fuyao",
      "a-share",
      "2024-03-15T00:00:00Z" // T0
    );
    expect(norm).toHaveLength(2);
    const byTitle = Object.fromEntries(norm.map((e) => [e.title, e]));
    expect(byTitle["post-T0 close"].relationToDecision).toBe("ex_post");
    expect(byTitle["pre-T0 close"].relationToDecision).toBe("ex_ante");
  });

  // Regression: explicit upstream `relationToDecision` must still win.
  test("normalizeItems: explicit relationToDecision from upstream overrides T0 fallback", () => {
    const norm = normalizeItems(
      [
        {
          title: "post-T0 but upstream marked ex_ante",
          content: "Upstream annotation.",
          source: "fuyao:a-share",
          publishedAt: "2024-03-16T00:00:00Z",
          relationToDecision: "ex_ante",
        },
      ],
      "2026-09-22T15:00:00.000Z",
      "fuyao",
      "a-share",
      "2024-03-15T00:00:00Z"
    );
    expect(norm[0].relationToDecision).toBe("ex_ante");
  });

  test("LiveMcpAdapter.fetch: persisted item with publishedAt > T0 is ex_post", async () => {
    // Save and restore Date.now so the T0-relative label is forced.
    const realNow = Date.now;
    Date.now = () => Date.parse("2026-09-22T15:00:00.000Z");
    try {
      const fake = await startFakeMcpServer({
        onToolCall: () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify([
                {
                  id: "real-fuyao-post-T0",
                  type: "price",
                  title: "Post-T0 print",
                  content: "Closing print after the historical decision.",
                  source: "fuyao:a-share:price",
                  publishedAt: "2024-03-16T00:00:00Z", // post-T0
                },
              ]),
            },
          ],
        }),
      });
      const adapter = new LiveMcpAdapter({
        provider: "fuyao",
        serverKey: "a-share",
        endpoint: fake.url,
        credentials: { baseUrl: fake.url, apiKey: "test-key" },
        toolForIntent: (intent) => (intent === "price" ? "get_price" : null),
      });
      const res = await adapter.fetch({
        intent: "price",
        symbol: "600519",
        market: "CN",
        T0: "2024-03-15T00:00:00Z",
      });
      fake.close();
      expect(res.status).toBe("success");
      expect(res.data).toHaveLength(1);
      expect(res.data![0].relationToDecision).toBe("ex_post");
      expect(res.data![0].publishedAt).toBe("2024-03-16T00:00:00.000Z");
    } finally {
      Date.now = realNow;
    }
  });
});

// ─── Registry wiring ────────────────────────────────────────────────────────

describe("MCP registry — credentials + toolMap wire LiveMcpAdapter", () => {
  test("credentials configured but toolMap empty → live adapter exists but canHandle is false everywhere", () => {
    const cfg = makeTestConfig({
      fuyao: {
        baseUrl: "http://example.test/fuyao",
        apiKey: "test-key",
        servers: ["a-share"],
        toolMap: {},
      },
    });
    const registry = buildMcpRegistry(cfg);
    const adapter = registry.resolve("a-share");
    expect(adapter).not.toBeNull();
    expect(adapter!.provider).toBe("fuyao");
    expect(adapter!.canHandle("price")).toBe(false);
  });

  test("credentials + toolMap → canHandle for configured intent", () => {
    const cfg = makeTestConfig({
      fuyao: {
        baseUrl: "http://example.test/fuyao",
        apiKey: "test-key",
        servers: ["a-share"],
        toolMap: { price: "get_a_share_price" },
      },
    });
    const registry = buildMcpRegistry(cfg);
    const adapter = registry.resolve("a-share")!;
    expect(adapter.canHandle("price")).toBe(true);
    expect(adapter.canHandle("news")).toBe(false);
  });

  test("no credentials → mock adapter still selected", () => {
    const cfg = makeTestConfig({
      fuyao: { baseUrl: null, apiKey: null, servers: ["a-share"], toolMap: {} },
    });
    const registry = buildMcpRegistry(cfg);
    const adapter = registry.resolve("a-share")!;
    // Mock adapter is intent-scoped.
    expect(adapter.canHandle("price")).toBe(true);
    expect(adapter.canHandle("news")).toBe(false);
  });

  test("T18 vertical: real Fuyao + real iFinD via JSON-RPC side by side", async () => {
    const fuyaoFake = await startFakeMcpServer({
      toolsList: [{ name: "get_a_share_price" }],
      onToolCall: () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify([
              {
                id: "fuyao-real-1",
                type: "price",
                title: "Fuyao live price",
                content: "Real upstream Fuyao returned 1620.50.",
                source: "fuyao:a-share:price",
                publishedAt: "2024-03-14T00:00:00Z",
              },
            ]),
          },
        ],
      }),
    });
    const ifindFake = await startFakeMcpServer({
      toolsList: [{ name: "get_news" }],
      onToolCall: () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify([
              {
                id: "ifind-real-1",
                type: "news",
                title: "iFinD live news",
                content: "Real upstream iFinD returned sector news.",
                source: "ifind:news:sector",
                publishedAt: "2024-03-10T00:00:00Z",
              },
            ]),
          },
        ],
      }),
    });

    const cfg = makeTestConfig({
      fuyao: {
        baseUrl: fuyaoFake.url,
        apiKey: "test-key",
        servers: ["a-share"],
        toolMap: { price: "get_a_share_price" },
      },
      ifind: {
        baseUrl: ifindFake.url,
        authorization: "Bearer ifind-token",
        servers: ["news"],
        toolMap: { news: "get_news" },
      },
    });
    const registry = buildMcpRegistry(cfg);
    const priceAdapters = registry.resolveFor("price");
    const newsAdapters = registry.resolveFor("news");

    expect(priceAdapters.length).toBe(1);
    expect(newsAdapters.length).toBe(1);

    const fuyaoRes = await priceAdapters[0].fetch({
      intent: "price",
      symbol: "600519",
      market: "CN",
      T0: "2024-03-15T00:00:00Z",
    });
    const ifindRes = await newsAdapters[0].fetch({
      intent: "news",
      symbol: "600519",
      T0: "2024-03-15T00:00:00Z",
    });

    fuyaoFake.close();
    ifindFake.close();

    expect(fuyaoRes.status).toBe("success");
    expect(fuyaoRes.data![0].source).toBe("fuyao:a-share:price");
    expect(ifindRes.status).toBe("success");
    expect(ifindRes.data![0].source).toBe("ifind:news:sector");

    // T18 proof: real MCP protocol exchange happened. Each adapter
    // exercised initialize + tools/list + tools/call on its endpoint.
    expect(fuyaoFake.captured.some((c) => c.body && (c.body as any).method === "initialize")).toBe(true);
    expect(fuyaoFake.captured.some((c) => c.body && (c.body as any).method === "tools/call")).toBe(true);
    expect(ifindFake.captured.some((c) => c.body && (c.body as any).method === "initialize")).toBe(true);
    expect(ifindFake.captured.some((c) => c.body && (c.body as any).method === "tools/call")).toBe(true);
  });
});
