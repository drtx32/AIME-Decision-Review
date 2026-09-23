/**
 * Settings / usage / model-capability routes.
 *
 * Surface (ELI-360):
 *   GET    /api/settings/server-model
 *                            — read the server-managed LLM provider config
 *                              (driven by LLM_* env). The AIME backend never
 *                              stores, logs, echoes, or fingerprints a
 *                              user-supplied BYOK. User-side BYOK lives in
 *                              the browser (IndexedDB) and only ever crosses
 *                              the network browser -> provider directly.
 *   GET    /api/usage        — token-usage summary derived from
 *                              usage_events. Per-user allowance is
 *                              operator-configured (env-driven), never
 *                              derived from a user-supplied key.
 *   GET    /api/models/capabilities
 *                            — provider/model capability metadata.
 *
 * Removed in ELI-360:
 *   - PUT    /api/settings/model       (was: upsert with encrypted apiKey)
 *   - POST   /api/auth/model           (was: upsert with encrypted apiKey)
 *   - POST   /api/auth/model/test      (was: forward user key to provider)
 *   - DELETE /api/auth/model           (was: clear stored ciphertext)
 *   - GET    /api/auth/model           (was: echo fingerprint / keySuffix)
 *   These endpoints returned 410 Gone if reached via a stale frontend
 *   bundle. Browser now manages BYOK directly and never speaks to AIME
 *   about the secret.
 *
 * Identity is always derived from the session cookie (handled upstream
 * by attachUser + requireAuth); we never trust a client-supplied userId.
 */

import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.ts";
import type { SettingsRepository } from "./repository.ts";
import { getModelCapabilities } from "./capabilities.ts";
import type { UsagePayload } from "./types.ts";

export interface SettingsDeps {
  settingsRepo: SettingsRepository;
}

const REMOVED_ENDPOINT_NOTICE =
  "This endpoint was removed in ELI-360: the AIME backend no longer accepts, " +
  "stores, or proxies user-supplied API keys. Configure BYOK in the browser " +
  "(Settings → Model & API) — your key stays in browser-local storage and " +
  "only crosses the wire browser → provider directly.";

/**
 * Read-only view of the server-managed LLM provider config (env-driven).
 *
 * The frontend uses this to surface the "current server default" row in
 * Settings → Model & API alongside the browser-local BYOK editor. We
 * NEVER return a user-bound `configured / keySuffix / apiKeyFingerprint`
 * — the server has no per-user key material after ELI-360.
 */
export interface ServerModelInfo {
  provider: string;
  model: string;
  baseUrl: string | null;
  /** True if the server-managed provider has both baseUrl and apiKey. */
  configured: boolean;
}

export function buildServerModelRoute(deps: {
  resolve: () => ServerModelInfo;
}): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("*", async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (user.mustChangePassword) {
      return c.json({ error: "must_change_password" }, 403);
    }
    await next();
  });
  app.get("/", (c) => c.json(deps.resolve()));
  return app;
}

/**
 * Stub that returns 410 Gone for any of the ELI-360-removed endpoints
 * (PUT /api/settings/model, /api/auth/model GET/POST/DELETE,
 * /api/auth/model/test). This is mounted so a stale frontend bundle
 * cannot silently "succeed" by hitting a path the server used to honour.
 */
export function buildRemovedModelEndpoints(): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.all("*", async (c) => {
    return c.json(
      {
        error: "endpoint_removed",
        code: "byok_browser_local",
        message: REMOVED_ENDPOINT_NOTICE,
      },
      410
    );
  });
  return app;
}

export function buildUsageRoute(deps: SettingsDeps) {
  const app = new Hono<AuthEnv>();
  app.use("*", async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (user.mustChangePassword) {
      return c.json({ error: "must_change_password" }, 403);
    }
    await next();
  });

  app.get("/", (c) => {
    const user = c.get("user")!;
    const payload = computeUsage(deps.settingsRepo, user.id);
    return c.json(payload);
  });

  return app;
}

export function buildCapabilitiesRoute() {
  const app = new Hono<AuthEnv>();
  app.use("*", async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (user.mustChangePassword) {
      return c.json({ error: "must_change_password" }, 403);
    }
    await next();
  });

  app.get("/", (c) => {
    return c.json(getModelCapabilities());
  });

  return app;
}

// ── helpers ────────────────────────────────────────────────────────────────

const DEFAULT_PERIOD_DAYS = 30;

function computeUsage(repo: SettingsRepository, userId: string): UsagePayload {
  const now = new Date();
  const configured = repo.getUsagePeriod(userId);
  let period: { start: string; end: string; resetAt: string };
  let allowanceTokens: number | null;
  if (configured) {
    period = {
      start: configured.periodStart,
      end: configured.periodEnd,
      resetAt: configured.resetAt,
    };
    allowanceTokens = configured.allowanceTokens;
  } else {
    // No operator-configured period yet. Fall back to a rolling 30-day
    // window with an explicitly unknown allowance. The frontend can
    // detect `source: "unknown"` and render the "Unknown" state instead
    // of guessing a quota we cannot verify.
    const start = new Date(now.getTime() - DEFAULT_PERIOD_DAYS * 24 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + DEFAULT_PERIOD_DAYS * 24 * 60 * 60 * 1000);
    period = {
      start: start.toISOString(),
      end: end.toISOString(),
      resetAt: end.toISOString(),
    };
    allowanceTokens = null;
  }

  const consumed = repo.sumConsumedTokensSince(userId, period.start, period.end);
  const recent = repo.recentUsage(userId, 20).map((e) => ({
    reviewId: e.reviewId,
    kind: e.kind,
    promptTokens: e.promptTokens,
    completionTokens: e.completionTokens,
    totalTokens: e.promptTokens + e.completionTokens,
    at: e.at,
  }));

  const knownAllowance = allowanceTokens !== null && allowanceTokens !== undefined;
  return {
    period,
    allowance: {
      tokens: knownAllowance ? allowanceTokens : null,
      source: knownAllowance ? "configured" : "unknown",
    },
    consumed: {
      tokens: consumed.tokens,
      lastUpdatedAt: consumed.lastUpdatedAt,
    },
    remaining: {
      tokens: knownAllowance ? Math.max(0, allowanceTokens! - consumed.tokens) : null,
      known: knownAllowance,
    },
    recent,
  };
}