import { afterEach, describe, expect, test } from "bun:test";
import { LiveMcpAdapter } from "../src/mcp/adapters/live-mcp.ts";

describe("Live MCP adapter contract", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("uses initialize, tools/list, and tools/call over JSON-RPC", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      methods.push(body.method);
      const result = body.method === "tools/list" ? { tools: [{ name: "a_share_price", description: "price quote" }] } : body.method === "tools/call" ? { content: [{ title: "T0 前价格", text: "100.2", publishedAt: "2025-03-17T00:00:00Z" }] } : { protocolVersion: "2025-03-26" };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const adapter = new LiveMcpAdapter("a-share", { baseUrl: "https://mcp.example.test", apiKey: "secret" });
    const result = await adapter.fetch({ intent: "price", symbol: "600519", market: "CN", T0: "2025-03-18T00:00:00Z" });
    expect(methods).toEqual(["initialize", "tools/list", "tools/call"]);
    expect(result.status).toBe("success");
    expect(result.data?.[0].source).toBe("fuyao:a-share");
    expect(result.data?.[0].relationToDecision).toBe("ex_ante");
  });
});
