import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeTestServer, type TestServer } from "./helpers.ts";
import type { ModelProvider } from "../src/providers/index.ts";

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
    const calls: string[] = [];
    ctx.deps.provider = { id: "test", modelName: "test", configured: true, complete: async (req) => { calls.push(req.schemaHint || "followup"); return req.schemaHint ? { text: JSON.stringify(extraction) } : { text: "基于当前 session 的证据回答。" }; } } satisfies ModelProvider;
    const created = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json", "x-user-id": "alice" }, body: JSON.stringify({ message: "昨天我卖掉了金牛化工，大概是下午2:34左右，是通过午间休市的时候挂的限价单，16.57卖的，然后卖了2手。同时尾盘集合竞价又买了中粮糖业。全仓买入，第二天早上，也就是今天卖掉了，差不多亏了零点几个点就跑了。", clientNow: "2025-03-18T09:00:00+08:00", timezone: "Asia/Shanghai" }) });
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
    const hidden = await ctx.app.request(`/api/sessions/${body.sessionId}`, { headers: { "x-user-id": "bob" } });
    expect(hidden.status).toBe(404);
  });

  test("no model cannot create a session or fake decisions", async () => {
    const response = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "买入 600519" }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "MODEL_NOT_CONFIGURED", message: "当前未配置可用的大模型服务，请联系管理员。" });
    expect(ctx.repo.listSessions("dev-user")).toHaveLength(0);
  });

  test("requires an actual T0 before review and sends follow-up through provider", async () => {
    let call = 0;
    const provider: ModelProvider = { id: "test", modelName: "test", configured: true, complete: async (req) => { call += 1; return req.schemaHint ? { text: JSON.stringify({ decisions: [{ ...extraction.decisions[2] }] }) } : { text: "基于当前 session 的证据，建议先检查失效条件。" }; } };
    ctx.deps.provider = provider;
    const created = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "今天卖出中粮糖业" }) });
    const { sessionId } = await created.json() as { sessionId: string };
    const confirm = await ctx.app.request(`/api/sessions/${sessionId}/confirm`, { method: "POST" });
    expect(confirm.status).toBe(422);
    const update = await ctx.app.request(`/api/sessions/${sessionId}/decisions/${(await ctx.repo.listSessionDecisions(sessionId, "dev-user"))[0].id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ executedAt: "2025-03-18T09:00:00+08:00", timePrecision: "exact" }) });
    expect(update.status).toBe(200);
    const response = await ctx.app.request(`/api/sessions/${sessionId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "当前最重要的反向证据是什么？" }) });
    expect(response.status).toBe(201);
    expect((await response.json() as any).message.content).toContain("当前 session");
    expect(call).toBe(2);
  });
});
