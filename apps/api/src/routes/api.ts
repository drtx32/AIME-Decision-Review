/**
 * Hono routes — /api/reviews/* + /health.
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { DecisionInputSchema, type DecisionInput } from "../types/index.ts";
import type { AppConfig } from "../config.ts";
import type { ReviewRepository } from "../db/sqlite.ts";
import type { McpRegistry } from "../mcp/registry.ts";
import { DecisionReviewAgent } from "../agents/decision-review.ts";
import { DecisionExtractorAgent } from "../agents/decision-extractor.ts";
import type { ModelProvider } from "../providers/index.ts";

export interface RouteDeps {
  config: AppConfig;
  repo: ReviewRepository;
  registry: McpRegistry;
  provider: ModelProvider;
  /** Test hook — bypass background execution so specs stay deterministic. */
  runSync?: boolean;
}

const MODEL_UNAVAILABLE_MESSAGE = "当前未配置可用的大模型服务，请联系管理员。";
const userIdFor = (c: any) => c.req.header("x-user-id")?.trim() || "dev-user";

export function buildApi(deps: RouteDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      provider: deps.provider.id,
      provider_configured: deps.provider.configured,
      provider_status: deps.provider.configured ? "ready" : "unconfigured",
      configuredServers: deps.registry.configuredKeys(),
      time: new Date().toISOString(),
    });
  });

  // Conversation-first surface. The user id is intentionally supplied by the
  // authenticated edge in production; the dev fallback keeps the local MVP usable.
  app.get("/api/sessions", (c) => c.json({ sessions: deps.repo.listSessions(userIdFor(c)) }));

  app.post("/api/sessions", async (c) => {
    const body = await c.req.json().catch(() => null) as { message?: string; scope?: string; clientNow?: string; timezone?: string } | null;
    const message = body?.message?.trim();
    if (!message) return c.json({ error: "invalid_input", message: "请输入一段历史决策描述。" }, 400);
    if (!deps.provider.configured) return c.json({ error: "MODEL_NOT_CONFIGURED", message: MODEL_UNAVAILABLE_MESSAGE }, 503);
    const userId = userIdFor(c);
    let decisions;
    try {
      decisions = await new DecisionExtractorAgent(deps.provider, deps.config.llm.extractorModel).extract(message, { clientNow: body?.clientNow || new Date().toISOString(), timezone: body?.timezone || "UTC" });
    } catch {
      return c.json({ error: "DECISION_EXTRACTION_FAILED", message: "无法可靠识别决策，请补充标的、方向与成交时间后重试。" }, 422);
    }
    const sessionId = deps.repo.createSession(userId, decisions.length > 1 ? `${decisions.length} 笔投资决策` : `${decisions[0]?.symbol ?? "新"} 决策复盘`, body?.scope ?? (decisions.length > 1 ? "custom" : "single"));
    deps.repo.addMessage(sessionId, userId, "user", message);
    const stored = decisions.map((decision) => deps.repo.addSessionDecision({ ...decision, quantity: decision.quantityShares, reason: decision.rationale, sessionId, userId }));
    deps.repo.addMessage(sessionId, userId, "status", `已识别 ${stored.length} 笔决策，请确认每笔 T0、方向与数量。`);
    return c.json({ sessionId, decisions: stored, messages: deps.repo.listMessages(sessionId, userId), memories: deps.repo.listMemories(userId) }, 201);
  });

  app.get("/api/sessions/:id", (c) => {
    const userId = userIdFor(c);
    const id = c.req.param("id");
    const session = deps.repo.getSession(id, userId);
    if (!session) return c.json({ error: "not_found" }, 404);
    const decisions = deps.repo.listSessionDecisions(id, userId);
    return c.json({ session, decisions, messages: deps.repo.listMessages(id, userId), memories: deps.repo.listMemories(userId), results: decisions.filter((d) => d.reviewId).map((d) => ({ decisionId: d.id, reviewId: d.reviewId, result: deps.repo.getResult(d.reviewId!) })) });
  });

  app.patch("/api/sessions/:id/decisions/:decisionId", async (c) => {
    const userId = userIdFor(c);
    const sessionId = c.req.param("id");
    if (!deps.repo.getSession(sessionId, userId)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    deps.repo.updateSessionDecision(c.req.param("decisionId"), userId, body ?? {});
    return c.json({ decisions: deps.repo.listSessionDecisions(sessionId, userId) });
  });

  app.post("/api/sessions/:id/confirm", async (c) => {
    const userId = userIdFor(c);
    const id = c.req.param("id");
    const session = deps.repo.getSession(id, userId);
    if (!session) return c.json({ error: "not_found" }, 404);
    if (!deps.provider.configured) return c.json({ error: "MODEL_NOT_CONFIGURED", message: MODEL_UNAVAILABLE_MESSAGE }, 503);
    const decisions = deps.repo.listSessionDecisions(id, userId);
    if (!decisions.length) return c.json({ error: "invalid_input", message: "没有可复盘的决策。" }, 400);
    const pendingT0 = decisions.filter((item) => !item.executedAt || item.timePrecision === "unknown");
    if (pendingT0.length) return c.json({ error: "DECISION_CONFIRMATION_REQUIRED", message: "请先确认每笔决策的成交时间。", decisionIds: pendingT0.map((item) => item.id) }, 422);
    deps.repo.updateSession(id, userId, "running");
    deps.repo.addMessage(id, userId, "status", "正在重建每笔决策各自的 T0 前信息环境…");
    const agent = new DecisionReviewAgent({ repo: deps.repo, registry: deps.registry, provider: deps.provider, config: deps.config });
    const runIds: string[] = [];
    const pending: Promise<void>[] = [];
    for (const item of decisions) {
      const runId = `rev_${randomUUID()}`;
      const decision: DecisionInput = { symbol: item.symbol, market: item.market as "CN" | "HK" | "US", action: item.action, executedAt: item.executedAt!, price: item.price ?? undefined, quantity: item.quantityShares ?? item.quantity ?? undefined, userReason: item.reason, notes: item.notes };
      deps.repo.createRun(runId, decision, item.executedAt, id, userId);
      deps.repo.linkDecisionReview(item.id, userId, runId);
      runIds.push(runId);
      const execute = async () => {
        try {
          await agent.run(runId, decision);
          const result = deps.repo.getResult(runId);
          if (result?.lessons[0]) deps.repo.addMemory(userId, result.lessons[0], "lesson", id, item.id);
          deps.repo.addMessage(id, userId, "status", `${item.symbol} 已完成 T0 对齐与证据复盘。`);
        } catch (error) {
          deps.repo.updateStatus(runId, "failed", { errorMessage: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() });
          deps.repo.addMessage(id, userId, "status", `${item.symbol} 复盘失败，已保留会话上下文。`);
        }
      };
      if (deps.runSync) await execute(); else pending.push(execute());
    }
    if (deps.runSync) deps.repo.updateSession(id, userId, "completed");
    else void Promise.all(pending).then(() => deps.repo.updateSession(id, userId, "completed"));
    return c.json({ sessionId: id, runIds, status: deps.runSync ? "completed" : "running" }, 202);
  });

  app.post("/api/sessions/:id/messages", async (c) => {
    const userId = userIdFor(c);
    const id = c.req.param("id");
    if (!deps.repo.getSession(id, userId)) return c.json({ error: "not_found" }, 404);
    if (!deps.provider.configured) return c.json({ error: "MODEL_NOT_CONFIGURED", message: MODEL_UNAVAILABLE_MESSAGE }, 503);
    const body = await c.req.json().catch(() => null) as { content?: string } | null;
    const content = body?.content?.trim();
    if (!content) return c.json({ error: "invalid_input", message: "请输入追问内容。" }, 400);
    const userMessage = deps.repo.addMessage(id, userId, "user", content);
    const decisions = deps.repo.listSessionDecisions(id, userId);
    const memories = deps.repo.listMemories(userId);
    const results = decisions.filter((d) => d.reviewId).map((d) => deps.repo.getResult(d.reviewId!));
    const completion = await deps.provider.complete({ system: "你是 AIME 投资决策复盘助手。只基于当前用户 session 的 decisions、T0 前后证据、findings 与 learning memory 回答；不要给出新的买卖指令。", user: JSON.stringify({ question: content, decisions, results, memories }), temperature: 0.2, maxOutputTokens: 900 });
    const assistant = deps.repo.addMessage(id, userId, "assistant", completion.text || "当前无法生成追问回复。");
    return c.json({ message: assistant, messages: deps.repo.listMessages(id, userId) }, 201);
  });

  app.post("/api/reviews", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = DecisionInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_input", issues: parsed.error.issues },
        400
      );
    }
    const decision = parsed.data;
    // TEST_PLAN T11 — reject requests asking for deterministic predictions or
    // guaranteed-return / direct trade-instruction language. The product
    // reviews historical decisions; it does not produce forward signals.
    const nonCompliantReason = nonCompliantReasonFor(decision);
    if (nonCompliantReason) {
      return c.json(
        {
          error: "non_compliant_request",
          reason: nonCompliantReason,
          message:
            "This product reviews historical decisions; it does not produce deterministic buy/sell signals or guaranteed-return claims.",
        },
        422
      );
    }
    if (!deps.provider.configured) return c.json({ error: "MODEL_NOT_CONFIGURED", message: MODEL_UNAVAILABLE_MESSAGE }, 503);
    const id = `rev_${randomUUID()}`;
    const T0 = decision.executedAt;
    deps.repo.createRun(id, decision, T0);

    const agent = new DecisionReviewAgent({
      repo: deps.repo,
      registry: deps.registry,
      provider: deps.provider,
      config: deps.config,
    });

    if (deps.runSync) {
      try {
        await agent.run(id, decision);
      } catch (e) {
        deps.repo.updateStatus(id, "failed", {
          errorMessage: e instanceof Error ? e.message : String(e),
          finishedAt: new Date().toISOString(),
        });
      }
    } else {
      // Fire-and-forget; clients poll /api/reviews/:id for progress.
      agent.run(id, decision).catch((e) => {
        deps.repo.updateStatus(id, "failed", {
          errorMessage: e instanceof Error ? e.message : String(e),
          finishedAt: new Date().toISOString(),
        });
      });
    }

    const run = deps.repo.getRun(id);
    return c.json(
      {
        id,
        status: run?.status ?? "created",
        decision,
        T0,
        poll: `/api/reviews/${id}`,
        events: `/api/reviews/${id}/events`,
        result: `/api/reviews/${id}/result`,
      },
      202
    );
  });

  app.get("/api/reviews/:id", (c) => {
    const id = c.req.param("id");
    const run = deps.repo.getRun(id);
    if (!run) return c.json({ error: "not_found" }, 404);
    const decision = deps.repo.getDecision(id);
    return c.json({
      id: run.id,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      finishedAt: run.finishedAt,
      errorMessage: run.errorMessage,
      decision: decision?.decision,
      T0: decision?.T0,
    });
  });

  app.get("/api/reviews/:id/events", (c) => {
    const id = c.req.param("id");
    const run = deps.repo.getRun(id);
    if (!run) return c.json({ error: "not_found" }, 404);
    const events = deps.repo.getEvents(id);
    return c.json({ id, events });
  });

  app.get("/api/reviews/:id/result", (c) => {
    const id = c.req.param("id");
    const run = deps.repo.getRun(id);
    if (!run) return c.json({ error: "not_found" }, 404);
    const result = deps.repo.getResult(id);
    if (!result) {
      return c.json(
        {
          error: "result_not_ready",
          status: run.status,
          message:
            run.status === "completed" || run.status === "partial" || run.status === "failed"
              ? "Run finished but no result was persisted."
              : "Run is still in progress.",
        },
        425
      );
    }
    return c.json({ id, status: run.status, result });
  });

  return app;
}

const NON_COMPLIANT_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bguaranteed?\s+(return|profit|income|return[s]?)/i, label: "guaranteed return" },
  { re: /\b100\s*%\s*(safe|return|profit)/i, label: "100% return" },
  { re: /\b确定性(涨跌|收益|回报)/, label: "确定性收益" },
  { re: /\b直接(买入|卖出)指令/, label: "直接买卖指令" },
  { re: /\bsure\s+thing\b/i, label: "sure thing" },
  { re: /\b(predict|tell me)\s+(the\s+)?(next\s+)?(price|stock|move)/i, label: "predict next price" },
];

function nonCompliantReasonFor(decision: { userReason?: string | null; notes?: string | null }): string | null {
  const text = `${decision.userReason ?? ""} ${decision.notes ?? ""}`.trim();
  if (!text) return null;
  for (const { re, label } of NON_COMPLIANT_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}
