import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { makeTestServer, type TestServer } from "./helpers.ts";
import { DecisionReviewAgent } from "../src/agents/decision-review.ts";
import type { DecisionInput } from "../src/types/index.ts";

const baseDecision: DecisionInput = {
  symbol: "600519",
  market: "CN",
  action: "buy",
  executedAt: "2024-03-15T00:00:00Z",
  price: 1620.5,
  quantity: 100,
  userReason: "Strong channel checks pre-T0; brand pricing power intact.",
};

describe("Decision Review Agent — vertical slice scenarios", () => {
  let ctx: TestServer;

  beforeEach(() => {
    ctx = makeTestServer();
  });
  afterEach(() => ctx.cleanup());

  test("normal path runs to completion with structured result", async () => {
    const id = `rev_${crypto.randomUUID()}`;
    ctx.repo.createRun(id, baseDecision, baseDecision.executedAt);

    const agent = new DecisionReviewAgent(ctx.deps);
    const outcome = await agent.run(id, baseDecision);

    const statuses = outcome.result.toolStatuses.map((s) => s.status);
    expect(statuses).toContain("success");

    expect(outcome.result.decisionQuality).toBeDefined();
    expect(outcome.result.outcome).toBeDefined();

    const t0 = Date.parse(outcome.result.decision.T0);
    for (const e of outcome.result.exAnteEvidence) {
      expect(Date.parse(e.publishedAt)).toBeLessThanOrEqual(t0);
    }
    for (const e of outcome.result.exPostEvidence) {
      expect(Date.parse(e.publishedAt)).toBeGreaterThan(t0);
    }

    const events = ctx.repo.getEvents(id);
    for (const e of events) {
      expect([
        "review_created",
        "market_data_retrieved",
        "index_sector_context_retrieved",
        "news_events_retrieved",
        "evidence_time_aligned",
        "fact_consistency_checked",
        "final_review_generated",
        "tool_status",
        "reflection",
        "error",
      ]).toContain(e.kind);
    }
  });

  test("empty MCP result → review lands as partial, no fabricated evidence", async () => {
    const id = `rev_${crypto.randomUUID()}`;
    ctx.repo.createRun(id, baseDecision, baseDecision.executedAt);
    const agent = new DecisionReviewAgent(ctx.deps);

    const outcome = await agent.run(id, baseDecision, { simulateEmpty: true });

    const statuses = outcome.result.toolStatuses.map((s) => s.status);
    expect(statuses.every((s) => s === "empty")).toBe(true);
    expect(outcome.result.exAnteEvidence).toEqual([]);
    expect(outcome.result.exPostEvidence).toEqual([]);
    expect(outcome.result.uncertainties.length).toBeGreaterThan(0);

    const run = ctx.repo.getRun(id);
    expect(run?.status).toBe("partial");
  });

  test("transient failure → review lands as partial without translating to 'no data'", async () => {
    const id = `rev_${crypto.randomUUID()}`;
    ctx.repo.createRun(id, baseDecision, baseDecision.executedAt);
    const agent = new DecisionReviewAgent(ctx.deps);

    const outcome = await agent.run(id, baseDecision, { simulateTransientFailure: true });

    const statuses = outcome.result.toolStatuses.map((s) => s.status);
    expect(statuses.every((s) => s === "transient_error")).toBe(true);
    expect(outcome.result.exAnteEvidence).toEqual([]);
    expect(outcome.result.exPostEvidence).toEqual([]);
    expect(
      outcome.result.uncertainties.some((u) => /transient/i.test(u))
    ).toBe(true);

    const run = ctx.repo.getRun(id);
    expect(run?.status).toBe("partial");
  });

  test("reflection flags overconfidence in user reason", async () => {
    const id = `rev_${crypto.randomUUID()}`;
    const decision: DecisionInput = {
      ...baseDecision,
      userReason: "I am certain this will outperform — definitely a buy.",
    };
    ctx.repo.createRun(id, decision, decision.executedAt);
    const agent = new DecisionReviewAgent(ctx.deps);

    const outcome = await agent.run(id, decision);
    const labels = outcome.result.biases.map((b) => b.label);
    expect(labels).toContain("overconfidence-language");
  });

  test("invalid structured judgment never fabricates supported attribution", async () => {
    const id = `rev_${crypto.randomUUID()}`;
    ctx.repo.createRun(id, baseDecision, baseDecision.executedAt);
    ctx.deps.provider = { id: "invalid", modelName: "invalid", configured: true, complete: async () => ({ text: "not-json" }) };
    const outcome = await new DecisionReviewAgent(ctx.deps).run(id, baseDecision);
    expect(outcome.result.attribution).toEqual([]);
    expect(outcome.result.decisionQuality.rating).toBe("insufficient");
    expect(outcome.result.uncertainties.some((item) => /missing or invalid JSON/i.test(item))).toBe(true);
    expect(ctx.repo.getRun(id)?.status).toBe("partial");
  });

  test("nonexistent evidence IDs are rejected and do not become supported claims", async () => {
    const id = `rev_${crypto.randomUUID()}`;
    ctx.repo.createRun(id, baseDecision, baseDecision.executedAt);
    ctx.deps.provider = { id: "ungrounded", modelName: "ungrounded", configured: true, complete: async () => ({ text: JSON.stringify({ rating: "good", verdict: "looks good", attribution: [{ claim: "unsupported claim", status: "supported", evidenceIds: ["does-not-exist"] }] }) }) };
    const outcome = await new DecisionReviewAgent(ctx.deps).run(id, baseDecision);
    expect(outcome.result.attribution).toEqual([]);
    expect(outcome.result.citations.every((citation) => outcome.result.exAnteEvidence.some((evidence) => evidence.id === citation.evidenceId))).toBe(true);
    expect(outcome.result.uncertainties.some((item) => /outside the ex-ante set|No model attribution/i.test(item))).toBe(true);
    expect(ctx.repo.getRun(id)?.status).toBe("partial");
  });

  test("missing rating is insufficient rather than fair-by-evidence-count", async () => {
    const id = `rev_${crypto.randomUUID()}`;
    ctx.repo.createRun(id, baseDecision, baseDecision.executedAt);
    ctx.deps.provider = { id: "no-rating", modelName: "no-rating", configured: true, complete: async () => ({ text: JSON.stringify({ verdict: "evidence exists", attribution: [] }) }) };
    const outcome = await new DecisionReviewAgent(ctx.deps).run(id, baseDecision);
    expect(outcome.result.decisionQuality.rating).toBe("insufficient");
    expect(outcome.result.decisionQuality.rating).not.toBe("fair");
    expect(outcome.result.uncertainties.some((item) => /valid rating/i.test(item))).toBe(true);
    expect(ctx.repo.getRun(id)?.status).toBe("partial");
  });
});
