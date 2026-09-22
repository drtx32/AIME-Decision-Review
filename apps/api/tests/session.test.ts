import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loginAndCookie, makeTestServer, seedUser, type TestServer } from "./helpers.ts";
import type { ModelProvider } from "../src/providers/index.ts";
import { MissingCredentialsProvider } from "../src/providers/index.ts";

const extraction = {
  decisions: [
    { symbol: "金牛化工", name: "金牛化工", action: "sell", market: "CN", executedAt: "2025-03-17T14:34:00+08:00", executedAtText: "昨天大概下午2:34左右", timePrecision: "approximate", price: 16.57, quantityShares: 200, quantityText: "2手", rationale: "", notes: "午间休市挂限价单", confidence: .92, needsConfirmation: [] },
    { symbol: "中粮糖业", name: "中粮糖业", action: "buy", market: "CN", executedAt: "2025-03-17T14:57:00+08:00", executedAtText: "昨天尾盘集合竞价", timePrecision: "approximate", price: null, quantityShares: null, quantityText: "全仓", rationale: "", notes: "", confidence: .8, needsConfirmation: ["确认尾盘集合竞价成交时间"] },
    { symbol: "中粮糖业", name: "中粮糖业", action: "sell", market: "CN", executedAt: null, executedAtText: "第二天早上，也就是今天", timePrecision: "unknown", price: null, quantityShares: null, quantityText: null, rationale: "", notes: "亏了零点几个点就跑了", confidence: .7, needsConfirmation: ["确认今天早上的成交时间"] },
  ],
};

describe("Conversation session contract", () => {
  let ctx: TestServer;
  beforeEach(() => { ctx = makeTestServer(); });
  afterEach(() => ctx.cleanup());

  test("uses provider structured extraction for the Chinese multi-decision regression", async () => {
    const alice = await loginAndCookie(ctx.app, ctx.userRepo, "alice", "alice-pass");
    const bob = await loginAndCookie(ctx.app, ctx.userRepo, "bob", "bob-pass");
    const calls: string[] = [];
    ctx.deps.provider = { id: "test", modelName: "test", configured: true, complete: async (req) => { calls.push(req.schemaHint || "followup"); return req.schemaHint ? { text: JSON.stringify(extraction) } : { text: "基于当前 session 的证据回答。" }; } } satisfies ModelProvider;
    const created = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json", cookie: alice }, body: JSON.stringify({ message: "昨天我卖掉了金牛化工，大概是下午2:34左右，是通过午间休市的时候挂的限价单，16.57卖的，然后卖了2手。同时尾盘集合竞价又买了中粮糖业。全仓买入，第二天早上，也就是今天卖掉了，差不多亏了零点几个点就跑了。", clientNow: "2025-03-18T09:00:00+08:00", timezone: "Asia/Shanghai" }) });
    expect(created.status).toBe(201);
    const body = await created.json() as any;
    expect(body.decisions).toHaveLength(3);
    expect(body.decisions.map((d: any) => d.symbol)).toEqual(["金牛化工", "中粮糖业", "中粮糖业"]);
    expect(body.decisions.some((d: any) => d.symbol === "2手" || d.symbol === "了")).toBe(false);
    expect(body.decisions[0].quantityText).toBe("2手");
    expect(body.decisions[0].quantityShares).toBe(200);
    expect(body.decisions[2].executedAt).toBeNull();
    expect(body.decisions[2].timePrecision).toBe("unknown");
    expect(calls).toEqual(["DecisionExtractionResult"]);
    const blocked = await ctx.app.request(`/api/sessions/${body.sessionId}/confirm`, { method: "POST", headers: { cookie: alice } });
    expect(blocked.status).toBe(422);
    expect((await blocked.json() as any).decisionIds).toHaveLength(3);
    const hidden = await ctx.app.request(`/api/sessions/${body.sessionId}`, { headers: { cookie: bob } });
    expect(hidden.status).toBe(404);
  });

  test("no model cannot create a session or fake decisions", async () => {
    ctx.deps.provider = new MissingCredentialsProvider({ id: "openai-compatible", modelName: "missing-model" });
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "alice", "alice-pass");
    const response = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message: "买入 600519" }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "MODEL_NOT_CONFIGURED", code: "MODEL_NOT_CONFIGURED", message: "当前未配置可用的大模型服务，请联系管理员。", provider_status: "unconfigured", retryable: false });
    expect(ctx.repo.listSessions("alice")).toHaveLength(0);
  });

  test("requires an actual T0 before review and sends follow-up through provider", async () => {
    let call = 0;
    const provider: ModelProvider = { id: "test", modelName: "test", configured: true, complete: async (req) => { call += 1; return req.schemaHint ? { text: JSON.stringify({ decisions: [{ ...extraction.decisions[2] }] }) } : { text: "基于当前 session 的证据，建议先检查失效条件。" }; } };
    ctx.deps.provider = provider;
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "alice", "alice-pass");
    const created = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message: "今天卖出中粮糖业" }) });
    const createdBody = await created.json() as { sessionId: string; decisions: Array<{ id: string }> };
    const { sessionId } = createdBody;
    const confirm = await ctx.app.request(`/api/sessions/${sessionId}/confirm`, { method: "POST", headers: { cookie } });
    expect(confirm.status).toBe(422);
    const update = await ctx.app.request(`/api/sessions/${sessionId}/decisions/${createdBody.decisions[0].id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ executedAt: "2025-03-18T09:00:00+08:00", timePrecision: "exact" }) });
    expect(update.status).toBe(200);
    const response = await ctx.app.request(`/api/sessions/${sessionId}/messages`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ content: "当前最重要的反向证据是什么？" }) });
    expect(response.status).toBe(201);
    expect((await response.json() as any).message.content).toContain("当前 session");
    expect(call).toBe(2);
  });

  test("session identity is cookie-derived and invalidation/gates block conversation access", async () => {
    expect((await ctx.app.request("/api/sessions")).status).toBe(401);
    const alice = await loginAndCookie(ctx.app, ctx.userRepo, "alice", "alice-pass");
    const bob = await loginAndCookie(ctx.app, ctx.userRepo, "bob", "bob-pass");
    ctx.deps.provider = { id: "test", modelName: "test", configured: true, complete: async () => ({ text: JSON.stringify(extraction) }) } satisfies ModelProvider;
    const forged = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json", cookie: alice, "x-user-id": "bob" }, body: JSON.stringify({ message: "买入 600519" }) });
    expect(forged.status).toBe(400);
    const created = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json", cookie: alice }, body: JSON.stringify({ message: "买入 600519" }) });
    const createdBody = await created.json() as { sessionId: string };
    expect((await ctx.app.request(`/api/sessions/${createdBody.sessionId}`, { headers: { cookie: bob } })).status).toBe(404);
    const logout = await ctx.app.request("/api/auth/logout", { method: "POST", headers: { cookie: alice } });
    expect(logout.status).toBe(200);
    expect((await ctx.app.request(`/api/sessions/${createdBody.sessionId}/messages`, { method: "POST", headers: { "content-type": "application/json", cookie: alice }, body: JSON.stringify({ content: "继续" }) })).status).toBe(401);
    await seedUser(ctx.userRepo, "must-change", "temporary-pass", { mustChangePassword: true });
    const mustChange = await ctx.app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "must-change", password: "temporary-pass" }) });
    const mustChangeCookie = mustChange.headers.get("set-cookie")!.split(";")[0];
    expect((await ctx.app.request("/api/sessions", { headers: { cookie: mustChangeCookie } })).status).toBe(403);
  });

  test("all source failures produce partial session and persisted assistant summary", async () => {
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "alice", "alice-pass");
    const candidate = { ...extraction.decisions[0], executedAt: "2025-03-18T09:00:00+08:00", timePrecision: "exact" };
    ctx.deps.provider = { id: "test", modelName: "test", configured: true, complete: async (req) => req.schemaHint === "DecisionExtractionResult" ? { text: JSON.stringify({ decisions: [candidate] }) } : { text: JSON.stringify({ verdict: "数据源暂时不可用，结论需补充验证。", lessons: ["在数据源恢复后重跑证据核验。", "先确认数据源时间戳。", "保留失败工具状态。"] }) } } satisfies ModelProvider;
    ctx.deps.registry = { configuredKeys: () => ["a-share"], resolve: () => null, resolveFor: () => [{ serverKey: "a-share", provider: "fuyao", canHandle: () => true, fetch: async () => ({ status: "transient_error", retrievedAt: new Date().toISOString(), error: { code: "UPSTREAM_DOWN", message: "upstream unavailable", retryable: true } }) }] };
    const created = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message: "昨天卖出金牛化工" }) });
    const body = await created.json() as { sessionId: string; decisions: Array<{ id: string }> };
    const confirmed = await ctx.app.request(`/api/sessions/${body.sessionId}/decisions/${body.decisions[0].id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ executedAt: candidate.executedAt, timePrecision: "exact" }) });
    expect(confirmed.status).toBe(200);
    expect((await ctx.app.request(`/api/sessions/${body.sessionId}/confirm`, { method: "POST", headers: { cookie } })).status).toBe(202);
    const restored = await ctx.app.request(`/api/sessions/${body.sessionId}`, { headers: { cookie } });
    const snapshot = await restored.json() as any;
    expect(snapshot.session.status).toBe("partial");
    expect(snapshot.messages.some((message: any) => message.role === "assistant")).toBe(true);
    expect(snapshot.messages.some((message: any) => message.content.includes("数据源"))).toBe(true);
    expect(snapshot.memories).toHaveLength(3);
    expect(snapshot.memories.every((memory: any) => memory.sourceSessionId === body.sessionId && memory.sourceDecisionId === body.decisions[0].id)).toBe(true);
    expect((await ctx.app.request(`/api/sessions/${body.sessionId}/confirm`, { method: "POST", headers: { cookie } })).status).toBe(202);
    const deduped = await ctx.app.request(`/api/sessions/${body.sessionId}`, { headers: { cookie } });
    expect((await deduped.json() as any).memories).toHaveLength(3);
  });
});
