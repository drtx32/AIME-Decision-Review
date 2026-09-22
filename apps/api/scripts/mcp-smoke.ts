/**
 * MCP smoke — exercises the real MCP JSON-RPC 2.0 client against Fuyao or
 * iFinD upstream. This script replaces the older REST-shaped version because
 * the live MCP transport speaks MCP protocol, not arbitrary REST.
 *
 * Two modes (auto-detected from env):
 *   - default (no `HITHINK_FINANCE_BASE_URL` / `IFIND_MCP_BASE_URL` set):
 *     starts a Bun.serve fake MCP server that responds to
 *     initialize / tools/list / tools/call, records inbound Authorization /
 *     X-api-key headers, and returns one evidence item per call.
 *   - with real baseUrl + credential set: routes straight at the production
 *     MCP gateway using `initialize → tools/list → tools/call`. We never
 *     print the credential — only its scheme, length, and first 6 chars.
 *
 * Usage:
 *   bun run apps/api/scripts/mcp-smoke.ts                           # fake
 *   HITHINK_FINANCE_BASE_URL=https://fuyao.aicubes.cn/mcp \
 *     HITHINK_FINANCE_API_KEY=fy-... \
 *     HITHINK_FINANCE_TOOL='price:get_security_price' \
 *     bun run apps/api/scripts/mcp-smoke.ts --provider=fuyao --server=a-share
 */

import { McpStreamableHttpClient } from "../src/mcp/adapters/mcp-client.ts";

type Provider = "fuyao" | "ifind";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq < 0) continue;
    out[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return out;
}

function mask(value: string | null | undefined): {
  present: boolean;
  scheme: string | null;
  prefix: string | null;
  length: number | null;
} {
  if (!value) return { present: false, scheme: null, prefix: null, length: null };
  const trimmed = value.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const scheme = spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : null;
  const token = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1) : trimmed;
  return {
    present: true,
    scheme,
    prefix: token.length >= 6 ? token.slice(0, 6) : token,
    length: token.length,
  };
}

function emit(stage: string, ok: boolean, detail: Record<string, unknown>): void {
  console.log(JSON.stringify({ stage, ok, detail }));
}

interface StartedFakeMcp {
  url: string;
  captured: Array<{ method: string; headers: Record<string, string>; body: unknown }>;
  close: () => void;
}

/** Bun.serve fake MCP — speaks JSON-RPC 2.0 with initialize/tools/list/tools/call. */
async function startFakeMcp(provider: Provider): Promise<StartedFakeMcp> {
  const captured: StartedFakeMcp["captured"] = [];
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
        /* no body */
      }
      captured.push({ method: req.method + " " + url.pathname, headers, body });
      const id = body?.id ?? 0;
      const method = body?.method as string | undefined;
      if (method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-03-26",
              serverInfo: { name: `fake-${provider}-mcp`, version: "1.0.0" },
              capabilities: { tools: {} },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", "mcp-session-id": "fake-session" },
          }
        );
      }
      if (method === "notifications/initialized") {
        return new Response("", { status: 204 });
      }
      if (method === "tools/list") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { tools: [{ name: "smoke_tool", description: "Smoke" }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (method === "tools/call") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify([
                    {
                      id: `${provider}-fake-${Date.now()}`,
                      type: provider === "fuyao" ? "price" : "news",
                      title: `${provider} smoke evidence`,
                      content: `Fake upstream ${provider} evidence.`,
                      source: `${provider}:smoke`,
                      publishedAt: new Date().toISOString(),
                    },
                  ]),
                },
              ],
            },
          }),
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
    url: `http://localhost:${server.port}/mcp/${provider === "fuyao" ? "a-share" : "news"}`,
    captured,
    close: () => server.stop(true),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = (args.provider as Provider) ?? "fuyao";
  const serverKey = args.server ?? (provider === "fuyao" ? "a-share" : "news");
  if (provider !== "fuyao" && provider !== "ifind") {
    emit("error", false, { message: `unsupported provider ${provider}` });
    process.exit(1);
  }

  const baseUrl = provider === "fuyao" ? process.env.HITHINK_FINANCE_BASE_URL : process.env.IFIND_MCP_BASE_URL;
  const apiKey = provider === "fuyao" ? process.env.HITHINK_FINANCE_API_KEY : process.env.IFIND_MCP_AUTHORIZATION;
  const fakeKey = provider === "fuyao" ? "sk-fake-fuyao" : "Bearer sk-fake-ifind";

  let endpoint: string;
  let authHeaders: Record<string, string>;
  let mode: "fake-upstream" | "real-gateway";

  if (baseUrl && apiKey) {
    mode = "real-gateway";
    const trimmed = baseUrl.replace(/\/$/, "");
    endpoint = trimmed.endsWith(`/${serverKey}`) ? trimmed : `${trimmed}/${serverKey}`;
    authHeaders =
      provider === "fuyao"
        ? { "x-api-key": apiKey, authorization: `Bearer ${apiKey}` }
        : { authorization: apiKey };
  } else {
    mode = "fake-upstream";
    const fake = await startFakeMcp(provider);
    endpoint = fake.url;
    authHeaders =
      provider === "fuyao"
        ? { "x-api-key": fakeKey, authorization: fakeKey }
        : { authorization: fakeKey };
    // Attach fake's captured + close to module-scope for later steps
    (main as any).__fake = fake;
  }

  emit("start", true, { provider, serverKey, endpoint });
  emit("mode", true, { mode, note: mode === "real-gateway" ? "credentials set" : "credentials missing → fake upstream" });

  const client = new McpStreamableHttpClient({
    endpoint,
    serverKey,
    provider,
    buildAuthHeaders: () => authHeaders,
  });

  const startList = Date.now();
  const tools = await client.listTools();
  emit("tools.list", true, { count: tools.length, duration_ms: Date.now() - startList });

  const startCall = Date.now();
  const result = await client.callTool("smoke_tool", { symbol: "600519" });
  emit("tools.call", true, {
    duration_ms: Date.now() - startCall,
    content_parts: result.content.length,
    is_error: result.isError ?? false,
  });

  // Parse first content part as JSON and surface the first item.
  const first = result.content[0];
  let parsed: unknown = null;
  try {
    parsed = first?.text ? JSON.parse(first.text) : null;
  } catch {
    parsed = first?.text;
  }
  if (Array.isArray(parsed) && parsed.length > 0) {
    const item = parsed[0] as Record<string, unknown>;
    emit("evidence.first_item", true, {
      id: item.id,
      source: item.source,
      published_at: item.publishedAt,
      title: item.title,
    });
  }

  const diag = client.dumpDiagnostics();
  emit("diagnostics", true, diag);

  // Sanitize the captured Authorization / X-api-key headers.
  const fake = (main as any).__fake as StartedFakeMcp | undefined;
  if (fake) {
    const capturedAuth = fake.captured
      .map((c) => c.headers.authorization)
      .find((v): v is string => !!v);
    const capturedKey = fake.captured
      .map((c) => c.headers["x-api-key"])
      .find((v): v is string => !!v);
    emit("fake.upstream.headers", true, {
      request_count: fake.captured.length,
      authorization: mask(capturedAuth ?? null),
      x_api_key: mask(capturedKey ?? null),
    });
    fake.close();
  }

  await client.close();
  emit("done", true, { ts: new Date().toISOString() });
}

main().catch((e) => {
  emit("error", false, { message: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});