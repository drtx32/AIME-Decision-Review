import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { makeTestServer, loginAndCookie, type TestServer } from "./helpers.ts";
import type { DecisionReviewResult } from "../src/types/index.ts";
import type { ModelProvider } from "../src/providers/index.ts";

describe("Review API contract", () => {
  let ctx: TestServer;
  let cookie: string;

  beforeEach(async () => {
    ctx = makeTestServer();
    cookie = await loginAndCookie(ctx.app, ctx.userRepo, "tester", "secret-pass-12345");
  });
  afterEach(() => ctx.cleanup());

  test("GET /health returns 200 with provider info", async () => {
    const res = await ctx.app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      provider: string;
      configuredServers: string[];
    };
    expect(body.status).toBe("ok");
    expect(body.provider).toBe("mock");
    expect(Array.isArray(body.configuredServers)).toBe(true);
    expect(body.configuredServers).toContain("a-share");
    expect(body.configuredServers).toContain("stock");
  });

  test("GET /api/chart-data requires auth", async () => {
    const res = await ctx.app.request("/api/chart-data?symbol=600519&type=kline");
    expect(res.status).toBe(401);
  });

  test("GET /api/chart-data rejects invalid payload", async () => {
    const res = await ctx.app.request(
      "/api/chart-data?type=invalid&symbol=",
      { headers: { cookie } }
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_input");
  });

  test("GET /api/chart-data returns ok with synthetic series when no provider is wired", async () => {
    const res = await ctx.app.request(
      "/api/chart-data?symbol=600519&type=kline&period=day",
      { headers: { cookie } }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      type: string;
      series?: { source: string; candles?: unknown[]; timezone?: string };
    };
    expect(body.status).toBe("ok");
    expect(body.type).toBe("kline");
    expect(body.series?.source).toBe("fallback");
    expect(body.series?.timezone).toBe("Asia/Shanghai");
    expect(Array.isArray(body.series?.candles)).toBe(true);
  });

  test("GET /api/chart-data returns unavailable for unsupported valuation fields", async () => {
    const res = await ctx.app.request(
      "/api/chart-data?symbol=600519&type=valuation",
      { headers: { cookie } }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; message?: string };
    expect(body.status).toBe("unavailable");
    expect(body.message).toBeTruthy();
  });

  test("POST /api/reviews rejects invalid payload", async () => {
    const res = await ctx.app.request("/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ symbol: "" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_input");
  });

  test("production with no configured model keeps health up but rejects review creation", async () => {
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "reviewer", "reviewer-pass");
    ctx.cfg.runtime = "production";
    const health = await ctx.app.request("/health");
    expect(health.status).toBe(200);
    const healthBody = await health.json() as { status: string; provider_configured: boolean; provider_status: string };
    expect(healthBody.status).toBe("ok");
    expect(healthBody.provider_configured).toBe(false);
    expect(healthBody.provider_status).toBe("unconfigured");

    const review = await ctx.app.request("/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ symbol: "600519", market: "CN", action: "buy", executedAt: "2024-03-15T00:00:00Z", userReason: "channel checks" }),
    });
    expect(review.status).toBe(503);
    expect(await review.json()).toMatchObject({ error: "MODEL_NOT_CONFIGURED", code: "MODEL_NOT_CONFIGURED", message: "当前未配置可用的大模型服务，请联系管理员。" });
  });

  test("POST /api/reviews rejects non-compliant (T11) deterministic-prediction language", async () => {
    const res = await ctx.app.request("/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        symbol: "600519",
        market: "CN",
        action: "buy",
        executedAt: "2024-03-15T00:00:00Z",
        userReason: "Guaranteed 100% return in 30 days, buy now",
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe("non_compliant_request");
    expect(body.reason).toBeTruthy();
  });

  test("POST /api/reviews → GET /result returns structured review (vertical slice)", async () => {
    ctx.deps.provider = { id: "test", modelName: "test", configured: true, complete: async () => ({ text: "{}" }) } satisfies ModelProvider;
    const created = await ctx.app.request("/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        symbol: "600519",
        market: "CN",
        action: "buy",
        executedAt: "2024-03-15T00:00:00Z",
        price: 1620.5,
        quantity: 100,
        userReason: "Channel checks confirmed brand pricing power.",
      }),
    });
    expect(created.status).toBe(202);
    const createdBody = (await created.json()) as { id: string };
    expect(createdBody.id).toMatch(/^rev_/);
    const id = createdBody.id;

    let status = "created";
    for (let i = 0; i < 30 && status !== "completed" && status !== "partial" && status !== "failed"; i++) {
      const r = await ctx.app.request(`/api/reviews/${id}`, { headers: { cookie } });
      const body = (await r.json()) as { status: string };
      status = body.status;
      if (status !== "completed" && status !== "partial" && status !== "failed") {
        await new Promise((res) => setTimeout(res, 50));
      }
    }

    const resultRes = await ctx.app.request(`/api/reviews/${id}/result`, { headers: { cookie } });
    expect(resultRes.status).toBe(200);
    const resultBody = (await resultRes.json()) as { result: DecisionReviewResult };
    const result = resultBody.result;

    expect(result.decision.T0).toBe("2024-03-15T00:00:00.000Z");

    const t0 = Date.parse(result.decision.T0);
    for (const e of result.exAnteEvidence) {
      expect(Date.parse(e.publishedAt)).toBeLessThanOrEqual(t0);
    }
    for (const e of result.exPostEvidence) {
      expect(Date.parse(e.publishedAt)).toBeGreaterThan(t0);
    }

    expect(result.decisionQuality).toBeDefined();
    expect(result.outcome).toBeDefined();

    expect(Array.isArray(result.toolStatuses)).toBe(true);
    expect(result.toolStatuses.length).toBeGreaterThan(0);

    const eventsRes = await ctx.app.request(`/api/reviews/${id}/events`, { headers: { cookie } });
    const eventsBody = (await eventsRes.json()) as {
      events: Array<{ kind: string }>;
    };
    const kinds = eventsBody.events.map((e) => e.kind);
    expect(kinds).toContain("review_created");
    expect(kinds).toContain("evidence_time_aligned");
    expect(kinds).toContain("final_review_generated");
  });
});
