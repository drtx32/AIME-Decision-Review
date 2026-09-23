import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loginAndCookie, makeTestServer, type TestServer } from "./helpers.ts";
import type { ModelProvider } from "../src/providers/index.ts";

const narrative = "昨天我下午1:37的时候，以13.70买了万科A 20手。今天早上在一鸣食品拉伸后又跌破当日的均价线的位置，出掉了八手。连续三天排了新华传媒，但是排板都排不上。";

const extracted = {
  decisions: [
    { symbol: "000002.SZ", name: "万科A", action: "buy", market: "CN", executedAt: "2026-09-22T13:37:00+08:00", executedAtText: "昨天我下午1:37", timePrecision: "exact", price: 13.7, quantityShares: 2000, quantityText: "20手", rationale: "", notes: "executed trade", confidence: 0.97, needsConfirmation: [] },
    { symbol: "605338.SH", name: "一鸣食品", action: "sell", market: "CN", executedAt: null, executedAtText: "今天早上跌破当日均价线后", timePrecision: "approximate", price: null, quantityShares: 800, quantityText: "八手", rationale: "均价线下破触发卖出", notes: "executed sell; exact time and price unresolved", confidence: 0.85, needsConfirmation: ["确认成交时间和价格"] },
    { symbol: "600825.SH", name: "新华传媒", action: "buy", market: "CN", executedAt: null, executedAtText: "第一天", timePrecision: "approximate", price: null, quantityShares: null, quantityText: null, rationale: "", notes: "order attempt; unfilled; no position", confidence: 0.9, needsConfirmation: ["确认第一天挂单记录"] },
    { symbol: "600825.SH", name: "新华传媒", action: "buy", market: "CN", executedAt: null, executedAtText: "第二天", timePrecision: "approximate", price: null, quantityShares: null, quantityText: null, rationale: "", notes: "order attempt; unfilled; no position", confidence: 0.9, needsConfirmation: ["确认第二天挂单记录"] },
    { symbol: "600825.SH", name: "新华传媒", action: "buy", market: "CN", executedAt: null, executedAtText: "第三天", timePrecision: "approximate", price: null, quantityShares: null, quantityText: null, rationale: "", notes: "order attempt; unfilled; no position", confidence: 0.9, needsConfirmation: ["确认第三天挂单记录"] },
  ],
};

describe("ELI-343 final combined narrative API regression", () => {
  let ctx: TestServer;
  beforeEach(() => { ctx = makeTestServer(); });
  afterEach(() => ctx.cleanup());

  test("persists 3 securities and 5 events without turning unfilled orders into positions", async () => {
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "combined", "combined-pass");
    let extractionInput = "";
    ctx.deps.provider = {
      id: "fixture", modelName: "fixture", configured: true,
      complete: async (request) => {
        extractionInput = request.user;
        return { text: JSON.stringify(extracted) };
      },
    } satisfies ModelProvider;

    const response = await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ message: narrative, clientNow: "2026-09-23T08:00:00Z", timezone: "Asia/Shanghai" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as any;
    const decisions = body.decisions as any[];

    expect(JSON.parse(extractionInput).message).toBe(narrative);
    expect(JSON.parse(extractionInput).clientNow).toBe("2026-09-23T08:00:00Z");
    expect(JSON.parse(extractionInput).timezone).toBe("Asia/Shanghai");
    expect(decisions).toHaveLength(5);
    expect(new Set(decisions.map((item) => item.symbol))).toEqual(new Set(["000002.SZ", "605338.SH", "600825.SH"]));

    const vanke = decisions.find((item) => item.symbol === "000002.SZ");
    expect(vanke).toMatchObject({ action: "buy", executedAt: "2026-09-22T13:37:00+08:00", timePrecision: "exact", price: 13.7, quantityShares: 2000, quantityText: "20手" });

    const yiming = decisions.find((item) => item.symbol === "605338.SH");
    expect(yiming).toMatchObject({ action: "sell", executedAt: null, timePrecision: "approximate", price: null, quantityShares: 800, quantityText: "八手" });

    const attempts = decisions.filter((item) => item.symbol === "600825.SH");
    expect(attempts).toHaveLength(3);
    expect(attempts.every((item) => item.action === "buy" && item.executedAt === null && item.timePrecision === "approximate" && item.price === null && item.quantityShares === null && /unfilled/.test(item.notes))).toBe(true);
  });
});
