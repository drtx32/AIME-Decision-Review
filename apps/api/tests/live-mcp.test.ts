import { afterEach, describe, expect, test } from "bun:test";
import { LiveMcpAdapter } from "../src/mcp/adapters/live-mcp.ts";

describe("Live MCP adapter contract", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  function adapterWith(responseItems: unknown[], capture?: (init?: RequestInit) => void) {
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      capture?.(init);
      const body = JSON.parse(String(init?.body)) as { method: string };
      const result = body.method === "tools/list"
        ? { tools: [{ name: "a_share_price", description: "price quote" }] }
        : body.method === "tools/call"
          ? { content: [{ type: "text", text: JSON.stringify(responseItems) }] }
          : { protocolVersion: "2025-03-26", serverInfo: { name: "test" } };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    }) as typeof fetch;
    return new LiveMcpAdapter({
      provider: "fuyao",
      serverKey: "a-share",
      endpoint: "https://mcp.example.test/a-share",
      credentials: { baseUrl: "https://mcp.example.test", apiKey: "secret" },
      toolForIntent: (intent) => intent === "price" ? "a_share_price" : null,
      fetchImpl: globalThis.fetch,
    });
  }

  test("uses initialize, tools/list, and tools/call over JSON-RPC", async () => {
    const methods: string[] = [];
    const adapter = adapterWith([{ title: "T0 前价格", text: "100.2", publishedAt: "2025-03-17T00:00:00Z" }], (init) => {
      methods.push((JSON.parse(String(init?.body)) as { method: string }).method);
    });
    const result = await adapter.fetch({ intent: "price", symbol: "600519", market: "CN", T0: "2025-03-18T00:00:00Z" });
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    expect(result.status).toBe("success");
    expect(result.data?.[0].source).toBe("fuyao:a-share");
    expect(result.data?.[0].relationToDecision).toBe("ex_ante");
  });

  test("uses Fuyao X-api-key and rejects timestamp-less evidence", async () => {
    let receivedHeaders: RequestInit["headers"];
    const adapter = adapterWith([{ title: "无时间戳", content: "100.2" }], (init) => { receivedHeaders = init?.headers; });
    const result = await adapter.fetch({ intent: "price", symbol: "600519", market: "CN", T0: "2025-03-18T00:00:00Z" });
    expect(result.status).toBe("empty");
    expect(new Headers(receivedHeaders).get("X-api-key")).toBe("secret");
    expect(new Headers(receivedHeaders).get("Authorization")).toBe("Bearer secret");
  });

  test("uses the upstream snapshot timestamp for price evidence only", async () => {
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      const result = body.method === "tools/list"
        ? { tools: [{ name: "a_share_price", description: "price quote" }] }
        : body.method === "tools/call"
          ? { content: [{ type: "text", text: JSON.stringify({ code: 0, data: { timestamp: 1742256000000, items: [{ title: "快照", content: "100" }] } }) }] }
          : { protocolVersion: "2025-03-26" };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    }) as typeof fetch;
    const adapter = new LiveMcpAdapter({ provider: "fuyao", serverKey: "a-share", endpoint: "https://mcp.example.test/a-share", credentials: { apiKey: "secret" }, toolForIntent: () => "a_share_price", fetchImpl: globalThis.fetch });
    const result = await adapter.fetch({ intent: "price", symbol: "600519", market: "CN", T0: "2025-03-17T00:00:00Z" });
    expect(result.status).toBe("success");
    expect(result.data?.[0].publishedAt).toBe("2025-03-18T00:00:00.000Z");
    expect(result.data?.[0].relationToDecision).toBe("ex_post");
  });

  test("passes historical T0 to the configured price tool and preserves its timestamp", async () => {
    let callArgs: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params?: { arguments?: Record<string, unknown> } };
      const result = body.method === "tools/list"
        ? { tools: [{ name: "historical_prices" }] }
        : body.method === "tools/call"
          ? (() => {
              callArgs = body.params?.arguments;
              return { content: [{ type: "text", text: JSON.stringify({ items: [{ title: "历史价", content: "90", publishedAt: "2024-03-14T00:00:00Z" }] }) }] };
            })()
          : { protocolVersion: "2025-03-26" };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    }) as typeof fetch;
    const adapter = new LiveMcpAdapter({
      provider: "fuyao",
      serverKey: "a-share",
      endpoint: "https://mcp.example.test/a-share",
      credentials: { apiKey: "secret" },
      toolForIntent: (intent) => intent === "price" ? "historical_prices" : null,
      fetchImpl: globalThis.fetch,
    });
    const result = await adapter.fetch({ intent: "price", symbol: "600519", market: "CN", T0: "2024-03-15T00:00:00Z" });
    expect((callArgs as { T0?: unknown } | undefined)?.T0).toBe("2024-03-15T00:00:00Z");
    expect(result.status).toBe("success");
    expect(result.data?.[0].publishedAt).toBe("2024-03-14T00:00:00.000Z");
    expect(result.data?.[0].relationToDecision).toBe("ex_ante");
  });

  test("does not fabricate news publication time from an envelope snapshot timestamp", async () => {
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      const result = body.method === "tools/list"
        ? { tools: [{ name: "get_news" }] }
        : body.method === "tools/call"
          ? { content: [{ type: "text", text: JSON.stringify({ code: 0, data: { timestamp: 1742256000000, items: [{ title: "新闻", content: "事件" }] } }) }] }
          : { protocolVersion: "2025-03-26" };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    }) as typeof fetch;
    const adapter = new LiveMcpAdapter({
      provider: "fuyao",
      serverKey: "a-share",
      endpoint: "https://mcp.example.test/a-share",
      credentials: { apiKey: "secret" },
      toolForIntent: (intent) => intent === "news" ? "get_news" : null,
      fetchImpl: globalThis.fetch,
    });
    const result = await adapter.fetch({ intent: "news", symbol: "600519", market: "CN", T0: "2025-03-17T00:00:00Z" });
    expect(result.status).toBe("empty");
  });
});
