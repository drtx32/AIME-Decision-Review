/**
 * Dump the full structured content of a single tools/call response.
 * NEVER prints credentials or any value from an Authorization / X-api-key
 * header. This is for one-off probing of the live upstream shape.
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = (args.provider as Provider) ?? "fuyao";
  const serverKey = args.server ?? (provider === "fuyao" ? "a-share" : "news");
  const toolName = args.tool!;
  const callArgs = args.args ? (JSON.parse(args.args) as Record<string, unknown>) : {};

  const baseUrl = provider === "fuyao" ? process.env.HITHINK_FINANCE_BASE_URL : process.env.IFIND_MCP_BASE_URL;
  const cred = provider === "fuyao" ? process.env.HITHINK_FINANCE_API_KEY : process.env.IFIND_MCP_AUTHORIZATION;
  if (!baseUrl || !cred) {
    console.error("missing baseUrl or credential");
    process.exit(1);
  }
  const endpoint = baseUrl.replace(/\/$/, "").endsWith(`/${serverKey}`)
    ? baseUrl.replace(/\/$/, "")
    : `${baseUrl.replace(/\/$/, "")}/${serverKey}`;
  const authHeaders = provider === "fuyao"
    ? { "x-api-key": cred, authorization: `Bearer ${cred}` }
    : { authorization: cred };

  const client = new McpStreamableHttpClient({ endpoint, serverKey, provider, buildAuthHeaders: () => authHeaders });
  await client.listTools(); // triggers initialize + tools/list
  const result = await client.callTool(toolName, callArgs);
  await client.close();

  // Walk and print the structure: every key path + a small sample. NEVER
  // touches auth headers.
  for (let i = 0; i < result.content.length; i++) {
    const text = result.content[i].text;
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep string */ }
    console.log(`\n=== content[${i}] type=${result.content[i].type} length=${text.length} ===`);
    console.log(JSON.stringify(parsed, null, 2));
  }
}

main().catch((e) => {
  console.error("error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
