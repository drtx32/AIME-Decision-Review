/**
 * Hono routes — /api/reviews/* + /api/auth/* + /api/admin/* + /health.
 *
 * All non-auth, non-health endpoints require an authenticated session.
 * mustChangePassword users are blocked from review endpoints and admin
 * endpoints — they may only hit /api/auth/*.
 */

import { Hono } from "hono";
import { randomUUID, createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DecisionInputSchema, type DecisionInput, type DecisionReviewResult, type ReviewStatus } from "../types/index.ts";
import type { AppConfig } from "../config.ts";
import type { ReviewRepository } from "../db/sqlite.ts";
import type { UserRepository } from "../auth/repository.ts";
import type { SettingsRepository } from "../settings/repository.ts";
import type { McpRegistry } from "../mcp/registry.ts";
import { DecisionReviewAgent } from "../agents/decision-review.ts";
import { DecisionExtractorAgent } from "../agents/decision-extractor.ts";
import { LazyResilientProvider, type LLMCompletionRequest, type LLMCompletion, type ModelProvider } from "../providers/index.ts";
import { OpenAICompatibleProvider } from "../providers/openai-compatible.ts";
import { attachUser, requireAuth, gateMustChangePassword, rejectClientUserIdHeader, type AuthEnv } from "../auth/middleware.ts";
import { buildAuthRoutes } from "../auth/routes.ts";
import { buildAdminRoutes } from "../auth/admin.ts";
import { AttachmentService } from "../attachments/service.ts";
import { buildAttachmentRoutes } from "../attachments/routes.ts";
import { buildSettingsRoutes, buildUsageRoute, buildCapabilitiesRoute } from "../settings/routes.ts";
import { ChartRequestSchema, type ChartResponse, type ChartSeries } from "../charts/contract.ts";
import {
  fetchFuyaoKline,
  fetchIFindKline,
  fallbackKlineSeries,
  providerAvailability as chartProviderAvailability,
  withMarkers,
  type ChartFetchCredentials,
  type ChartFetchResult,
} from "../charts/adapters.ts";

export interface RouteDeps {
  config: AppConfig;
  repo: ReviewRepository;
  userRepo: UserRepository;
  settingsRepo: SettingsRepository;
  registry: McpRegistry;
  provider: ModelProvider;
  attachments?: AttachmentService;
  /** Test hook — bypass background execution so specs stay deterministic. */
  runSync?: boolean;
}

type AppEnv = { Variables: AuthEnv["Variables"] };

function keyFor(secret: string): Buffer { return createHash("sha256").update(secret).digest(); }
function encryptKey(value: string, secret: string): string { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", keyFor(secret), iv); const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return `enc:v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`; }
function decryptKey(value: string, secret: string): string | null { try { const [, version, ivRaw, tagRaw, dataRaw] = value.split(":"); if (version !== "v1" || !ivRaw || !tagRaw || !dataRaw) return null; const decipher = createDecipheriv("aes-256-gcm", keyFor(secret), Buffer.from(ivRaw, "base64url")); decipher.setAuthTag(Buffer.from(tagRaw, "base64url")); return Buffer.concat([decipher.update(Buffer.from(dataRaw, "base64url")), decipher.final()]).toString("utf8"); } catch { return null; } }
function sanitizedError(error: unknown): string { const text = error instanceof Error ? error.message : String(error); return text.replace(/(authorization|api[-_ ]?key|bearer)\s*[:=]?\s*[^\s,;]+/gi, "$1 [redacted]").slice(0, 240); }

function sessionActivities(repo: ReviewRepository, decisions: Array<{ id: string; symbol: string; reviewId: string | null }>): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const labels: Record<string, { type: string; label: string; purpose: string; provider?: string }> = {
    review_created: { type: "lifecycle_status", label: "正在理解这次决策", purpose: "建立复盘任务" },
    evidence_time_aligned: { type: "reasoning_summary", label: "正在核对成交时间", purpose: "对齐 T0 前后时间边界" },
    market_data_retrieved: { type: "tool_completed", label: "获取行情数据", purpose: "核对成交附近的市场数据", provider: "行情数据" },
    index_sector_context_retrieved: { type: "tool_completed", label: "检索行业与指数背景", purpose: "补充当时可见的市场环境", provider: "Fuyao" },
    news_events_retrieved: { type: "tool_completed", label: "检索当日事件", purpose: "核对事前可知信息", provider: "iFinD" },
    fact_consistency_checked: { type: "reasoning_summary", label: "正在核对事实一致性", purpose: "检查决策与证据是否一致" },
    reflection: { type: "reasoning_summary", label: "正在生成复盘归因", purpose: "区分过程质量与结果" },
    final_review_generated: { type: "terminal_status", label: "复盘已完成", purpose: "整理证据、结论与学习" },
    tool_status: { type: "tool_updated", label: "数据源状态已更新", purpose: "汇总工具返回状态" },
    error: { type: "terminal_status", label: "复盘遇到数据源问题", purpose: "保留已获得的上下文" },
  };
  for (const decision of decisions) {
    if (!decision.reviewId) continue;
    const run = repo.getRun(decision.reviewId);
    for (const event of repo.getEvents(decision.reviewId)) {
      const mapped = labels[event.kind] ?? labels.tool_status;
      const metadata = event.metadata ?? {};
      const count = typeof metadata.sourceCount === "number" ? metadata.sourceCount : typeof metadata.evidenceCount === "number" ? metadata.evidenceCount : undefined;
      events.push({ id: event.id, type: mapped.type, label: `${decision.symbol} · ${mapped.label}`, purpose: mapped.purpose, provider: mapped.provider, sourceCount: count, status: event.kind === "error" ? "error" : event.kind === "final_review_generated" ? "completed" : "completed", startedAt: event.at, completedAt: event.at });
    }
    if (run && !["completed", "partial", "failed"].includes(run.status)) events.push({ id: `${decision.reviewId}:active`, type: "lifecycle_status", label: `${decision.symbol} · 正在复原这次决策`, purpose: "正在检索与核对证据", status: "active", startedAt: run.createdAt });
    if (run?.status === "partial") events.push({ id: `${decision.reviewId}:partial`, type: "terminal_status", label: `${decision.symbol} · 部分完成`, purpose: "部分数据源不可用，保留已获证据", status: "degraded", completedAt: run.finishedAt ?? run.updatedAt });
    if (run?.status === "failed") events.push({ id: `${decision.reviewId}:failed`, type: "terminal_status", label: `${decision.symbol} · 复盘失败`, purpose: "未写入不完整的学习结论", status: "error", completedAt: run.finishedAt ?? run.updatedAt });
  }
  return events.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

class UsageTrackingProvider implements ModelProvider {
  readonly id: string; readonly modelName: string; readonly configured = true;
  constructor(private readonly inner: ModelProvider, private readonly userRepo: UserRepository, private readonly userId: string) { this.id = inner.id; this.modelName = inner.modelName; }
  availability() { return this.inner.availability?.() ?? { state: "ready" as const, providerId: this.id, model: this.modelName, lastError: null, requestedMode: "openai-compatible" as const, degraded: false }; }
  async complete(request: LLMCompletionRequest): Promise<LLMCompletion> { const result = await this.inner.complete(request); if (result.usage) this.userRepo.recordLlmUsage(this.userId, { ...result.usage, provider: this.id, model: this.modelName }); return result; }
}

/** Durable investment learning is reserved for a completed, grounded run. */
function canPersistDecisionLessons(result: DecisionReviewResult | null, status: ReviewStatus | undefined): boolean {
  if (!result || status !== "completed" || result.exAnteEvidence.length === 0) return false;
  if (!["poor", "fair", "good", "strong"].includes(result.decisionQuality.rating)) return false;
  const exAnteIds = new Set(result.exAnteEvidence.map((item) => item.id));
  return result.attribution.some((item) => item.evidenceIds.length > 0 && item.evidenceIds.every((id) => exAnteIds.has(id)));
}

export function buildApi(deps: RouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const config = deps.config;
  const modelSecret = config.modelConfigSecret || config.initialAdmin.password || "aime-model-config-local-secret";
  const auth = buildAuthRoutes(deps.userRepo, config.isProduction);
  const admin = buildAdminRoutes(deps.userRepo);
  const settings = buildSettingsRoutes({ settingsRepo: deps.settingsRepo });
  const usage = buildUsageRoute({ settingsRepo: deps.settingsRepo });
  const capabilities = buildCapabilitiesRoute();
  const modelUnavailable = "当前未配置可用的大模型服务，请联系管理员。";
  const providerForUser = (userId: string): ModelProvider => {
    const saved = deps.userRepo.getModelConfig(userId);
    if (!saved) return new UsageTrackingProvider(deps.provider, deps.userRepo, userId);
    const apiKey = decryptKey(saved.apiKeyEncrypted, modelSecret);
    if (!apiKey) return new UsageTrackingProvider({ id: "openai-compatible", modelName: saved.model, configured: false, complete: async () => { throw new Error("Stored model credential is unavailable"); }, availability: () => ({ state: "error", providerId: "openai-compatible", model: saved.model, lastError: null, requestedMode: "openai-compatible", degraded: true }) }, deps.userRepo, userId);
    const live = new LazyResilientProvider({ id: "openai-compatible", modelName: saved.model, build: () => new OpenAICompatibleProvider({ baseUrl: saved.baseUrl, modelName: saved.model, apiKey }) });
    return new UsageTrackingProvider(live, deps.userRepo, userId);
  };
  // Provider availability is the single readiness contract. In particular,
  // real-provider mode with missing credentials must never be treated as a
  // mock-backed configured provider by route pre-flight or /health.
  const providerAvailability = () => {
    const base = deps.provider.availability?.() ?? {
    state: deps.provider.configured ? "ready" : "unconfigured",
    providerId: deps.provider.id,
    model: deps.provider.modelName,
    lastError: null,
    requestedMode: "mock" as const,
    degraded: !deps.provider.configured,
    };
    // Explicit mock mode is a development/demo capability. A production
    // process must not present a mock-backed report as model-ready.
    if (config.isProduction && base.requestedMode === "mock") {
      return { ...base, state: "unconfigured" as const, degraded: true };
    }
    return base;
  };
  const providerReady = (provider: ModelProvider = deps.provider, userId?: string) => {
    if (provider === deps.provider || (userId && !deps.userRepo.getModelConfig(userId))) return providerAvailability().state === "ready";
    return (provider.availability?.().state ?? (provider.configured ? "ready" : "unconfigured")) === "ready";
  };

  app.use("*", attachUser(deps.userRepo));

  // Identity-contract guard — must run BEFORE requireAuth so a forged
  // x-user-id header is rejected even if a future route forgets the auth
  // gate. Runs after attachUser so it doesn't interfere with /health or
  // /api/auth/login response paths.
  app.use("/api/*", rejectClientUserIdHeader());

  app.get("/health", (c) => {
    const availability = providerAvailability();
    return c.json({
      status: "ok",
      provider: deps.provider.id,
      provider_configured: availability.state === "ready",
      provider_status: availability.state,
      provider_id: availability.providerId,
      requested_mode: availability.requestedMode,
      degraded: availability.degraded,
      last_error: availability.lastError,
      provider_capabilities: deps.provider.capabilities ?? null,
      configuredServers: deps.registry.configuredKeys(),
      time: new Date().toISOString(),
    });
  });

  // Public auth endpoints (login + change-password self-service) live here.
  app.route("/api/auth", auth);

  app.get("/api/auth/model", requireAuth(deps.userRepo), (c) => {
    const user = c.get("user")!; const saved = deps.userRepo.getModelConfig(user.id);
    return c.json({ configured: Boolean(saved), provider: saved?.provider ?? "openai-compatible", baseUrl: saved?.baseUrl ?? "", model: saved?.model ?? config.llm.model, keySuffix: saved ? (decryptKey(saved.apiKeyEncrypted, modelSecret)?.slice(-4) ?? null) : null, verifiedAt: saved?.verifiedAt ?? null, lastError: saved?.lastError ?? null, serverDefaultModel: config.llm.model });
  });
  app.get("/api/auth/usage", requireAuth(deps.userRepo), (c) => { const user = c.get("user")!; const start = new Date(); start.setUTCDate(1); start.setUTCHours(0,0,0,0); const summary = deps.userRepo.getLlmUsageSummary(user.id, start.toISOString()); return c.json({ periodStart: start.toISOString(), ...summary, allowance: null, providerQuota: null, label: "App usage" }); });
  app.post("/api/auth/model/test", requireAuth(deps.userRepo), async (c) => {
    const user = c.get("user")!; const body = await c.req.json().catch(() => ({})) as { baseUrl?: string; model?: string; apiKey?: string };
    const saved = deps.userRepo.getModelConfig(user.id); const baseUrl = body.baseUrl?.trim() || saved?.baseUrl; const model = body.model?.trim() || saved?.model || config.llm.model; const apiKey = body.apiKey?.trim() || (saved ? decryptKey(saved.apiKeyEncrypted, modelSecret) : null);
    if (!baseUrl || !apiKey) return c.json({ ok: false, error: "请填写 Base URL 和 API key" }, 400);
    try { const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { headers: { Authorization: `Bearer ${apiKey}` } }); if (!response.ok) throw new Error(`远端返回 HTTP ${response.status}`); return c.json({ ok: true, model, verifiedAt: new Date().toISOString() }); } catch (error) { return c.json({ ok: false, error: sanitizedError(error) }, 502); }
  });
  app.post("/api/auth/model", requireAuth(deps.userRepo), async (c) => {
    const user = c.get("user")!; const body = await c.req.json().catch(() => ({})) as { provider?: string; baseUrl?: string; model?: string; apiKey?: string; verifiedAt?: string | null };
    const saved = deps.userRepo.getModelConfig(user.id); const baseUrl = body.baseUrl?.trim(); const model = body.model?.trim(); const apiKey = body.apiKey?.trim() || (saved ? decryptKey(saved.apiKeyEncrypted, modelSecret) : null);
    if (body.provider && body.provider !== "openai-compatible") return c.json({ error: "仅支持 OpenAI-compatible" }, 400); if (!baseUrl || !model || !apiKey) return c.json({ error: "Base URL、model、API key 均为必填" }, 400);
    deps.userRepo.saveModelConfig({ userId: user.id, provider: "openai-compatible", baseUrl, model, apiKeyEncrypted: encryptKey(apiKey, modelSecret), verifiedAt: body.verifiedAt ?? null, lastError: null }); return c.json({ configured: true, provider: "openai-compatible", baseUrl, model, keySuffix: apiKey.slice(-4), verifiedAt: body.verifiedAt ?? null, lastError: null, serverDefaultModel: config.llm.model });
  });
  app.delete("/api/auth/model", requireAuth(deps.userRepo), (c) => { deps.userRepo.clearModelConfig(c.get("user")!.id); return c.json({ configured: false, provider: "openai-compatible", baseUrl: "", model: config.llm.model, keySuffix: null, verifiedAt: null, lastError: null, serverDefaultModel: config.llm.model }); });

  const sessionAuth = [requireAuth(deps.userRepo), gateMustChangePassword()];
  if (deps.attachments) {
    app.use("/api/attachments", ...sessionAuth);
    app.use("/api/attachments/*", ...sessionAuth);
    app.route("/api/attachments", buildAttachmentRoutes(deps.attachments));
  }
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
    const userProvider = providerForUser(user.id); if (!providerReady(userProvider, user.id)) return c.json({ error: "MODEL_NOT_CONFIGURED", code: "MODEL_NOT_CONFIGURED", retryable: false, provider_status: userProvider.availability?.().state, message: modelUnavailable }, 503);
    const sessionId = deps.repo.createSession(user.id, "新建复盘", body?.scope ?? "single");
    const userMessage = deps.repo.addMessage(sessionId, user.id, "user", message, "extracting");
    let decisions;
    try {
      decisions = await new DecisionExtractorAgent(userProvider, deps.config.llm.extractorModel).extract(message, { clientNow: body?.clientNow || new Date().toISOString(), timezone: body?.timezone || "UTC" });
    } catch {
      const warning = "无法可靠识别投资决策：请补充标的、方向，以及成交/下单时间。";
      deps.repo.updateMessageState(userMessage.id, sessionId, user.id, "needs_input", warning);
      deps.repo.updateSession(sessionId, user.id, "needs_input");
      return c.json({ sessionId, status: "needs_input", warning, decisions: [], messages: deps.repo.listMessages(sessionId, user.id), memories: deps.repo.listMemories(user.id), activities: [] }, 201);
    }
    deps.repo.updateMessageState(userMessage.id, sessionId, user.id, "accepted");
    const stored = decisions.map((decision) => deps.repo.addSessionDecision({ ...decision, market: decision.market ?? "CN", quantity: decision.quantityShares, reason: decision.rationale, sessionId, userId: user.id }));
    deps.repo.addMessage(sessionId, user.id, "status", `已识别 ${stored.length} 笔决策，请确认每笔 T0、方向与数量。`);
    return c.json({ sessionId, status: "accepted", decisions: stored, messages: deps.repo.listMessages(sessionId, user.id), memories: deps.repo.listMemories(user.id), activities: [] }, 201);
  });

  app.get("/api/sessions/:id", (c) => {
    const user = c.get("user")!; const id = c.req.param("id");
    const session = deps.repo.getSession(id, user.id); if (!session) return c.json({ error: "not_found" }, 404);
    const decisions = deps.repo.listSessionDecisions(id, user.id);
    return c.json({ session, decisions, messages: deps.repo.listMessages(id, user.id), memories: deps.repo.listMemories(user.id), activities: sessionActivities(deps.repo, decisions), results: decisions.filter((d) => d.reviewId).map((d) => ({ decisionId: d.id, reviewId: d.reviewId, status: deps.repo.getRun(d.reviewId!)?.status ?? "unknown", result: deps.repo.getResult(d.reviewId!) })) });
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
    const userProvider = providerForUser(user.id); if (!providerReady(userProvider, user.id)) return c.json({ error: "MODEL_NOT_CONFIGURED", code: "MODEL_NOT_CONFIGURED", retryable: false, provider_status: userProvider.availability?.().state, message: modelUnavailable }, 503);
    const decisions = deps.repo.listSessionDecisions(id, user.id);
    if (!decisions.length) return c.json({ error: "invalid_input", message: "没有可复盘的决策。" }, 400);
    // An evidence-grounded approximate T0 may proceed after the user clears
    // its confirmation questions. Unknown/null T0 still blocks all bounded
    // evidence reasoning; never force approximate input to exact.
    const pendingT0 = decisions.filter((item) => !item.executedAt || item.timePrecision === "unknown" || item.needsConfirmation.length > 0);
    if (pendingT0.length) return c.json({ error: "DECISION_CONFIRMATION_REQUIRED", message: "请先确认每笔决策的成交时间。", decisionIds: pendingT0.map((item) => item.id) }, 422);
    deps.repo.updateSession(id, user.id, "running"); deps.repo.addMessage(id, user.id, "status", "正在重建每笔决策各自的 T0 前信息环境…");
    const agent = new DecisionReviewAgent({ repo: deps.repo, registry: deps.registry, provider: userProvider, config: deps.config });
    const runIds: string[] = []; const pending: Promise<void>[] = [];
    for (const item of decisions) {
      const runId = `rev_${randomUUID()}`; const decision: DecisionInput = { symbol: item.symbol, market: item.market as "CN" | "HK" | "US", action: item.action, executedAt: item.executedAt!, timePrecision: item.timePrecision, price: item.price ?? undefined, quantity: item.quantityShares ?? item.quantity ?? undefined, userReason: item.reason, notes: item.notes };
      deps.repo.createRun(runId, decision, item.executedAt!, id, user.id); deps.repo.linkDecisionReview(item.id, user.id, runId); runIds.push(runId);
      const execute = async () => { try { await agent.run(runId, decision); if (deps.repo.isCancelled(runId)) return; const result = deps.repo.getResult(runId); if (result && canPersistDecisionLessons(result, deps.repo.getRun(runId)?.status)) for (const lesson of result.lessons) { const text = lesson.trim(); if (text) deps.repo.addMemory(user.id, text, "lesson", id, item.id); } deps.repo.addMessage(id, user.id, "status", `${item.symbol} 已完成 T0 对齐与证据复盘。`); } catch (error) { if (deps.repo.isCancelled(runId)) return; deps.repo.updateStatus(runId, "failed", { errorMessage: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() }); deps.repo.addMessage(id, user.id, "status", `${item.symbol} 复盘失败，已保留会话上下文。`); } };
      if (deps.runSync) await execute(); else pending.push(execute());
    }
    const finalizeSession = () => {
      const runs = runIds.map((runId) => deps.repo.getRun(runId));
      const failed = runs.some((run) => run?.status === "failed");
      const partial = runs.some((run) => run?.status === "partial" || run?.status === "created" || run?.status === "retrieving");
      if (deps.repo.getSession(id, user.id)?.status === "cancelled") return;
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
    const userProvider = providerForUser(user.id); if (!providerReady(userProvider, user.id)) return c.json({ error: "MODEL_NOT_CONFIGURED", code: "MODEL_NOT_CONFIGURED", retryable: false, provider_status: userProvider.availability?.().state, message: modelUnavailable }, 503);
    const body = (await c.req.json().catch(() => null)) as { content?: string; clientNow?: string; timezone?: string } | null;
    const content = body?.content?.trim(); if (!content) return c.json({ error: "invalid_input", message: "请输入追问内容。" }, 400);
    const userMessage = deps.repo.addMessage(id, user.id, "user", content, "extracting");
    let decisions = deps.repo.listSessionDecisions(id, user.id);

    // If a session has no structured decision yet, a natural-language trade
    // description is not a generic chat question: it is the product input.
    // Extract it first so AIME can reconstruct public context instead of asking
    // the user to manually supply market/news/outcome data.
    if (decisions.length === 0) {
      try {
        const extracted = await new DecisionExtractorAgent(userProvider, deps.config.llm.extractorModel).extract(content, {
          clientNow: body?.clientNow || new Date().toISOString(),
          timezone: body?.timezone || "UTC",
        });
        const stored = extracted.map((decision) => deps.repo.addSessionDecision({ ...decision, market: decision.market ?? "CN", quantity: decision.quantityShares, reason: decision.rationale, sessionId: id, userId: user.id }));
        deps.repo.updateMessageState(userMessage.id, id, user.id, "accepted");
        deps.repo.updateSession(id, user.id, "draft");
        decisions = stored;
        const assistant = deps.repo.addMessage(id, user.id, "assistant", `我先从这段话还原出 ${stored.length} 个决策/下单事件。请只确认成交/下单时间、方向和数量是否正确；行情、新闻、板块环境、价格路径和事后表现会由 AIME 在确认后自己检索并按 T0 前后分开。只有公开数据无法还原的个人理由或成交细节，我才会再向你确认。`);
        return c.json({ message: assistant, status: "accepted", decisions: stored, messages: deps.repo.listMessages(id, user.id) }, 201);
      } catch {
        deps.repo.updateMessageState(userMessage.id, id, user.id, "accepted");
        const assistant = deps.repo.addMessage(id, user.id, "assistant", "可以，公开可还原的部分本来就应该由我来做。你不需要先整理市场环境、新闻、板块情绪或后续走势；只要告诉我你实际做了什么——标的、买/卖、大概时间、数量，记不清的可以直接说不确定。");
        return c.json({ message: assistant, status: "guidance", decisions: [], messages: deps.repo.listMessages(id, user.id) }, 201);
      }
    }

    deps.repo.updateMessageState(userMessage.id, id, user.id, "accepted");
    const memories = deps.repo.listMemories(user.id); const results = decisions.filter((d) => d.reviewId).map((d) => deps.repo.getResult(d.reviewId!));
    const completion = await userProvider.complete({
      system: "你是 AIME 投资决策复盘助手。你的职责是主动还原历史决策，而不是把可检索工作推回给用户。严格基于当前 session 的 decisions、T0 前后证据、findings 与 learning memory 回答，不给出新的买卖指令。不要要求用户补充市场环境、板块情绪、新闻公告、价格路径、盈亏结果等可由行情/新闻/MCP/复盘结果获得的信息；这些应由 AIME 自己检索。只有个人不可观测信息（例如当时主观理由）或公开数据无法可靠确定的实际成交时间/价格，才可以提出最小化澄清。results 为空时，不要说“没有数据所以不能做”；应说明确认 decisions 后系统会自行检索并复盘。回答直接、自然，不要自我介绍，不要列职责边界表格。",
      user: JSON.stringify({ question: content, decisions, results, memories }),
      temperature: 0.2,
      maxOutputTokens: 900
    });
    const assistant = deps.repo.addMessage(id, user.id, "assistant", completion.text || "当前无法生成追问回复。"); return c.json({ message: assistant, messages: deps.repo.listMessages(id, user.id) }, 201);
  });

  app.patch("/api/sessions/:id/messages/:messageId", async (c) => {
    const user = c.get("user")!; const id = c.req.param("id"); const body = await c.req.json().catch(() => ({})) as { content?: string };
    const content = body.content?.trim(); if (!content) return c.json({ error: "invalid_input", message: "消息不能为空。" }, 400);
    const userProvider = providerForUser(user.id); if (!providerReady(userProvider, user.id)) return c.json({ error: "MODEL_NOT_CONFIGURED", code: "MODEL_NOT_CONFIGURED", retryable: false, provider_status: userProvider.availability?.().state, message: modelUnavailable }, 503);
    const message = deps.repo.updateMessageAndInvalidate(c.req.param("messageId"), id, user.id, content); if (!message) return c.json({ error: "not_found" }, 404);
    try {
      const decisions = await new DecisionExtractorAgent(userProvider, deps.config.llm.extractorModel).extract(content, { clientNow: new Date().toISOString(), timezone: "UTC" });
      deps.repo.updateMessageState(message.id, id, user.id, "accepted");
      const stored = decisions.map((decision) => deps.repo.addSessionDecision({ ...decision, market: decision.market ?? "CN", quantity: decision.quantityShares, reason: decision.rationale, sessionId: id, userId: user.id }));
      deps.repo.updateSession(id, user.id, "draft");
      deps.repo.addMessage(id, user.id, "status", `已重新识别 ${stored.length} 笔决策，请确认每笔 T0、方向与数量。`);
      return c.json({ message, status: "accepted", decisions: stored, messages: deps.repo.listMessages(id, user.id) });
    } catch {
      const warning = "无法可靠识别投资决策：请补充标的、方向，以及成交/下单时间。";
      deps.repo.updateMessageState(message.id, id, user.id, "needs_input", warning);
      deps.repo.updateSession(id, user.id, "needs_input");
      return c.json({ message: { ...message, state: "needs_input", errorMessage: warning }, status: "needs_input", warning, decisions: [], messages: deps.repo.listMessages(id, user.id) });
    }
  });
  app.delete("/api/sessions/:id/messages/:messageId", (c) => {
    const user = c.get("user")!; const id = c.req.param("id"); if (!deps.repo.softDeleteMessageAndInvalidate(c.req.param("messageId"), id, user.id)) return c.json({ error: "not_found" }, 404);
    return c.json({ messages: deps.repo.listMessages(id, user.id) });
  });
  app.post("/api/sessions/:id/cancel", (c) => { const user = c.get("user")!; const id = c.req.param("id"); if (!deps.repo.getSession(id, user.id)) return c.json({ error: "not_found" }, 404); deps.repo.cancelSessionRuns(id, user.id); return c.json({ sessionId: id, status: "cancelled" }); });

  // Review endpoints — require an authenticated, non-mustChangePassword user.
  app.use("/api/reviews/*", requireAuth(deps.userRepo), gateMustChangePassword());

  app.post("/api/reviews", async (c) => {
    const user = c.get("user")!;
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
    const userProvider = providerForUser(user.id); if (!providerReady(userProvider, user.id)) return c.json({ error: "MODEL_NOT_CONFIGURED", code: "MODEL_NOT_CONFIGURED", retryable: false, provider_status: userProvider.availability?.().state, message: modelUnavailable }, 503);
    const id = `rev_${randomUUID()}`;
    const T0 = decision.executedAt;
    deps.repo.createRun(id, decision, T0);

    const agent = new DecisionReviewAgent({
      repo: deps.repo,
      registry: deps.registry,
      provider: userProvider,
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

  // Chart endpoint — direct structured data path for inline ECharts.
  // Requires an authenticated, non-mustChangePassword user, same gate as
  // the review surface. Server-side only: provider credentials never
  // leave this process and the response never echoes them.
  app.use(
    "/api/chart-data",
    requireAuth(deps.userRepo),
    gateMustChangePassword()
  );

  app.get("/api/chart-data", async (c) => {
    const parsed = ChartRequestSchema.safeParse({
      symbol: c.req.query("symbol"),
      market: c.req.query("market") ?? undefined,
      type: c.req.query("type"),
      period: c.req.query("period") ?? undefined,
      start: c.req.query("start") ?? undefined,
      end: c.req.query("end") ?? undefined,
      compareSymbol: c.req.query("compareSymbol") ?? undefined,
    });
    if (!parsed.success) {
      return c.json(
        { error: "invalid_input", issues: parsed.error.issues },
        400
      );
    }
    const req = parsed.data;
    const credentials: ChartFetchCredentials = {
      fuyao: {
        baseUrl: config.fuyao.baseUrl,
        apiKey: config.fuyao.apiKey,
      },
      ifind: {
        baseUrl: config.ifind.baseUrl,
        authorization: config.ifind.authorization,
      },
      timeoutMs: 8000,
    };

    const availability = chartProviderAvailability(credentials);
    let primary: ChartFetchResult | null = null;

    // Default path: Fuyao direct API. Only fall through to iFinD on a
    // retryable / capability gap, never on a synthetic blank chart.
    if (req.type === "kline" || req.type === "timeline") {
      primary = await fetchFuyaoKline(req, credentials.fuyao);
      if (
        primary.status === "unavailable" ||
        primary.status === "transient_error"
      ) {
        const fallback = await fetchIFindKline(req, credentials.ifind);
        if (fallback.status === "ok") primary = fallback;
        // If iFinD also fails, keep the Fuyao envelope — it carries the
        // more useful diagnostic copy.
      }
      if (!availability.fuyao && !availability.ifind && primary?.status !== "ok") {
        // Real credentials are required to ever return `status: "ok"`.
        // Mock-mode (NODE_ENV !== production) keeps the demo path alive
        // with a clearly labelled `source: "fallback"` synthetic series;
        // production must NEVER silently invent data and must surface
        // the explicit `unavailable` envelope so the UI shows the
        // degraded card. The trigger explicitly forbids mock faking
        // success under real credentials.
        if (config.isProduction) {
          primary = {
            status: "unavailable",
            message:
              "未配置 Fuyao / iFinD 直连凭据，K 线图表暂不可用。复盘结论仍可继续生成。",
          };
        } else {
          const synthetic = fallbackKlineSeries(req);
          primary = { status: "ok", series: synthetic };
        }
      }
    } else if (req.type === "compare") {
      // Comparison series: fetch the primary and the baseline, then
      // combine them into a `mixed`-source envelope. We only enable
      // this path when the primary is a kline request with a baseline.
      const primaryReq = { ...req, type: "kline" as const };
      const fetched = await fetchFuyaoKline(primaryReq, credentials.fuyao);
      if (fetched.status === "ok" && req.compareSymbol) {
        const baselineReq = { ...primaryReq, symbol: req.compareSymbol };
        const baseline = await fetchFuyaoKline(baselineReq, credentials.fuyao);
        if (baseline.status === "ok") {
          const pctPrimary = toPercentLine(fetched.series!);