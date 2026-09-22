import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeTestServer, type TestServer } from "./helpers.ts";
import type { ModelProvider } from "../src/providers/index.ts";

describe("Conversation session contract", () => {
  let ctx: TestServer;
  beforeEach(() => { ctx = makeTestServer(); });
  afterEach(() => ctx.cleanup());

  test("persists multi-decision extraction and isolates sessions by user", async () => {
    const created = await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "alice" },
      body: JSON.stringify({ message: "我今天卖了金牛化工，又买了 XX，还加仓了 YY，帮我一起复盘。" }),
    });
    expect(created.status).toBe(201);
    const body = await created.json() as { sessionId: string; decisions: Array<{ symbol: string; action: string; executedAt: string }> };
    expect(body.decisions.length).toBe(3);
    expect(body.decisions.map((d) => d.action)).toEqual(["sell", "buy", "buy"]);
    expect(new Set(body.decisions.map((d) => d.executedAt)).size).toBe(3);
    const hidden = await ctx.app.request(`/api/sessions/${body.sessionId}`, { headers: { "x-user-id": "bob" } });
    expect(hidden.status).toBe(404);
  });

  test("returns canonical unavailable for confirm and follow-up without a model", async () => {
    const created = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "买入 600519" }) });
    const { sessionId } = await created.json() as { sessionId: string };
    const confirm = await ctx.app.request(`/api/sessions/${sessionId}/confirm`, { method: "POST" });
    expect(confirm.status).toBe(503);
    expect(await confirm.json()).toEqual({ error: "MODEL_NOT_CONFIGURED", message: "当前未配置可用的大模型服务，请联系管理员。" });
    const followUp = await ctx.app.request(`/api/sessions/${sessionId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "为什么？" }) });
    expect(followUp.status).toBe(503);
  });

  test("sends follow-up through the configured provider and persists the response", async () => {
    const provider: ModelProvider = { id: "test", modelName: "test", configured: true, complete: async () => ({ text: "基于当前 session 的证据，建议先检查失效条件。" }) };
    ctx.deps.provider = provider;
    const created = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "买入 600519" }) });
    const { sessionId } = await created.json() as { sessionId: string };
    const response = await ctx.app.request(`/api/sessions/${sessionId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "当前最重要的反向证据是什么？" }) });
    expect(response.status).toBe(201);
    const message = (await response.json() as { message: { role: string; content: string } }).message;
    expect(message.role).toBe("assistant");
    expect(message.content).toContain("当前 session");
    const restored = await ctx.app.request(`/api/sessions/${sessionId}`);
    expect((await restored.json() as { messages: Array<{ role: string }> }).messages.some((item) => item.role === "assistant")).toBe(true);
  });
});
