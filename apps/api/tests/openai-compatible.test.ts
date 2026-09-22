/**
 * Integration test for the real OpenAI-compatible LLM provider path.
 *
 * Spins up a tiny Bun.serve mock that pretends to be an OpenAI-compatible
 * chat completions endpoint, then exercises OpenAICompatibleProvider
 * end-to-end. Proves:
 *   - chat.completions.create is called with our model + messages
 *   - Authorization header carries the api key (and is NOT echoed in errors)
 *   - the response text flows back to the caller
 *
 * Note: the strings `sk-test-secret` / `sk-test` are test fixtures, not
 * real credentials.
 */

import { describe, test, expect } from "bun:test";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.ts";

describe("OpenAI-compatible provider — real LLM HTTP path", () => {
  test("200 chat completion → text returned, Authorization header forwarded", async () => {
    let receivedAuth: string | null = null as string | null;
    let receivedModel: string | null = null as string | null;
    let receivedMessages: unknown = null as unknown;

    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/chat/completions") {
          receivedAuth = req.headers.get("authorization");
          const body = (await req.json()) as { model: string; messages: unknown };
          receivedModel = body.model;
          receivedMessages = body.messages;
          return new Response(
            JSON.stringify({
              id: "cmpl-test",
              object: "chat.completion",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: '{"verdict":"real-llm"}' },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response("nope", { status: 404 });
      },
    });

    const provider = new OpenAICompatibleProvider({
      modelName: "test-model-1",
      baseUrl: `http://localhost:${server.port}`,
      apiKey: "sk-test-secret",
    });
    const completion = await provider.complete({
      system: "You are a test.",
      user: "Return JSON with verdict.",
    });
    server.stop(true);

    expect(completion.text).toBe('{"verdict":"real-llm"}');
    expect(receivedAuth).toBe("Bearer sk-test-secret");
    expect(receivedModel).toBe("test-model-1");
    expect(receivedMessages).toEqual([
      { role: "system", content: "You are a test." },
      { role: "user", content: "Return JSON with verdict." },
    ]);
    expect(completion.usage).toEqual({ input: 11, output: 4 });
  });

  test("network error → propagates as a thrown error (caller classifies)", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ error: "rate limit" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    });
    const provider = new OpenAICompatibleProvider({
      modelName: "test-model",
      baseUrl: `http://localhost:${server.port}`,
      apiKey: "sk-test",
    });
    // OpenAI SDK will throw on non-2xx — the agent harness catches this and
    // we want to make sure the error message does NOT echo the api key.
    let err: Error | null = null;
    try {
      await provider.complete({ system: "s", user: "u" });
    } catch (e) {
      err = e as Error;
    }
    server.stop(true);
    expect(err).not.toBeNull();
    expect(err!.message).not.toContain("sk-test");
  });
});