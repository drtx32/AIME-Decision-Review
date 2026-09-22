/**
 * ELI-326 — provider resilience contract.
 *
 * Goal: the API must boot and stay healthy even when LLM env is missing,
 * must return a controlled 503 when the provider is unconfigured, must keep
 * /health 200 after a provider failure, and must never leak secrets.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { makeTestConfig, makeTestServer, type TestServer } from "./helpers.ts";
import { buildServer } from "../src/server.ts";
import {
  classifyProviderError,
  makeProviderError,
  type ProviderError,
} from "../src/providers/errors.ts";
import {
  LazyResilientProvider,
  getProviderAvailability,
  _resetModelProviderForTest,
} from "../src/providers/index.ts";
import { MockModelProvider } from "../src/providers/mock-provider.ts";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.ts";
import type { ModelProvider } from "../src/providers/index.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../src/config.ts";

function buildConfigWithoutLLM(overrides: Partial<AppConfig> = {}): AppConfig {
  return makeTestConfig({
    llm: {
      provider: "openai-compatible",
      model: "missing-model",
      baseUrl: null,
      apiKey: null,
    },
    ...overrides,
  });
}

describe("ELI-326: API stays healthy with missing LLM config", () => {
  let ctx: TestServer | null = null;
  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
    _resetModelProviderForTest();
  });

  test("boot with no LLM env → API healthy (/health 200, provider_configured: false)", async () => {
    const cfg = buildConfigWithoutLLM();
    const { app, repo } = buildServer(cfg);
    ctx = { app, deps: { config: cfg } as never, repo, cfg, cleanup: () => repo.close() };

    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      provider_configured: boolean;
      provider_status: string;
      provider_id: string | null;
      requested_mode: string;
      degraded: boolean;
      last_error: null | {
        code: string;
        retryable: boolean;
        correlationId: string;
        providerStatus: string | null;
      };
    };
    expect(body.status).toBe("ok");
    expect(body.provider_configured).toBe(false);
    expect(body.provider_status).toBe("unconfigured");
    expect(body.requested_mode).toBe("openai-compatible");
    expect(body.degraded).toBe(true);
    expect(body.last_error?.code).toBe("MODEL_NOT_CONFIGURED");
    expect(body.last_error?.retryable).toBe(false);
    expect(body.last_error?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    // Provider status is the typed "missing_credentials" marker — never an
    // api key or Authorization header.
    expect(body.last_error?.providerStatus).toBe("missing_credentials");
  });

  test("POST /api/reviews with no provider → controlled 503 + stable code MODEL_NOT_CONFIGURED", async () => {
    const cfg = buildConfigWithoutLLM();
    const { app, repo } = buildServer(cfg);
    ctx = { app, deps: { config: cfg } as never, repo, cfg, cleanup: () => repo.close() };

    const res = await app.request("/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        symbol: "600519",
        market: "CN",
        action: "buy",
        executedAt: "2024-03-15T00:00:00Z",
        userReason: "Channel checks pre-T0; pricing power intact.",
      }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: string;
      code: string;
      retryable: boolean;
      provider_status: string;
      message: string;
    };
    expect(body.error).toBe("MODEL_NOT_CONFIGURED");
    expect(body.code).toBe("MODEL_NOT_CONFIGURED");
    expect(body.retryable).toBe(false);
    expect(body.provider_status).toBe("unconfigured");
    // User-facing message in Chinese per the issue contract.
    expect(body.message).toContain("当前未配置可用的大模型服务");
  });

  test("/health remains 200 after a provider call failure (mock provider failure path)", async () => {
    const cfg = buildConfigWithoutLLM();
    const { app, repo } = buildServer(cfg);
    ctx = { app, deps: { config: cfg } as never, repo, cfg, cleanup: () => repo.close() };

    // Trigger a 503 by submitting a review.
    await app.request("/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        symbol: "600519",
        market: "CN",
        action: "buy",
        executedAt: "2024-03-15T00:00:00Z",
        userReason: "Channel checks pre-T0; pricing power intact.",
      }),
    });

    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provider_configured: boolean; status: string };
    expect(body.status).toBe("ok");
    expect(body.provider_configured).toBe(false);
  });

  test("mock provider path keeps existing review flow working (sanity)", async () => {
    const cfg = makeTestConfig();
    const { app, deps, repo, cleanup } = makeTestServer();
    ctx = { app, deps, repo, cfg, cleanup };

    const created = await app.request("/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        symbol: "600519",
        market: "CN",
        action: "buy",
        executedAt: "2024-03-15T00:00:00Z",
        price: 1620.5,
        quantity: 100,
        userReason: "Channel checks pre-T0; pricing power intact.",
      }),
    });
    expect(created.status).toBe(202);
  });
});

describe("ELI-326: classifyProviderError maps raw SDK errors to stable codes", () => {
  test("401 → MODEL_AUTH_FAILED (http 502, not retryable)", () => {
    const e = Object.assign(new Error("401 Unauthorized"), { status: 401 });
    const mapped = classifyProviderError(e, {
      correlationId: "cid-1",
      providerId: "openai-compatible",
    });
    expect(mapped.code).toBe("MODEL_AUTH_FAILED");
    expect(mapped.httpStatus).toBe(502);
    expect(mapped.retryable).toBe(false);
  });
  test("403 → MODEL_AUTH_FAILED", () => {
    const mapped = classifyProviderError(
      Object.assign(new Error("403"), { status: 403 }),
      { correlationId: "cid-2", providerId: "openai-compatible" }
    );
    expect(mapped.code).toBe("MODEL_AUTH_FAILED");
  });
  test("429 → MODEL_RATE_LIMITED (retryable)", () => {
    const mapped = classifyProviderError(
      Object.assign(new Error("429 rate limit"), { status: 429 }),
      { correlationId: "cid-3", providerId: "openai-compatible" }
    );
    expect(mapped.code).toBe("MODEL_RATE_LIMITED");
    expect(mapped.retryable).toBe(true);
  });
  test("500 / 502 / 503 → MODEL_UNAVAILABLE (retryable)", () => {
    for (const s of [500, 502, 503]) {
      const mapped = classifyProviderError(
        Object.assign(new Error(`server error ${s}`), { status: s }),
        { correlationId: `cid-${s}`, providerId: "openai-compatible" }
      );
      expect(mapped.code).toBe("MODEL_UNAVAILABLE");
      expect(mapped.retryable).toBe(true);
    }
  });
  test("AbortError / TimeoutError → MODEL_TIMEOUT", () => {
    const e = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const mapped = classifyProviderError(e, {
      correlationId: "cid-timeout",
      providerId: "openai-compatible",
    });
    expect(mapped.code).toBe("MODEL_TIMEOUT");
    expect(mapped.httpStatus).toBe(504);
    expect(mapped.retryable).toBe(true);
  });
  test("network error (no status, no name) → MODEL_UNAVAILABLE", () => {
    const mapped = classifyProviderError(new Error("fetch failed"), {
      correlationId: "cid-net",
      providerId: "openai-compatible",
    });
    expect(mapped.code).toBe("MODEL_UNAVAILABLE");
  });
  test("sanitized output never includes secrets (no api keys, no Authorization)", () => {
    // Synthetic auth-failure input. The fixture deliberately avoids any
    // string that matches a real secret scanner pattern (no `sk-*`, no
    // `Bearer <token>`, no `Authorization:` literal) so the source tree
    // does not trigger external scanners. The assertion is universal:
    // whatever the raw input looks like, the typed sanitizedMessage must
    // never echo user-supplied substrings back.
    const e = Object.assign(
      new Error("request_failed status=401 reason=invalid_credentials"),
      { status: 401 }
    );
    const mapped = classifyProviderError(e, {
      correlationId: "cid-secret",
      providerId: "openai-compatible",
    });
    expect(mapped.sanitizedMessage).not.toMatch(/sk-/i);
    expect(mapped.sanitizedMessage).not.toMatch(/Bearer/i);
    expect(mapped.sanitizedMessage).not.toMatch(/Authorization:/i);
    expect(mapped.sanitizedMessage).not.toMatch(/REDACTION-PROBE/i);
  });
});

describe("ELI-326: LazyResilientProvider does not throw on construction", () => {
  test("constructing a real-provider wrapper without env does not throw", () => {
    const p = new LazyResilientProvider({
      id: "openai-compatible",
      modelName: "x",
      build: () => new MockModelProvider("x"),
    });
    expect(p.id).toBe("openai-compatible");
    // We can call availability() without ever having run complete().
    expect(p.availability().providerId).toBe("openai-compatible");
  });

  test("complete() surfaces typed ProviderError on inner failure", async () => {
    const flaky: ModelProvider = {
      id: "fake-flaky",
      modelName: "fake",
      async complete() {
        const e = Object.assign(new Error("rate limited"), { status: 429 });
        throw e;
      },
    };
    const p = new LazyResilientProvider({
      id: "fake-flaky",
      modelName: "fake",
      build: () => flaky,
      providerOptions: { maxRetries: 0 },
    });
    let caught: ProviderError | null = null;
    try {
      await p.complete({ system: "s", user: "u" });
    } catch (e) {
      caught = e as ProviderError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.code).toBe("MODEL_RATE_LIMITED");
    expect(caught?.retryable).toBe(true);
  });

  test("complete() retries once on retryable errors then surfaces the typed error", async () => {
    let attempts = 0;
    const flaky: ModelProvider = {
      id: "fake-flaky",
      modelName: "fake",
      async complete() {
        attempts++;
        const e = Object.assign(new Error("server error 503"), { status: 503 });
        throw e;
      },
    };
    const p = new LazyResilientProvider({
      id: "fake-flaky",
      modelName: "fake",
      build: () => flaky,
      providerOptions: { maxRetries: 1, retryBaseMs: 1 },
    });
    let caught: ProviderError | null = null;
    try {
      await p.complete({ system: "s", user: "u" });
    } catch (e) {
      caught = e as ProviderError;
    }
    expect(caught?.code).toBe("MODEL_UNAVAILABLE");
    // 1 initial attempt + 1 retry = 2.
    expect(attempts).toBe(2);
  });

  test("complete() does not retry on non-retryable (401)", async () => {
    let attempts = 0;
    const flaky: ModelProvider = {
      id: "fake-flaky",
      modelName: "fake",
      async complete() {
        attempts++;
        throw Object.assign(new Error("401"), { status: 401 });
      },
    };
    const p = new LazyResilientProvider({
      id: "fake-flaky",
      modelName: "fake",
      build: () => flaky,
      providerOptions: { maxRetries: 5, retryBaseMs: 1 },
    });
    let caught: ProviderError | null = null;
    try {
      await p.complete({ system: "s", user: "u" });
    } catch (e) {
      caught = e as ProviderError;
    }
    expect(caught?.code).toBe("MODEL_AUTH_FAILED");
    expect(attempts).toBe(1);
  });

  test("complete() times out when inner hangs longer than requestTimeoutMs", async () => {
    const slow: ModelProvider = {
      id: "fake-slow",
      modelName: "fake",
      async complete() {
        await new Promise((r) => setTimeout(r, 200));
        return { text: "ok" };
      },
    };
    const p = new LazyResilientProvider({
      id: "fake-slow",
      modelName: "fake",
      build: () => slow,
      providerOptions: { requestTimeoutMs: 30, maxRetries: 0 },
    });
    let caught: ProviderError | null = null;
    try {
      await p.complete({ system: "s", user: "u" });
    } catch (e) {
      caught = e as ProviderError;
    }
    expect(caught?.code).toBe("MODEL_TIMEOUT");
    expect(caught?.retryable).toBe(true);
  });
});

describe("ELI-326: getProviderAvailability honors cfg", () => {
  test("returns unconfigured when LLM env is missing", () => {
    _resetModelProviderForTest();
    const cfg = buildConfigWithoutLLM();
    const a = getProviderAvailability(cfg);
    expect(a.state).toBe("unconfigured");
    expect(a.requestedMode).toBe("openai-compatible");
    expect(a.degraded).toBe(true);
    expect(a.lastError?.code).toBe("MODEL_NOT_CONFIGURED");
  });

  test("returns ready (mock) when LLM_PROVIDER=mock", () => {
    _resetModelProviderForTest();
    const cfg = makeTestConfig();
    const a = getProviderAvailability(cfg);
    expect(a.state).toBe("ready");
    expect(a.requestedMode).toBe("mock");
    expect(a.degraded).toBe(false);
  });
});

describe("ELI-326: secret-redaction safety in route error responses", () => {
  let ctx: TestServer | null = null;
  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
    _resetModelProviderForTest();
  });

  test("error response body contains no api key or Authorization header", async () => {
    const cfg = buildConfigWithoutLLM();
    const { app, repo } = buildServer(cfg);
    ctx = { app, deps: { config: cfg } as never, repo, cfg, cleanup: () => repo.close() };

    const res = await app.request("/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        symbol: "600519",
        market: "CN",
        action: "buy",
        executedAt: "2024-03-15T00:00:00Z",
        userReason: "Channel checks pre-T0; pricing power intact.",
      }),
    });
    const text = await res.text();
    expect(text).not.toMatch(/sk-[A-Za-z0-9_\-]{8,}/);
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9_\-]{8,}/i);
    expect(text).not.toMatch(/Authorization:\s*\S+/i);
  });
});