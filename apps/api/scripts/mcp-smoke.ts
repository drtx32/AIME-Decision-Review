/**
 * MCP smoke — exercises LiveHttpAdapter against Fuyao or iFinD HTTP upstream.
 *
 * Two modes:
 *   - default (no HITHINK_FINANCE_BASE_URL / IFIND_MCP_BASE_URL set): starts a
 *     Bun.serve fake upstream that records inbound Authorization / x-api-key
 *     headers, runs the registry-backed adapter against it, and prints a
 *     structured trace.
 *   - with real baseUrl + credential set: routes straight at the production
 *     gateway. We never print the credential — only its scheme, length, and
 *     first 6 chars.
 *
 * The script accepts `--provider=fuyao|ifind` (default fuyao) and
 * `--server=a-share|stock|...` (default depends on provider).
 *
 * Usage:
 *   bun run scripts/mcp-smoke.ts                           # fake upstream
 *   HITHINK_FINANCE_BASE_URL=https://api.example.com/mcp \
 *     HITHINK_FINANCE_API_KEY=fy-... \
 *     bun run scripts/mcp-smoke.ts --provider=fuyao --server=a-share
 */

import { LiveHttpAdapter } from "../src/mcp/adapters/live-http.ts";

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

function mask(authHeader: string | null | undefined): {
  present: boolean;
  scheme: string | null;
  prefix: string | null;
  length: number | null;
} {
  if (!authHeader) return { present: false, scheme: null, prefix: null, length: null };
  const trimmed = authHeader.trim();
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

interface StartedServer {
  url: string;
  close: () => void;
}

async function startFakeFuyao(
  fakeApiKey: string
): Promise<StartedServer & { lastAuth: { authorization: string | null; xApiKey: string | null } }> {
  const state = { authorization: null as string | null, xApiKey: null as string | null };
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      state.authorization = req.headers.get("authorization");
      state.xApiKey = req.headers.get("x-api-key");
      const body = {
        items: [
          {
            id: `fuyao-${Date.now()}`,
            type: "price",
            title: "A-share close, pre-T0",
            content: "Fake upstream price 1620.50 CN.",
            source: "fuyao:a-share:price",
            publishedAt: "2024-03-14T00:00:00Z",
            metadata: { field: "close" },
          },
        ],
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    close: () => server.stop(true),
    lastAuth: state,
  };
}

async function startFakeIFind(
  fakeAuth: string
): Promise<StartedServer & { lastAuth: { authorization: string | null; xApiKey: string | null } }> {
  const state = { authorization: null as string | null, xApiKey: null as string | null };
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      state.authorization = req.headers.get("authorization");
      state.xApiKey = req.headers.get("x-api-key");
      const body = {
        items: [
          {
            id: `ifind-${Date.now()}`,
            type: "news",
            title: "Sector news, pre-T0",
            content: "Fake upstream sector news.",
            source: "ifind:news:sector",
            publishedAt: "2024-03-10T00:00:00Z",
          },
        ],
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    close: () => server.stop(true),
    lastAuth: state,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = (args.provider ?? "fuyao").toLowerCase();
  const serverKey = args.server ?? (provider === "fuyao" ? "a-share" : "news");

  emit("start", true, {
    provider,
    server: serverKey,
    ts: new Date().toISOString(),
  });

  let adapter: LiveHttpAdapter;
  let closer: (() => void) | null = null;
  let traceAuth: { authorization: string | null; xApiKey: string | null } | null = null;
  let baseUrlHost: string;

  if (provider === "fuyao") {
    const realBaseUrl = process.env.HITHINK_FINANCE_BASE_URL?.trim();
    const realKey = process.env.HITHINK_FINANCE_API_KEY?.trim();
    if (realBaseUrl && realKey) {
      adapter = new LiveHttpAdapter({
        provider: "fuyao",
        serverKey,
        credentials: { baseUrl: realBaseUrl, apiKey: realKey },
        pathFor: (k, intent) => `/${k}/${intent}`,
        buildAuthHeader: () => realKey,
      });
      baseUrlHost = new URL(realBaseUrl).host;
    } else {
      const fake = await startFakeFuyao("sk-fake-fuyao");
      closer = fake.close;
      traceAuth = fake.lastAuth;
      adapter = new LiveHttpAdapter({
        provider: "fuyao",
        serverKey,
        credentials: { baseUrl: fake.url, apiKey: "sk-fake-fuyao" },
        pathFor: (k, intent) => `/${k}/${intent}`,
        buildAuthHeader: () => "sk-fake-fuyao",
      });
      baseUrlHost = `localhost:${new URL(fake.url).port}`;
    }
  } else if (provider === "ifind") {
    const realBaseUrl = process.env.IFIND_MCP_BASE_URL?.trim();
    const realAuth = process.env.IFIND_MCP_AUTHORIZATION?.trim();
    if (realBaseUrl && realAuth) {
      adapter = new LiveHttpAdapter({
        provider: "ifind",
        serverKey,
        credentials: { baseUrl: realBaseUrl, authorization: realAuth },
        pathFor: (k, intent) => `/${k}/${intent}`,
        buildAuthHeader: () => realAuth,
      });
      baseUrlHost = new URL(realBaseUrl).host;
    } else {
      const fake = await startFakeIFind("Bearer sk-fake-ifind");
      closer = fake.close;
      traceAuth = fake.lastAuth;
      adapter = new LiveHttpAdapter({
        provider: "ifind",
        serverKey,
        credentials: { baseUrl: fake.url, authorization: "Bearer sk-fake-ifind" },
        pathFor: (k, intent) => `/${k}/${intent}`,
        buildAuthHeader: () => "Bearer sk-fake-ifind",
      });
      baseUrlHost = `localhost:${new URL(fake.url).port}`;
    }
  } else {
    emit("error", false, { reason: "unknown_provider", provider });
    process.exit(2);
  }

  emit("adapter.constructed", true, {
    provider,
    server: serverKey,
    base_url_host: baseUrlHost,
  });

  const result = await adapter.fetch({
    intent: provider === "fuyao" ? "price" : "news",
    symbol: "600519",
    market: "CN",
    T0: "2024-03-15T00:00:00Z",
    limit: 1,
  });

  if (closer) closer();

  emit("adapter.result", result.status === "success", {
    status: result.status,
    count: result.status === "success" ? result.data?.length ?? 0 : 0,
    first_source: result.status === "success" ? result.data?.[0]?.source : undefined,
    first_published_at:
      result.status === "success" ? result.data?.[0]?.publishedAt : undefined,
    error_code: result.error?.code,
    latency_ms: result.latencyMs,
  });

  if (traceAuth) {
    emit("fake.upstream.headers", true, {
      authorization: mask(traceAuth.authorization),
      x_api_key: mask(traceAuth.xApiKey),
    });
  } else {
    emit("real.upstream.headers", true, {
      authorization: mask(
        provider === "fuyao"
          ? process.env.HITHINK_FINANCE_API_KEY
          : process.env.IFIND_MCP_AUTHORIZATION
      ),
      note: "Token is masked; presence and length are non-secret metadata.",
    });
  }

  emit("done", result.status === "success", {
    ts: new Date().toISOString(),
  });

  if (result.status !== "success") process.exit(1);
}

await main();
