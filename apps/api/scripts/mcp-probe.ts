/**
 * Real-gateway MCP probe: discover tools, call the chosen one, print a
 * redacted summary of the result content. NEVER prints credentials.
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

function maskHeader(_v: string | null): { present: boolean } {
  // Security: NEVER expose credential metadata (length, prefix, scheme). The
  // trigger contract for ELI-318 forbids any of those. Only "was a header
  // sent?" is observable; values are withheld entirely.
  return { present: !!_v };
}

function emit(stage: string, ok: boolean, detail: Record<string, unknown>): void {
  console.log(JSON.stringify({ stage, ok, detail }));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = (args.provider as Provider) ?? "fuyao";
  const serverKey = args.server ?? (provider === "fuyao" ? "a-share" : "news");
  const toolName = args.tool;
  const callArgs = args.args ? (JSON.parse(args.args) as Record<string, unknown>) : {};

  const baseUrl = provider === "fuyao" ? process.env.HITHINK_FINANCE_BASE_URL : process.env.IFIND_MCP_BASE_URL;
  const cred = provider === "fuyao" ? process.env.HITHINK_FINANCE_API_KEY : process.env.IFIND_MCP_AUTHORIZATION;
  if (!baseUrl || !cred) {
    emit("error", false, { message: "missing baseUrl or credential" });
    process.exit(1);
  }
  const endpoint = baseUrl.replace(/\/$/, "").endsWith(`/${serverKey}`)
    ? baseUrl.replace(/\/$/, "")
    : `${baseUrl.replace(/\/$/, "")}/${serverKey}`;
  const authHeaders = provider === "fuyao"
    ? { "x-api-key": cred, authorization: `Bearer ${cred}` }
    : { authorization: cred };

  emit("start", true, { provider, serverKey, endpoint, header: { authorization: maskHeader(authHeaders.authorization ?? null), x_api_key: maskHeader(authHeaders["x-api-key"] ?? null) } });

  const client = new McpStreamableHttpClient({ endpoint, serverKey, provider, buildAuthHeaders: () => authHeaders });

  const startList = Date.now();
  const tools = await client.listTools();
  emit("tools.list", true, { count: tools.length, duration_ms: Date.now() - startList, names: tools.map((t) => t.name) });

  if (!toolName) {
    emit("done", true, { ts: new Date().toISOString(), list_only: true });
    await client.close();
    return;
  }
  if (!tools.some((t) => t.name === toolName)) {
    emit("error", false, { message: `tool ${toolName} not in list`, available: tools.map((t) => t.name) });
    await client.close();
    process.exit(1);
  }
  const startCall = Date.now();
  const result = await client.callTool(toolName, callArgs);
  emit("tools.call", true, { tool: toolName, duration_ms: Date.now() - startCall, content_parts: result.content.length, is_error: result.isError ?? false });
  for (let i = 0; i < result.content.length; i++) {
    const part = result.content[i];
    let parsed: unknown = part.text;
    try { parsed = JSON.parse(part.text); } catch { /* keep raw text */ }
    let summary: unknown = parsed;
    if (Array.isArray(parsed) && parsed.length > 0) {
      const first = parsed[0] as Record<string, unknown>;
      const keys = Object.keys(first);
      summary = {
        item_count: parsed.length,
        first_item_keys: keys,
        first_item_publishedAt: first.publishedAt ?? first.publish_time ?? first.pub_time ?? first.time ?? null,
        first_item_source: first.source ?? null,
        first_item_id: first.id ?? null,
        first_item_title: first.title ?? first.name ?? null,
        first_item_excerpt: typeof first.content === "string" ? first.content.slice(0, 80) : null,
      };
    } else if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const arrKey = ["items", "data", "results"].find((k) => Array.isArray(obj[k]));
      if (arrKey) {
        const arr = obj[arrKey] as Array<Record<string, unknown>>;
        const first = arr[0] ?? {};
        summary = {
          wrapper_key: arrKey,
          item_count: arr.length,
          first_item_keys: Object.keys(first),
          first_item_publishedAt: first.publishedAt ?? first.publish_time ?? first.pub_time ?? first.time ?? null,
          first_item_source: first.source ?? null,
        };
      } else {
        summary = { top_level_keys: Object.keys(parsed), sample: JSON.stringify(parsed).slice(0, 200) };
      }
    }
    emit(`content[${i}].summary`, true, { type: part.type, text_length: part.text.length, summary });
  }
  emit("diagnostics", true, client.dumpDiagnostics());
  await client.close();
  emit("done", true, { ts: new Date().toISOString() });
}

main().catch((e) => {
  emit("error", false, { message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack?.split("\n").slice(0, 3).join(" | ") : null });
  process.exit(1);
});
