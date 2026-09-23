/**
 * ELI-355 regressions — conversation routing, capability status answers,
 * chain-of-thought hygiene, and web-session E2E through the review agent.
 *
 * Acceptance covered:
 *  - P0/first-turn: a trade narrative sent via POST /messages on a session
 *    with no structured decisions must enter extraction → confirmation state,
 *    never a generic follow-up chat reply.
 *  - capability questions ("MCP 能不能用 / Fuyao 能用吗 / iFinD 能用吗") are
 *    answered from runtime status, never the generic LLM, never ask for a
 *    structured-data template, never expose secrets, and work on an empty
 *    session.
 *  - raw chain-of-thought from the provider never reaches stored or returned
 *    conversation content.
 *  - after a confirmed review the session's activities (tool_started /
 *    tool_completed / evidence_retrieved) coexist with the persisted assistant
 *    summary, and follow-ups are grounded in results without invoking MCP.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loginAndCookie, makeTestServer, type TestServer } from "./helpers.ts";
import type { ModelProvider } from "../src/providers/index.ts";
import { stripChainOfThought } from "../src/lib/chain-of-thought.ts";
import { detectCapabilityQuestion, buildRuntimeStatus, formatRuntimeStatusMessage } from "../src/lib/capability-status.ts";

const narrative =
  "我昨天下午 2:34 挂的限价单，16.57 卖掉了金牛化工 2 手；尾盘集合竞价全仓买了中粮糖业。";

function readyDecision(over: Record<string, unknown> = {}) {
  return {
    symbol: "金牛化工", name: "金牛化工", action: "sell", market: "CN",
    executedAt: "2025-03-17T14:34:00+08:00", executedAtText: "昨天下午2:34左右",
    timePrecision: "exact" as const, price: 16.57, quantityShares: 200,
    quantityText: "2手", rationale: "", notes: "", confidence: 0.92,
    needsConfirmation: [], ...over,
  };
}

describe("ELI-355 conversation routing", () => {
  let ctx: TestServer;
  beforeEach(() => { ctx = makeTestServer(); });
  afterEach(() => ctx.cleanup());

  test("first trade message via /messages routes into extraction + confirmation state, not generic chat", async () => {
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "routing", "routing-pass");
    const calls: string[] = [];
    ctx.deps.provider = {
      id: "test", modelName: "test", configured: true,
      complete: async (req) => {
        calls.push(req.schemaHint || "follow-up");
        if (req.schemaHint === "DecisionExtractionResult") {
          return { text: JSON.stringify({ decisions: [readyDecision()] }) };
        }
        throw new Error("generic follow-up must not run on an empty-decision session");
      },
    } satisfies ModelProvider;

    // A session that fell into needs_input has zero persisted decisions.
    ctx.deps.provider.complete = async (req: any) => {
      calls.push(req.schemaHint || "follow-up");
      return { text: JSON.stringify({ decisions: [] }) };
    };
    const created = await ctx.app.request("/api/sessions", {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ message: "我最近做了几笔交易，帮我一起复盘这些决策。", clientNow: "2025-03-18T09:00:00+08:00", timezone: "Asia/Shanghai" }),
    });
    const createdBody = await created.json() as any;
    expect(createdBody.status).toBe("needs_input");
    expect(createdBody.decisions).toHaveLength(0);

    // The user now sends the actual trade as the next message (not an edit).
    ctx.deps.provider.complete = async (req: any) => {
      calls.push(req.schemaHint || "follow-up");
      if (req.schemaHint === "DecisionExtractionResult") return { text: JSON.stringify({ decisions: [readyDecision()] }) };
      throw new Error("generic follow-up must not run on the first-turn narrative");
    };
    const sent = await ctx.app.request(`/api/sessions/${createdBody.sessionId}/messages`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ content: narrative, clientNow: "2025-03-18T09:00:00+08:00", timezone: "Asia/Shanghai" }),
    });
    expect(sent.status).toBe(201);
    const body = await sent.json() as any;
    expect(body.status).toBe("accepted");
    expect(body.decisions).toHaveLength(1);
    expect(body.decisions[0]).toMatchObject({ symbol: "金牛化工", timePrecision: "exact" });
    expect(body.messages.some((m: any) => m.role === "status" && m.content.includes("已识别 1 笔决策"))).toBe(true);
const users = body.messages.filter((m: any) => m.role === "user");
    expect(users.at(-1).state).toBe("accepted");
    expect(users.at(-1).content).toContain("金牛化工");
    expect(calls).toEqual(["DecisionExtractionResult", "DecisionExtractionResult"]);
    const fresh = await (await ctx.app.request(`/api/sessions/${createdBody.sessionId}`, { headers: { cookie } })).json() as any;
    expect(fresh.session.status).toBe("draft");
    expect(fresh.decisions).toHaveLength(1);
  });

  test("capability question on empty session answers from runtime status, never the LLM, no secrets, no template demand", async () => {
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "capability", "capability-pass");
    let calls = 0;
    ctx.deps.provider = {
      id: "test", modelName: "test", configured: true,
      complete: async () => { calls += 1; return { text: "不应被调用" }; },
    } satisfies ModelProvider;

    // Configure cleanly: fuyao fully provisioned but unverified; iFinD has
    // credentials but no tool map; the answers must never echo any of this.
    ctx.cfg.fuyao = { ...ctx.cfg.fuyao, baseUrl: "https://secret-fuyao.invalid", apiKey: "FUYAO_KEY_XYZZY", toolMap: { price: "get_share_price" } };
    ctx.cfg.ifind = { ...ctx.cfg.ifind, baseUrl: "https://secret-ifind.invalid", authorization: "IFIND_AUTH_XYZZY", toolMap: {} };

    const sessionId = ctx.repo.createSession(ctx.userRepo.findByUsername("capability")!.id, "空会话", "single");
    const res = await ctx.app.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ content: "你MCP能不能用啊？" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.status).toBe("answered");
    expect(calls).toBe(0);
    const content = body.message.content;
    expect(content).toContain("Fuyao");
    expect(content).toContain("iFinD");
    expect(content).toContain("已配置");
    expect(content).toContain("未进行实际连接验证");
    expect(content).toContain("缺少工具映射");
    expect(content).not.toContain("FUYAO_KEY_XYZZY");
    expect(content).not.toContain("IFIND_AUTH_XYZZY");
    expect(content).not.toContain("https://secret-fuyao.invalid");
    expect(content).not.toContain("https://secret-ifind.invalid");
    expect(content).not.toContain("我不能直接调用外部工具");
    expect(content).not.toContain("结构化数据");
    // The user question is persisted so the thread stays coherent.
    expect(body.messages.some((m: any) => m.role === "user" && m.state === "accepted")).toBe(true);
  });

  test("raw chain-of-thought from the provider is never persisted or returned", async () => {
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "cot", "cot-pass");
    const secret = "COT_REASONING_886";
    ctx.deps.provider = {
      id: "test", modelName: "test", configured: true,
      complete: async (req) => req.schemaHint
        ? { text: JSON.stringify({ decisions: [readyDecision()] }) }
        : { text: `final answer line one.\n\n<thinking>${secret} 每股盈利预测的详细推演过程</thinking>\n\nfinal answer line two.` },
    } satisfies ModelProvider;
    const created = await ctx.app.request("/api/sessions", {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ message: narrative, clientNow: "2025-03-18T09:00:00+08:00", timezone: "Asia/Shanghai" }),
    });
    const createdBody = await created.json() as any;
    const sent = await ctx.app.request(`/api/sessions/${createdBody.sessionId}/messages`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ content: "继续追问一下决策质量。" }),
    });
    expect(sent.status).toBe(201);
    const body = await sent.json() as any;
    expect(body.message.content).not.toContain(secret);
    expect(body.message.content).toContain("final answer line one.");
    expect(body.message.content).toContain("final answer line two.");
    const fresh = await (await ctx.app.request(`/api/sessions/${createdBody.sessionId}`, { headers: { cookie } })).json() as any;
    expect(JSON.stringify(fresh.messages)).not.toContain(secret);
  });

  test("confirmed review persists assistant summary AND tool activities; follow-up is grounded and MCP-free", async () => {
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "e2e", "e2e-pass");
    let mcpFetchCount = 0;
    ctx.deps.registry = {
      configuredKeys: () => ["a-share"],
      resolve: () => null,
      resolveFor: () => [
        {
          serverKey: "a-share", provider: "fuyao", canHandle: () => true,
          fetch: async () => {
            mcpFetchCount += 1;
            return {
              status: "success", retrievedAt: new Date().toISOString(),
              data: [{ id: "e2e-evidence", type: "news", title: "T0 前事实", content: "可核验的事前证据。", source: "ifind:stock:announcement", publishedAt: "2025-03-10T00:00:00Z", retrievedAt: new Date().toISOString(), relationToDecision: "ex_ante" }],
            };
          },
        },
      ],
    };
    ctx.deps.provider = {
      id: "test", modelName: "test", configured: true,
      complete: async (req) => {
        if (req.schemaHint === "DecisionExtractionResult") return { text: JSON.stringify({ decisions: [readyDecision()] }) };
        if (!req.schemaHint) return { text: "基于当前结果中的 T0 前证据回答追问，不渲染思考过程。" };
        return { text: JSON.stringify({ rating: "good", verdict: "T0 前证据支持该判断。", lessons: ["记录反向证据。"], attribution: [{ claim: "T0 前证据支持判断", status: "supported", evidenceIds: ["e2e-evidence"] }] }) };
      },
    } satisfies ModelProvider;

    const sessionId = ctx.repo.createSession(ctx.userRepo.findByUsername("e2e")!.id, "E2E 复盘", "single");
    const sent = await ctx.app.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ content: narrative, clientNow: "2025-03-18T09:00:00+08:00", timezone: "Asia/Shanghai" }),
    });
    const sentBody = await sent.json() as any;
    expect(sentBody.status).toBe("accepted");
    expect(sentBody.decisions).toHaveLength(1);
    expect(mcpFetchCount).toBe(0);

    const confirmed = await ctx.app.request(`/api/sessions/${sessionId}/confirm`, { method: "POST", headers: { cookie } });
    expect(confirmed.status).toBe(202);
    expect(mcpFetchCount).toBeGreaterThan(0);

    const restored = await (await ctx.app.request(`/api/sessions/${sessionId}`, { headers: { cookie } })).json() as any;
    expect(restored.session.status).toBe("completed");
    const assistantMessage = restored.messages.find((m: any) => m.role === "assistant");
    expect(assistantMessage).toBeTruthy();
    expect(assistantMessage.content).toContain("这次复盘已完成");
expect(restored.activities.some((a: any) => a.type === "tool_completed" || a.type === "tool_updated")).toBe(true);
    expect(restored.activities.some((a: any) => a.type === "reasoning_summary" || a.type === "terminal_status")).toBe(true);
    expect(JSON.stringify(restored.activities)).not.toMatch(/COT_REASONING|secret|api[-_ ]?key/i);

    // Follow-up is grounded (results present) and does NOT invoke MCP.
    const before = mcpFetchCount;
    const followUp = await ctx.app.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ content: "继续" }),
    });
    expect(followUp.status).toBe(201);
    const followUpBody = await followUp.json() as any;
    expect(followUpBody.message.role).toBe("assistant");
    expect(followUpBody.message.content).toContain("T0 前证据");
    expect(mcpFetchCount).toBe(before);
  });
});

describe("ELI-355 capability detection + status builder unit", () => {
  test("detectCapabilityQuestion fires only on capability+status intent", () => {
    expect(detectCapabilityQuestion("你MCP能不能用啊？")).toBe(true);
    expect(detectCapabilityQuestion("MCP能不能用")).toBe(true);
    expect(detectCapabilityQuestion("Fuyao 能用吗")).toBe(true);
    expect(detectCapabilityQuestion("iFinD 能用吗")).toBe(true);
    expect(detectCapabilityQuestion("工具能不能用")).toBe(true);
    expect(detectCapabilityQuestion("数据源可用吗")).toBe(true);
    expect(detectCapabilityQuestion("继续")).toBe(false);
    expect(detectCapabilityQuestion("当前最重要的反向证据是什么？")).toBe(false);
    expect(detectCapabilityQuestion("复盘里怎么看决策质量")).toBe(false);
    expect(detectCapabilityQuestion("把昨天买入的创新药持仓加入复盘。")).toBe(false);
  });

  test("formatRuntimeStatusMessage never includes secrets, URLs, or tool names", () => {
    const cfg = makeTestConfigWithSecrets();
    const status = buildRuntimeStatus({ config: cfg, provider: null });
    const zh = formatRuntimeStatusMessage(status, "Fuyao 能用吗");
    expect(zh).toContain("已配置");
    expect(zh).toContain("未进行实际连接验证");
    expect(zh).not.toContain("FUYAO_KEY_XYZZY");
    expect(zh).not.toContain("IFIND_AUTH_XYZZY");
    expect(zh).not.toContain("https://secret-fuyao.invalid");
    expect(zh).not.toContain("https://secret-ifind.invalid");
    expect(zh).not.toContain("get_share_price");
    expect(zh).not.toMatch(/baseUrl|apiKey|authorization/i);
    const en = formatRuntimeStatusMessage(status, "Can you use MCP?");
    expect(en).toMatch(/ready|config/i);
  });

test("stripChainOfThought removes XML and fenced CoT, keeps visible content", () => {
    const xml = stripChainOfThought("before <thinking>hidden</thinking> after");
    expect(xml).not.toContain("hidden");
    expect(xml.replace(/\s+/g, " ").trim()).toBe("before after");
    const fenced = stripChainOfThought("a\n```think\nhidden\n```\nb");
    expect(fenced).not.toContain("hidden");
    expect(fenced).toContain("a");
    expect(fenced).toContain("b");
    expect(stripChainOfThought("plain text")).toBe("plain text");
  });
});

function makeTestConfigWithSecrets() {
  const base = makeTestServer();
  try {
    base.cfg.fuyao = {
      ...base.cfg.fuyao,
      baseUrl: "https://secret-fuyao.invalid",
      apiKey: "FUYAO_KEY_XYZZY",
      toolMap: { price: "get_share_price" },
      servers: ["a-share"],
    };
    base.cfg.ifind = {
      ...base.cfg.ifind,
      baseUrl: "https://secret-ifind.invalid",
      authorization: "IFIND_AUTH_XYZZY",
      toolMap: {},
      servers: ["stock"],
    };
    return base.cfg;
  } finally {
    base.cleanup();
  }
}
