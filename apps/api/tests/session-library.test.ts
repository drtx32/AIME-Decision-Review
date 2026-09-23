/**
 * ELI-358 — conversation library behavior: auto-title, real status,
 * content search, rename/archive/delete actions. These tests pin the
 * server-side contract the sidebar relies on.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loginAndCookie, makeTestServer, type TestServer } from "./helpers.ts";
import type { ModelProvider } from "../src/providers/index.ts";
import { ReviewRepository } from "../src/db/sqlite.ts";

const exactDecision = {
  symbol: "万科A",
  name: "万科A",
  action: "buy",
  market: "CN",
  executedAt: "2026-09-22T13:37:00+08:00",
  executedAtText: "昨天下午1:37",
  timePrecision: "exact",
  price: 13.7,
  quantityShares: 2000,
  quantityText: "20手",
  rationale: "T0 前观察到量价异动",
  notes: "",
  confidence: 0.98,
  needsConfirmation: [],
} as const;

const secondDecision = {
  symbol: "一鸣食品",
  name: "一鸣食品",
  action: "sell",
  market: "CN",
  executedAt: "2026-09-23T09:30:00+08:00",
  executedAtText: "今天早上跌破均价线后",
  timePrecision: "approximate",
  price: null,
  quantityShares: 800,
  quantityText: "8手",
  rationale: "跌破当日均价线",
  notes: "",
  confidence: 0.76,
  needsConfirmation: [],
} as const;

describe("Conversation library — ELI-358", () => {
  let ctx: TestServer;
  beforeEach(() => { ctx = makeTestServer(); });
  afterEach(() => ctx.cleanup());

  test("auto-title is derived deterministically from extracted decisions", async () => {
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "eleven", "eleven-pass");
    ctx.deps.provider = { id: "test", modelName: "test", configured: true, complete: async (req) => req.schemaHint ? { text: JSON.stringify({ decisions: [exactDecision, secondDecision] }) } : { text: "继续" } } satisfies ModelProvider;
    const created = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message: "昨天我下午1:37的时候，以13.70买了万科A 20手。今天早上在一鸣食品拉伸后又跌破当日的均价线的位置，出掉了八手。", clientNow: "2026-09-23T10:00:00+08:00", timezone: "Asia/Shanghai" }) });
    expect(created.status).toBe(201);
    const body = await created.json() as any;
    const restored = await ctx.app.request(`/api/sessions/${body.sessionId}`, { headers: { cookie } });
    const restoredBody = await restored.json() as any;
    expect(restoredBody.session.title).toBe("万科A / 一鸣食品 复盘");
    const listing = await (await ctx.app.request("/api/sessions", { headers: { cookie } })).json() as any;
    expect(listing.sessions[0].title).toBe("万科A / 一鸣食品 复盘");
  });

  test("auto-title falls back to single-symbol form when only one decision", async () => {
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "eleven", "eleven-pass");
    ctx.deps.provider = { id: "test", modelName: "test", configured: true, complete: async (req) => req.schemaHint ? { text: JSON.stringify({ decisions: [exactDecision] }) } : { text: "继续" } } satisfies ModelProvider;
    const created = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message: "昨天我下午1:37的时候，以13.70买了万科A 20手。", clientNow: "2026-09-23T10:00:00+08:00", timezone: "Asia/Shanghai" }) });
    const body = await created.json() as any;
    const restored = await (await ctx.app.request(`/api/sessions/${body.sessionId}`, { headers: { cookie } })).json() as any;
    expect(restored.session.title).toBe("万科A 决策复盘");
  });

  test("manual rename persists and locks out subsequent auto-title rewrites", async () => {
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "eleven", "eleven-pass");
    ctx.deps.provider = { id: "test", modelName: "test", configured: true, complete: async (req) => req.schemaHint ? { text: JSON.stringify({ decisions: [exactDecision, secondDecision] }) } : { text: "继续" } } satisfies ModelProvider;
    const created = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message: "昨天我下午1:37的时候，以13.70买了万科A 20手。今天早上在一鸣食品拉伸后又跌破当日的均价线的位置，出掉了八手。", clientNow: "2026-09-23T10:00:00+08:00", timezone: "Asia/Shanghai" }) });
    const body = await created.json() as any;
    const renamed = await ctx.app.request(`/api/sessions/${body.sessionId}`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ title: "  9月万科买入复盘  " }) });
    expect(renamed.status).toBe(200);
    const renamedBody = await renamed.json() as any;
    expect(renamedBody.session.title).toBe("9月万科买入复盘");
    expect(renamedBody.session.manualTitle).toBe(1);

    // Re-edit the original message; provider yields different decisions but
    // the user-renamed title must stay.
    ctx.deps.provider = { id: "test", modelName: "test", configured: true, complete: async (req) => req.schemaHint ? { text: JSON.stringify({ decisions: [{ ...exactDecision, symbol: "完全不同的标的", name: "完全不同的标的" }] }) } : { text: "继续" } } satisfies ModelProvider;
    const userMessage = (await (await ctx.app.request(`/api/sessions/${body.sessionId}`, { headers: { cookie } })).json() as any).messages.find((m: any) => m.role === "user");
    const edited = await ctx.app.request(`/api/sessions/${body.sessionId}/messages/${userMessage.id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ content: "买入 600519" }) });
    expect(edited.status).toBe(200);
    const afterEdit = await (await ctx.app.request(`/api/sessions/${body.sessionId}`, { headers: { cookie } })).json() as any;
    expect(afterEdit.session.title).toBe("9月万科买入复盘");
  });

  test("rename rejects empty, whitespace-only, and over-long titles", async () => {
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "eleven", "eleven-pass");
    ctx.deps.provider = { id: "test", modelName: "test", configured: true, complete: async (req) => req.schemaHint ? { text: JSON.stringify({ decisions: [exactDecision] }) } : { text: "继续" } } satisfies ModelProvider;
    const created = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message: "买入 万科A" }) });
    const body = await created.json() as any;

    const blank = await ctx.app.request(`/api/sessions/${body.sessionId}`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ title: "   " }) });
    expect(blank.status).toBe(400);

    const tooLong = await ctx.app.request(`/api/sessions/${body.sessionId}`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ title: "x".repeat(81) }) });
    expect(tooLong.status).toBe(400);

    const missing = await ctx.app.request(`/api/sessions/${body.sessionId}`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({}) });
    expect(missing.status).toBe(400);
  });

  test("search matches message body even when the title does not contain the phrase", async () => {
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "eleven", "eleven-pass");
    ctx.deps.provider = { id: "test", modelName: "test", configured: true, complete: async (req) => req.schemaHint ? { text: JSON.stringify({ decisions: [exactDecision] }) } : { text: "OK 答复" } } satisfies ModelProvider;
    const created = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message: "买入 万科A" }) });
    const body = await created.json() as any;
    // Send a follow-up that mentions a security phrase only in the body.
    const followUp = await ctx.app.request(`/api/sessions/${body.sessionId}/messages`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ content: "请重点关注 300750 这条线索" }) });
    expect(followUp.status).toBe(201);

    const found = await (await ctx.app.request(`/api/sessions?q=${encodeURIComponent("300750")}`, { headers: { cookie } })).json() as any;
    expect(found.sessions.some((s: any) => s.id === body.sessionId)).toBe(true);

    const titleOnlyMiss = await (await ctx.app.request(`/api/sessions?q=${encodeURIComponent("完全不存在的标题片段xyz")}`, { headers: { cookie } })).json() as any;
    expect(titleOnlyMiss.sessions).toHaveLength(0);
  });

  test("status reflects real lifecycle for completed review and needs_input session", async () => {
    const aliceCookie = await loginAndCookie(ctx.app, ctx.userRepo, "alice", "alice-pass");
    // Completed path — provide a working adapter and grounded judgment so the
    // agent reaches terminal "completed" instead of degrading to "partial".
    ctx.deps.provider = {
      id: "test", modelName: "test", configured: true,
      complete: async (req) => req.schemaHint === "DecisionExtractionResult"
        ? { text: JSON.stringify({ decisions: [{ ...exactDecision, timePrecision: "exact", needsConfirmation: [] }] }) }
        : { text: JSON.stringify({ rating: "good", verdict: "T0 前证据支持判断。", lessons: ["记录反向证据。"], attribution: [{ claim: "T0 前证据支持判断", status: "supported", evidenceIds: ["grounded-evidence"] }] }) },
    } satisfies ModelProvider;
    ctx.deps.registry = {
      configuredKeys: () => ["a-share"], resolve: () => null,
      resolveFor: () => [{ serverKey: "a-share", provider: "fuyao", canHandle: () => true, fetch: async () => ({ status: "success", retrievedAt: new Date().toISOString(), data: [{ id: "grounded-evidence", type: "news", title: "T0 前事实", content: "可核验的事前证据。", source: "test", publishedAt: "2026-09-22T00:00:00Z", retrievedAt: new Date().toISOString(), relationToDecision: "ex_ante" }] }) }] as any,
    };
    const ok = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json", cookie: aliceCookie }, body: JSON.stringify({ message: "买入 万科A" }) });
    const okBody = await ok.json() as any;
    expect(okBody.status).toBe("accepted");
    await ctx.app.request(`/api/sessions/${okBody.sessionId}/confirm`, { method: "POST", headers: { cookie: aliceCookie } });
    const completedListing = await (await ctx.app.request("/api/sessions", { headers: { cookie: aliceCookie } })).json() as any;
    const completedRow = completedListing.sessions.find((s: any) => s.id === okBody.sessionId);
    expect(completedRow.status).toBe("completed");

    // Needs-input path
    const bobCookie = await loginAndCookie(ctx.app, ctx.userRepo, "bob", "bob-pass");
    ctx.deps.provider = { id: "test", modelName: "test", configured: true, complete: async (req) => req.schemaHint ? { text: JSON.stringify({ decisions: [] }) } : { text: "继续" } } satisfies ModelProvider;
    const needsInput = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json", cookie: bobCookie }, body: JSON.stringify({ message: "我最近做了几笔交易" }) });
    const needsInputBody = await needsInput.json() as any;
    expect(needsInputBody.status).toBe("needs_input");
    const needsInputListing = await (await ctx.app.request("/api/sessions", { headers: { cookie: bobCookie } })).json() as any;
    const needsInputRow = needsInputListing.sessions.find((s: any) => s.id === needsInputBody.sessionId);
    expect(needsInputRow.status).toBe("needs_input");
  });

  test("archive hides session from default list and unarchive restores it", async () => {
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "eleven", "eleven-pass");
    ctx.deps.provider = { id: "test", modelName: "test", configured: true, complete: async (req) => req.schemaHint ? { text: JSON.stringify({ decisions: [exactDecision] }) } : { text: "继续" } } satisfies ModelProvider;
    const created = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message: "买入 万科A" }) });
    const body = await created.json() as any;

    const beforeArchive = await (await ctx.app.request("/api/sessions", { headers: { cookie } })).json() as any;
    expect(beforeArchive.sessions.some((s: any) => s.id === body.sessionId)).toBe(true);

    const archive = await ctx.app.request(`/api/sessions/${body.sessionId}/archive`, { method: "POST", headers: { cookie } });
    expect(archive.status).toBe(200);
    const archivedBody = await archive.json() as any;
    expect(archivedBody.session.archivedAt).toBeTruthy();

    const afterArchive = await (await ctx.app.request("/api/sessions", { headers: { cookie } })).json() as any;
    expect(afterArchive.sessions.some((s: any) => s.id === body.sessionId)).toBe(false);

    const archiveView = await (await ctx.app.request("/api/sessions?archived=1", { headers: { cookie } })).json() as any;
    expect(archiveView.sessions.some((s: any) => s.id === body.sessionId)).toBe(true);

    const unarchive = await ctx.app.request(`/api/sessions/${body.sessionId}/unarchive`, { method: "POST", headers: { cookie } });
    expect(unarchive.status).toBe(200);
    const afterUnarchive = await (await ctx.app.request("/api/sessions", { headers: { cookie } })).json() as any;
    expect(afterUnarchive.sessions.some((s: any) => s.id === body.sessionId)).toBe(true);
  });

  test("soft delete hides session everywhere, even another user cannot read it", async () => {
    const aliceCookie = await loginAndCookie(ctx.app, ctx.userRepo, "alice", "alice-pass");
    const bobCookie = await loginAndCookie(ctx.app, ctx.userRepo, "bob", "bob-pass");
    ctx.deps.provider = { id: "test", modelName: "test", configured: true, complete: async (req) => req.schemaHint ? { text: JSON.stringify({ decisions: [exactDecision] }) } : { text: "继续" } } satisfies ModelProvider;
    const created = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json", cookie: aliceCookie }, body: JSON.stringify({ message: "买入 万科A" }) });
    const body = await created.json() as any;

    const deleted = await ctx.app.request(`/api/sessions/${body.sessionId}`, { method: "DELETE", headers: { cookie: aliceCookie } });
    expect(deleted.status).toBe(200);

    const listAfter = await (await ctx.app.request("/api/sessions", { headers: { cookie: aliceCookie } })).json() as any;
    expect(listAfter.sessions.some((s: any) => s.id === body.sessionId)).toBe(false);

    const archivedAfter = await (await ctx.app.request("/api/sessions?archived=1", { headers: { cookie: aliceCookie } })).json() as any;
    expect(archivedAfter.sessions.some((s: any) => s.id === body.sessionId)).toBe(false);

    const bobCannotRead = await ctx.app.request(`/api/sessions/${body.sessionId}`, { headers: { cookie: bobCookie } });
    expect(bobCannotRead.status).toBe(404);
    const bobCannotList = await (await ctx.app.request("/api/sessions", { headers: { cookie: bobCookie } })).json() as any;
    expect(bobCannotList.sessions.some((s: any) => s.id === body.sessionId)).toBe(false);
  });

  test("session actions are user-scoped — alice cannot archive or delete bob's session", async () => {
    const aliceCookie = await loginAndCookie(ctx.app, ctx.userRepo, "alice", "alice-pass");
    const bobCookie = await loginAndCookie(ctx.app, ctx.userRepo, "bob", "bob-pass");
    ctx.deps.provider = { id: "test", modelName: "test", configured: true, complete: async (req) => req.schemaHint ? { text: JSON.stringify({ decisions: [exactDecision] }) } : { text: "继续" } } satisfies ModelProvider;
    const created = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json", cookie: bobCookie }, body: JSON.stringify({ message: "买入 万科A" }) });
    const body = await created.json() as any;

    expect((await ctx.app.request(`/api/sessions/${body.sessionId}/archive`, { method: "POST", headers: { cookie: aliceCookie } })).status).toBe(404);
    expect((await ctx.app.request(`/api/sessions/${body.sessionId}`, { method: "PATCH", headers: { "content-type": "application/json", cookie: aliceCookie }, body: JSON.stringify({ title: "hijack" }) })).status).toBe(404);
    expect((await ctx.app.request(`/api/sessions/${body.sessionId}`, { method: "DELETE", headers: { cookie: aliceCookie } })).status).toBe(404);
    const bobRestored = await (await ctx.app.request(`/api/sessions/${body.sessionId}`, { headers: { cookie: bobCookie } })).json() as any;
    expect(bobRestored.session.title).toContain("万科A");
  });

  test("deriveSessionTitle covers all branches", () => {
    expect(ReviewRepository.deriveSessionTitle([])).toBe("");
    expect(ReviewRepository.deriveSessionTitle([{ symbol: "万科A" }])).toBe("万科A 决策复盘");
    expect(ReviewRepository.deriveSessionTitle([{ symbol: "万科A" }, { symbol: "一鸣食品" }])).toBe("万科A / 一鸣食品 复盘");
    expect(ReviewRepository.deriveSessionTitle([{ symbol: "万科A" }, { symbol: "万科A" }, { symbol: "一鸣食品" }])).toBe("万科A / 一鸣食品 复盘");
    expect(ReviewRepository.deriveSessionTitle([{ symbol: "万科A", name: "万科企业A" }, { symbol: "X", name: "一鸣食品" }])).toBe("万科企业A / 一鸣食品 复盘");
    expect(ReviewRepository.deriveSessionTitle([{ symbol: "  " }, { symbol: "" }])).toBe("");
  });
});
