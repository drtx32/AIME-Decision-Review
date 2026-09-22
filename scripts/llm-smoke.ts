/**
 * LLM smoke — exercises the OpenAI-compatible chat completions path used by
 * `apps/api/src/providers/openai-compatible.ts`.
 *
 * Two modes:
 *   - default (no LLM_BASE_URL set): starts a Bun.serve fake upstream that
 *     records the inbound Authorization header, then POSTs
 *     `{baseUrl}/chat/completions` against it. Proves the bearer path.
 *   - with real LLM_BASE_URL set: posts straight at the production gateway.
 *     The credential is never logged — only its scheme, length, and first 6
 *     characters.
 *
 * The script intentionally avoids `import openai` so it runs from repo root
 * without resolving workspace dependencies. The production path is exercised
 * by `openai-compatible.test.ts` and `openai-compatible.ts`; this script is a
 * tracer, not a behaviour test.
 *
 * Usage:
 *   bun run scripts/llm-smoke.ts                            # fake upstream
 *   LLM_BASE_URL=https://api.example.com \
 *     LLM_API_KEY=sk-... \
 *     LLM_MODEL=mvp-mock-model \
 *     bun run scripts/llm-smoke.ts                          # real gateway
 */

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

interface FakeState {
  authorization: string | null;
  xApiKey: string | null;
  count: number;
}

async function runFake(): Promise<void> {
  const seen: FakeState = { authorization: null, xApiKey: null, count: 0 };
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      seen.authorization = req.headers.get("authorization");
      seen.xApiKey = req.headers.get("x-api-key");
      seen.count += 1;
      const body = {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok-from-fake" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const fakeBaseUrl = `http://localhost:${server.port}/v1`;
  const fakeKey = "sk-fake-smoke-token-for-trace-only";

  try {
    const url = `${fakeBaseUrl}/chat/completions`;
    const t0 = Date.now();
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fakeKey}`,
      },
      body: JSON.stringify({
        model: "mvp-mock-model",
        temperature: 0,
        max_tokens: 16,
        messages: [
          { role: "system", content: "ping" },
          { role: "user", content: "ping" },
        ],
      }),
    });
    const json = (await resp.json().catch(() => null)) as
      | {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        }
      | null;
    const text = json?.choices?.[0]?.message?.content ?? null;
    emit("fake.upstream.responded", resp.status === 200, {
      url: `${server.port}/v1/chat/completions`,
      status: resp.status,
      latency_ms: Date.now() - t0,
      text,
      usage: json?.usage ?? null,
    });
    emit("fake.upstream.headers", seen.count > 0, {
      request_count: seen.count,
      authorization: mask(seen.authorization),
      x_api_key: mask(seen.xApiKey),
    });
  } finally {
    server.stop(true);
  }
}

async function runReal(
  baseUrl: string,
  apiKey: string,
  model: string
): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const t0 = Date.now();
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 16,
      messages: [
        { role: "system", content: "ping" },
        { role: "user", content: "ping" },
      ],
    }),
  });
  const text = await resp.text();
  const truncated = text.length > 200 ? `${text.slice(0, 200)}…(truncated)` : text;
  emit("real.upstream.responded", resp.ok, {
    base_url_host: new URL(baseUrl).host,
    status: resp.status,
    latency_ms: Date.now() - t0,
    body_preview: truncated,
  });
  emit("real.upstream.headers", true, {
    authorization: mask(`Bearer ${apiKey}`),
    note: "Token is masked; presence, scheme and length are non-secret metadata.",
  });
}

const baseUrl = process.env.LLM_BASE_URL?.trim();
const apiKey = process.env.LLM_API_KEY?.trim();
const model = process.env.LLM_MODEL?.trim() || "mvp-mock-model";

if (baseUrl && apiKey) {
  emit("mode", true, {
    mode: "real-gateway",
    base_url_host: new URL(baseUrl).host,
    model,
  });
  await runReal(baseUrl, apiKey, model);
} else {
  emit("mode", true, {
    mode: "fake-upstream",
    note: "LLM_BASE_URL/LLM_API_KEY not set; running local fake to prove the bearer path.",
  });
  await runFake();
}

emit("done", true, { ts: new Date().toISOString() });
