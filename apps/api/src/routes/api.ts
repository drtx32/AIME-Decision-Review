/**
 * Hono routes — /api/reviews/* + /api/auth/* + /api/admin/* + /health.
 *
 * All non-auth, non-health endpoints require an authenticated session.
 * mustChangePassword users are blocked from review endpoints and admin
 * endpoints — they may only hit /api/auth/*.
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { DecisionInputSchema, type DecisionInput } from "../types/index.ts";
import type { AppConfig } from "../config.ts";
import type { ReviewRepository } from "../db/sqlite.ts";
import type { UserRepository } from "../auth/repository.ts";
import type { McpRegistry } from "../mcp/registry.ts";
import { DecisionReviewAgent } from "../agents/decision-review.ts";
import { DecisionExtractorAgent } from "../agents/decision-extractor.ts";
import type { ModelProvider } from "../providers/index.ts";
import { attachUser, requireAuth, gateMustChangePassword, rejectClientUserIdHeader, type AuthEnv } from "../auth/middleware.ts";
import { buildAuthRoutes } from "../auth/routes.ts";
import { buildAdminRoutes } from "../auth/admin.ts";

export interface RouteDeps {
  config: AppConfig;
  repo: ReviewRepository;
  userRepo: UserRepository;
  registry: McpRegistry;
  provider: ModelProvider;
  /** Test hook — bypass background execution so specs stay deterministic. */
  runSync?: boolean;
}

type AppEnv = { Variables: AuthEnv["Variables"] };

export function buildApi(deps: RouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const config = deps.config;
  const auth = buildAuthRoutes(deps.userRepo, config.isProduction);
  const admin = buildAdminRoutes(deps.userRepo);
  const modelUnavailable = "当前未配置可用的大模型服务，请联系管理员。";

  app.use("*", attachUser(deps.userRepo));

  // Identity-contract guard — must run BEFORE requireAuth so a forged
  // x-user-id header is rejected even if a future route forgets the auth
  // gate. Runs after attachUser so it doesn't interfere with /health or
  // /api/auth/login response paths.
  app.use("/api/*", rejectClientUserIdHeader());

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

  // Public auth endpoints (login + change-password self-service) live here.
  app.route("/api/auth", auth);

  const sessionAuth = [requireAuth(deps.userRepo), gateMustChangePassword()];
  app.use("/api/sessions", ...sessionAuth);
  app.use("/api/sessions/*", ...sessionAuth);

  app.get("/api/sessions", (c) => {
    const user = c.get("user")!;
    return c.json({ sessions: deps.repo.listSessions(user.id) });
  });

  app.post("/api/sessions", async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json().catch(() => null) as { message?: string; scope?: string; clientNow?: string; timezone?: string } | null;
    const message = body?.message?.trim();
    if (!message) return c.json({ error: "invalid_input", message: "请输入一段历史决策描述。" }, 400);
    if (!deps.provider.configured) return c.json({ error: "MODEL_NOT_CONFIGURED", message: modelUnavailable }, 503);
    let decisions;
    try {
      decisions = await new DecisionExtractorAgent(deps.provider, deps.config.llm.extractorModel).extract(message, { clientNow: body?.clientNow || new Date().toISOString(), timezone: body?.timezone || "UTC" });
    } catch { return c.json({ error: "DECISION_EXTRACTION_FAILED", message: "无法可靠识别决策，请补充标的、方向与成交时间后重试。" }, 422); }
    const sessionId = deps.repo.createSession(user.id, decisions.length > 1 ? `${decisions.length} 笔投资决策` : `${decisions[0]?.symbol ?? "新"} 决策复盘`, body?.scope ?? (decisions.length > 1 ? "custom" : "single"));
    deps.repo.addMessage(sessionId, user.id, "user", message);
    const stored = decisions.map((decision) => deps.repo.addSessionDecision({ ...decision, quantity: decision.quantityShares, reason: decision.rationale, sessionId, userId: user.id }));
    deps.repo.addMessage(sessionId, user.id, "status", `已识别 ${stored.length} 笔决策，请确认每笔 T0、方向与数量。`);
    return c.json({ sessionId, decisions: stored, messages: deps.repo.listMessages(sessionId, user.id), memories: deps.repo.listMemories(user.id) }, 201);
  });

  app.get("/api/sessions/:id", (c) => {
    const user = c.get("user")!; const id = c.req.param("id");
    const session = deps.repo.getSession(id, user.id); if (!session) return c.json({ error: "not_found" }, 404);
    const decisions = deps.repo.listSessionDecisions(id, user.id);
    return c.json({ session, decisions, messages: deps.repo.listMessages(id, user.id), memories: deps.repo.listMemories(user.id), results: decisions.filter((d) => d.reviewId).map((d) => ({ decisionId: d.id, reviewId: d.reviewId, result: deps.repo.getResult(d.reviewId!) })) });
  });

  app.patch("/api/sessions/:id/decisions/:decisionId", async (c) => {
    const user = c.get("user")!; const id = c.req.param("id");
    if (!deps.repo.getSession(id, user.id)) return c.json({ error: "not_found" }, 404);
    deps.repo.updateSessionDecision(c.req.param("decisionId"), user.id, await c.req.json().catch(() => ({})));
    return c.json({ decisions: deps.repo.listSessionDecisions(id, user.id) });
  });

  app.post("/api/sessions/:id/confirm", async (c) => {
    const user = c.get("user")!; const id = c.req.param("id");
    if (!deps.repo.getSession(id, user.id)) return c.json({ error: "not_found" }, 404);
    if (!deps.provider.configured) return c.json({ error: "MODEL_NOT_CONFIGURED", message: modelUnavailable }, 503);
    const decisions = deps.repo.listSessionDecisions(id, user.id);
    if (!decisions.length) return c.json({ error: "invalid_input", message: "没有可复盘的决策。" }, 400);
    const pendingT0 = decisions.filter((item) => !item.executedAt || item.timePrecision === "unknown");
    if (pendingT0.length) return c.json({ error: "DECISION_CONFIRMATION_REQUIRED", message: "请先确认每笔决策的成交时间。", decisionIds: pendingT0.map((item) => item.id) }, 422);
    deps.repo.updateSession(id, user.id, "running"); deps.repo.addMessage(id, user.id, "status", "正在重建每笔决策各自的 T0 前信息环境…");
    const agent = new DecisionReviewAgent({ repo: deps.repo, registry: deps.registry, provider: deps.provider, config: deps.config });
    const runIds: string[] = []; const pending: Promise<void>[] = [];
    for (const item of decisions) {
      const runId = `rev_${randomUUID()}`; const decision: DecisionInput = { symbol: item.symbol, market: item.market as "CN" | "HK" | "US", action: item.action, executedAt: item.executedAt!, price: item.price ?? undefined, quantity: item.quantityShares ?? item.quantity ?? undefined, userReason: item.reason, notes: item.notes };
      deps.repo.createRun(runId, decision, item.executedAt!, id, user.id); deps.repo.linkDecisionReview(item.id, user.id, runId); runIds.push(runId);
      const execute = async () => { try { await agent.run(runId, decision); const result = deps.repo.getResult(runId); if (result?.lessons[0]) deps.repo.addMemory(user.id, result.lessons[0], "lesson", id, item.id); deps.repo.addMessage(id, user.id, "status", `${item.symbol} 已完成 T0 对齐与证据复盘。`); } catch (error) { deps.repo.updateStatus(runId, "failed", { errorMessage: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() }); deps.repo.addMessage(id, user.id, "status", `${item.symbol} 复盘失败，已保留会话上下文。`); } };
      if (deps.runSync) await execute(); else pending.push(execute());
    }
    const finalizeSession = () => {
      const runs = runIds.map((runId) => deps.repo.getRun(runId));
      const failed = runs.some((run) => run?.status === "failed");
      const partial = runs.some((run) => run?.status === "partial" || run?.status === "created" || run?.status === "retrieving");
      const status = failed ? "failed" : partial ? "partial" : "completed";
      deps.repo.updateSession(id, user.id, status);
      const results = runIds.map((runId) => deps.repo.getResult(runId)).filter(Boolean) as any[];
      if (results.length) {
        const evidence = results.reduce((sum, result) => sum + result.exAnteEvidence.length + result.exPostEvidence.length, 0);
        const findings = results.map((result) => result.decisionQuality.reasoning).filter(Boolean).join(" ");
        deps.repo.addMessage(id, user.id, "assistant", `这次复盘已完成${status === "completed" ? "" : "部分"}：共整理 ${evidence} 条证据。${findings || "部分数据源不可用，结论仍需补充验证。"}`);
      }
    };
    if (deps.runSync) finalizeSession(); else void Promise.all(pending).then(finalizeSession);
    return c.json({ sessionId: id, runIds, status: deps.runSync ? "completed" : "running" }, 202);
  });

  app.post("/api/sessions/:id/messages", async (c) => {
    const user = c.get("user")!; const id = c.req.param("id");
    if (!deps.repo.getSession(id, user.id)) return c.json({ error: "not_found" }, 404);
    if (!deps.provider.configured) return c.json({ error: "MODEL_NOT_CONFIGURED", message: modelUnavailable }, 503);
    const content = ((await c.req.json().catch(() => null)) as { content?: string } | null)?.content?.trim(); if (!content) return c.json({ error: "invalid_input", message: "请输入追问内容。" }, 400);
    const userMessage = deps.repo.addMessage(id, user.id, "user", content); const decisions = deps.repo.listSessionDecisions(id, user.id); const memories = deps.repo.listMemories(user.id); const results = decisions.filter((d) => d.reviewId).map((d) => deps.repo.getResult(d.reviewId!));
    const completion = await deps.provider.complete({ system: "你是 AIME 投资决策复盘助手。只基于当前用户 session 的 decisions、T0 前后证据、findings 与 learning memory 回答；不要给出新的买卖指令。", user: JSON.stringify({ question: content, decisions, results, memories }), temperature: 0.2, maxOutputTokens: 900 });
    const assistant = deps.repo.addMessage(id, user.id, "assistant", completion.text || "当前无法生成追问回复。"); return c.json({ message: assistant, messages: deps.repo.listMessages(id, user.id) }, 201);
  });

  // Review endpoints — require an authenticated, non-mustChangePassword user.
  app.use("/api/reviews/*", requireAuth(deps.userRepo), gateMustChangePassword());

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
    if (!deps.provider.configured) return c.json({ error: "MODEL_NOT_CONFIGURED", message: modelUnavailable }, 503);
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

  // Admin endpoints — guarded inside buildAdminRoutes.
  app.route("/api/admin", admin);

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
