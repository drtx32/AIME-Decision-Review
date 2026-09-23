import { describe, expect, test } from "bun:test";
import { DecisionExtractorAgent } from "../src/agents/decision-extractor.ts";
import type { ModelProvider } from "../src/providers/index.ts";

describe("DecisionExtractorAgent", () => {
  test("parses reasoning-model output and preserves one entry per repeated order attempt", async () => {
    let request: any;
    const decisions = [
      { symbol: "000002.SZ", name: "万科A", action: "buy", market: "CN", executedAt: "2026-09-22T13:37:00+08:00", executedAtText: "昨天下午1:37", timePrecision: "exact", price: 13.7, quantityShares: 2000, quantityText: "20手", rationale: "", notes: "", confidence: 0.97, needsConfirmation: [] },
      { symbol: "605338.SH", name: "一鸣食品", action: "sell", market: "CN", executedAt: null, executedAtText: "今天早上", timePrecision: "approximate", price: null, quantityShares: 800, quantityText: "八手", rationale: "跌破均价线", notes: "", confidence: 0.85, needsConfirmation: ["确认成交时间"] },
      { symbol: "600825.SH", name: "新华传媒", action: "buy", market: "CN", executedAt: null, executedAtText: "第一天", timePrecision: "approximate", price: null, quantityShares: null, quantityText: null, rationale: "", notes: "attempted unfilled order", confidence: 0.9, needsConfirmation: ["确认挂单记录"] },
      { symbol: "600825.SH", name: "新华传媒", action: "buy", market: "CN", executedAt: null, executedAtText: "第二天", timePrecision: "approximate", price: null, quantityShares: null, quantityText: null, rationale: "", notes: "attempted unfilled order", confidence: 0.9, needsConfirmation: ["确认挂单记录"] },
      { symbol: "600825.SH", name: "新华传媒", action: "buy", market: "CN", executedAt: null, executedAtText: "第三天", timePrecision: "approximate", price: null, quantityShares: null, quantityText: null, rationale: "", notes: "attempted unfilled order", confidence: 0.9, needsConfirmation: ["确认挂单记录"] },
    ];
    const provider: ModelProvider = {
      id: "test", modelName: "test", configured: true,
      complete: async (req) => {
        request = req;
        return { text: `<think>reasoning before the structured answer</think>\n${JSON.stringify({ decisions })}` };
      },
    };

    const result = await new DecisionExtractorAgent(provider, "test").extract("连续三天排了新华传媒，但是排板都排不上。", {
      clientNow: "2026-09-23T08:00:00Z", timezone: "Asia/Shanghai",
    });

    expect(request.maxOutputTokens).toBe(4096);
    expect(result).toHaveLength(5);
    expect(result.filter((item) => item.symbol === "600825.SH")).toHaveLength(3);
    expect(result.filter((item) => item.symbol === "600825.SH").every((item) => item.executedAt === null)).toBe(true);
    expect(result[0].quantityShares).toBe(2000);
    expect(result[1].quantityShares).toBe(800);
  });
});
