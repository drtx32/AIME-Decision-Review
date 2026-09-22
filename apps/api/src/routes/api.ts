/**
 * Hono routes — /api/reviews/* + /api/auth/* + /api/admin/* + /health.
 *
 * All non-auth, non-health endpoints require an authenticated session.
 * mustChangePassword users are blocked from review endpoints and admin
 * endpoints — they may only hit /api/auth/*.
 *
 * ELI-326 resilience:
 *   - /health stays 200 even when the LLM provider is missing or broken,
 *     and surfaces `provider_configured` + `provider_status` instead.
 *   - POST /api/reviews does a pre-flight on provider availability. If the
 *     provider is unconfigured the request is rejected with HTTP 503 +
 *     stable code `MODEL_NOT_CONFIGURED` before any DB write or run is
 *     created. If the provider is configured but the live call fails, the
 *     request returns 503/502 with a stable code and a sanitized message.
 *   - Provider failures never crash the process. The agent catches typed
 *     ProviderError, marks the run as failed, and persists a sanitized
 *     error message — secrets never reach the trace or response.
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
import { getProviderAvailability } from "../providers/index.ts";
import type { ProviderError } from "../providers/errors.ts";
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

  app.use("*", attachUser(deps.userRepo));

  // Identity-contract guard — must run BEFORE requireAuth so a forged
  // x-user-id header is rejected even if a future route forgets the auth
  // gate. Runs after attachUser so it doesn't interfere with /health or
  // /api/auth/login response paths.
  app.use("/api/*", rejectClientUserIdHeader());

  app.get("/health", (c) => {
    const availability = getProviderAvailabilityFromDeps(deps);
    // Health is a coarse liveness/readiness check: do NOT fail the
    // container when LLM config is missing. The frontend uses
    // provider_status to render the admin-contact banner.
    return c.json({
      status: "ok",
      // Backwards-compatible field — older clients still read this.
      provider: availability.providerId ?? "none",
      // ELI-326 readiness surface — never includes secrets.
      provider_configured: availability.state === "ready",
      provider_status: availability.state,
      provider_id: availability.providerId,
      provider_model: availability.model,
      requested_mode: availability.requestedMode,
      degraded: availability.degraded,
      configuredServers: deps.registry.configuredKeys(),
      time: new Date().toISOString(),
      // Surface only sanitized fields. No api key, no Authorization header,
      // no raw provider error body.
      last_error: availability.lastError
        ? {
            code: availability.lastError.code,
            kind: availability.lastError.kind,
            retryable: availability.lastError.retryable,
            correlationId: availability.lastError.correlationId,
            providerStatus: availability.lastError.providerStatus,
            message: availability.lastError.sanitizedMessage,
          }
        : null,
    });
  });

  // Public auth endpoints (login + change-password self-service) live here.
  app.route("/api/auth", auth);

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

    // Provider pre-flight: refuse early when no real provider is
    // configured. This is the ELI-326 contract — the API must stay
    // healthy, but review creation must surface a stable 503 instead of
    // silently running the mock vertical slice in production.
    const availability = getProviderAvailabilityFromDeps(deps);
    if (availability.state === "unconfigured") {
      return c.json(providerUnavailableBody(availability, "MODEL_NOT_CONFIGURED"), 503);
    }
    if (availability.state === "error") {
      const last = availability.lastError;
      if (last && last.code === "MODEL_AUTH_FAILED") {
        return c.json(providerUnavailableBody(availability, last.code), last.httpStatus);
      }
    }

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
          errorMessage: sanitizeProviderErrorMessage(e),
          finishedAt: new Date().toISOString(),
        });
      }
    } else {
      // Fire-and-forget; clients poll /api/reviews/:id for progress.
      agent.run(id, decision).catch((e) => {
        deps.repo.updateStatus(id, "failed", {
          errorMessage: sanitizeProviderErrorMessage(e),
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

/**
 * Read the provider's availability via the static helper. The route deps
 * always carry a fully-constructed provider, but we re-derive availability
 * so /health and POST share one definition of state.
 */
function getProviderAvailabilityFromDeps(deps: RouteDeps) {
  return getProviderAvailability(deps.config);
}

function providerUnavailableBody(
  availability: ReturnType<typeof getProviderAvailability>,
  code: ProviderError["code"]
) {
  const last = availability.lastError;
  return {
    error: code,
    code,
    retryable: last?.retryable ?? false,
    provider_status: availability.state,
    provider_id: availability.providerId,
    requested_mode: availability.requestedMode,
    correlationId: last?.correlationId ?? null,
    // Stable user-facing message in Chinese per ELI-326. The frontend
    // surfaces this verbatim. Frontends must NOT display stack traces or
    // provider-internal error bodies on this code.
    message:
      "当前未配置可用的大模型服务，请联系管理员配置模型供应商/API Key 后重试。",
  };
}

/**
 * Convert any ProviderError / unknown failure into a safe string for the
 * `errorMessage` column. We deliberately do NOT serialize the whole
 * ProviderError — only the code + sanitized message + correlation id. No
 * secrets, no Authorization headers, no raw fetch body.
 */
function sanitizeProviderErrorMessage(e: unknown): string {
  if (e && typeof e === "object" && "code" in e && "sanitizedMessage" in e) {
    const pe = e as ProviderError;
    return `${pe.code}: ${pe.sanitizedMessage} (correlationId=${pe.correlationId})`;
  }
  if (e instanceof Error) {
    // Best-effort fallback: strip anything that looks like a bearer token.
    const msg = e.message ?? String(e);
    return `provider_failed: ${redactSecrets(msg)}`;
  }
  return "provider_failed: unknown error";
}

const SECRET_LIKE = /(?:sk-[A-Za-z0-9_\-]{8,}|Bearer\s+[A-Za-z0-9_\-]{8,}|Authorization:\s*[^\s,;]+)/gi;

function redactSecrets(s: string): string {
  return s.replace(SECRET_LIKE, "[REDACTED]");
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