/**
 * Hono routes — /api/reviews/* + /api/auth/* + /api/admin/* + /api/settings/* + /health.
 *
 * All non-auth, non-health endpoints require an authenticated session.
 * mustChangePassword users are blocked from review endpoints and admin
 * endpoints — they may only hit /api/auth/*.
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { DecisionInputSchema } from "../types/index.ts";
import type { AppConfig } from "../config.ts";
import type { ReviewRepository } from "../db/sqlite.ts";
import type { UserRepository } from "../auth/repository.ts";
import type { McpRegistry } from "../mcp/registry.ts";
import { DecisionReviewAgent } from "../agents/decision-review.ts";
import type { ModelProvider } from "../providers/index.ts";
import { attachUser, requireAuth, gateMustChangePassword, rejectClientUserIdHeader, requireAdmin, type AuthEnv } from "../auth/middleware.ts";
import { buildAuthRoutes } from "../auth/routes.ts";
import { buildAdminRoutes } from "../auth/admin.ts";
import { QuotaExceededError, type QuotaRepository, type QuotaService } from "../quota/repository.ts";

export interface RouteDeps {
  config: AppConfig;
  repo: ReviewRepository;
  userRepo: UserRepository;
  registry: McpRegistry;
  provider: ModelProvider;
  quota: QuotaService;
  quotaRepo: QuotaRepository;
  /** Test hook — bypass background execution so specs stay deterministic. */
  runSync?: boolean;
}

type AppEnv = { Variables: AuthEnv["Variables"] };

export function buildApi(deps: RouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const config = deps.config;
  const auth = buildAuthRoutes(deps.userRepo, config.isProduction);
  const admin = buildAdminRoutes(deps.userRepo);

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
      configuredServers: deps.registry.configuredKeys(),
      time: new Date().toISOString(),
    });
  });

  // Public auth endpoints (login + change-password self-service) live here.
  app.route("/api/auth", auth);

  // Review endpoints — require an authenticated, non-mustChangePassword user.
  app.use("/api/reviews/*", requireAuth(deps.userRepo), gateMustChangePassword());

  app.post("/api/reviews", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);

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

    // Pre-flight quota check. We only block here if the user's bucket is
    // already exhausted; otherwise the agent will re-check inside its
    // bounded estimate before each LLM call. This avoids burning provider
    // budget when the user has clearly run out.
    const snapshot = deps.quota.snapshot(user.id);
    if (snapshot.disabled) {
      return c.json(
        {
          error: "DAILY_TOKEN_QUOTA_EXCEEDED",
          message:
            "Daily token quota is disabled (PLATFORM_DAILY_TOKEN_QUOTA=0). Ask the platform admin to enable it.",
          quota: snapshot,
        },
        429
      );
    }

    const id = `rev_${randomUUID()}`;
    const T0 = decision.executedAt;
    deps.repo.createRun(id, decision, T0);

    const agent = new DecisionReviewAgent({
      repo: deps.repo,
      registry: deps.registry,
      provider: deps.provider,
      config: deps.config,
      quota: deps.quota,
    });
    // Bind the authenticated user identity to this run. Identity is
    // derived from the session cookie (set by attachUser), never from a
    // client-supplied x-user-id header (rejected by rejectClientUserIdHeader).
    agent.bindRunOwner(user.id);

    if (deps.runSync) {
      try {
        await agent.run(id, decision);
      } catch (e) {
        if (e instanceof QuotaExceededError) {
          deps.repo.updateStatus(id, "failed", {
            errorMessage: `${e.code}: ${e.message}`,
            finishedAt: new Date().toISOString(),
          });
          return c.json(
            {
              error: e.code,
              message: e.message,
              quota: deps.quota.snapshot(user.id),
            },
            429
          );
        }
        deps.repo.updateStatus(id, "failed", {
          errorMessage: e instanceof Error ? e.message : String(e),
          finishedAt: new Date().toISOString(),
        });
      }
    } else {
      // Fire-and-forget; clients poll /api/reviews/:id for progress.
      agent.run(id, decision).catch((e) => {
        if (e instanceof QuotaExceededError) {
          deps.repo.updateStatus(id, "failed", {
            errorMessage: `${e.code}: ${e.message}`,
            finishedAt: new Date().toISOString(),
          });
          return;
        }
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

  // Settings endpoints — require an authenticated, non-mustChangePassword user.
  app.use(
    "/api/settings/*",
    requireAuth(deps.userRepo),
    gateMustChangePassword()
  );

  // Per-user quota snapshot — visible to every authenticated user.
  app.get("/api/settings/quota", (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    return c.json({ quota: deps.quota.snapshot(user.id) });
  });

  // Model & Usage — admin only. Shows provider status (no API key), the
  // configured quota, the admin's own usage, and an aggregate per-user
  // usage table for today.
  app.get(
    "/api/settings/model",
    requireAdmin(deps.userRepo),
    (c) => {
      const user = c.get("user");
      if (!user) return c.json({ error: "unauthenticated" }, 401);
      const providerInfo = {
        id: deps.provider.id,
        modelName: deps.provider.modelName,
        configured: deps.config.llm.provider !== "mock" || Boolean(deps.config.llm.baseUrl),
        // Sanitize the base URL so secrets embedded in the path (very rare
        // but possible) cannot leak. Only the host is exposed.
        baseHost: safeBaseHost(deps.config.llm.baseUrl),
      };
      const quota = deps.quota.snapshot(user.id);
      const aggregate = deps.quota.listUserUsage((id) => {
        const row = deps.userRepo.findById(id);
        if (!row) return null;
        return { username: row.username, role: row.role };
      });
      return c.json({
        provider: providerInfo,
        quota: {
          configured: deps.config.platformDailyTokenQuota,
          source: "PLATFORM_DAILY_TOKEN_QUOTA",
          note:
            deps.config.platformDailyTokenQuota === 0
              ? "Free tier disabled; users cannot run reviews."
              : "Free tier active; per-user daily limit.",
        },
        usage: {
          self: quota,
          aggregate,
        },
      });
    }
  );

  return app;
}

/**
 * Extract just the host (and optional port) from a base URL. Never return
 * the full URL because it can carry credentials in the userinfo segment
 * (https://user:key@host/v1). Returning only the host keeps the UI
 * informative while preventing accidental key leak.
 */
function safeBaseHost(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.host;
  } catch {
    return null;
  }
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