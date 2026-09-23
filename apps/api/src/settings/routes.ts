/**
 * Settings / usage / model-capability routes.
 *
 * Surface:
 *   GET    /api/settings/model    — read the current user's model config
 *   PUT    /api/settings/model    — upsert (encrypts apiKey at rest)
 *   GET    /api/usage             — quota summary + recent events
 *   GET    /api/models/capabilities — provider/model capability metadata
 *
 * Identity is always derived from the session cookie (handled upstream
 * by attachUser + requireAuth); we never trust a client-supplied
 * userId on these endpoints.
 *
 * Secret redaction contract:
 *   - The plaintext API key never appears in any response, log, or
 *     error message. Only `hasApiKey: boolean` and
 *     `apiKeyFingerprint: "abcd…efgh"` are returned.
 *   - If a key is supplied on PUT but no secret-encryption handle is
 *     available, the request is rejected with 503 / `secret_store_unavailable`
 *     rather than silently downgrading to plaintext persistence.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "../auth/middleware.ts";
import type { SettingsRepository } from "./repository.ts";
import { loadSecretKey } from "./crypto.ts";
import { getModelCapabilities } from "./capabilities.ts";
import type { ModelSettingsPayload, UsagePayload, SettingsProvider } from "./types.ts";

export interface SettingsDeps {
  settingsRepo: SettingsRepository;
}

const PutSettingsSchema = z
  .object({
    provider: z.enum(["openai-compatible", "mock"]),
    model: z.string().min(1).max(128),
    baseUrl: z
      .string()
      .trim()
      .max(512)
      .refine((v) => v === "" || /^https?:\/\//i.test(v), {
        message: "baseUrl must be empty or an http(s) URL",
      })
      .optional()
      .transform((v) => (v === undefined || v === "" ? null : v)),
    /**
     * Plaintext API key. Optional on PUT — if omitted the existing
     * ciphertext is preserved, so the Settings UI can rotate
     * model/baseUrl without forcing re-entry.
     *
     * Empty string is treated as "clear the stored key".
     */
    apiKey: z.string().max(4096).optional(),
    /**
     * Optional period configuration for the quota summary. Operators
     * can set / clear the allowance; the API never fabricates one.
     */
    period: z
      .object({
        start: z.string().datetime({ offset: true }),
        end: z.string().datetime({ offset: true }),
        resetAt: z.string().datetime({ offset: true }),
        allowanceTokens: z.number().int().nonnegative().nullable(),
      })
      .optional(),
  })
  .strict();

export function buildSettingsRoutes(deps: SettingsDeps) {
  const app = new Hono<AuthEnv>();

  // Inline auth gate — mustChangePassword users are blocked from the
  // Settings surface until they complete the first-login password change.
  // requireAuth() in the auth middleware is intentionally not reused here
  // because the upstream signature takes the UserRepository (used for
  // account-disable cleanup that does not apply to settings routes).
  app.use("*", async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (user.mustChangePassword) {
      return c.json({ error: "must_change_password" }, 403);
    }
    await next();
  });

  app.get("/model", (c) => {
    const user = c.get("user")!;
    const row = deps.settingsRepo.getModelSettings(user.id);
    return c.json(row ? toPublicPayload(row) : defaultPayloadFor(user.username));
  });

  app.put("/model", async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json().catch(() => null);
    const parsed = PutSettingsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
    }
    const input = parsed.data;

    // Mock provider is intentionally non-configurable: reject any attempt
    // to attach a baseUrl / apiKey to it. The capability metadata already
    // documents this.
    if (input.provider === "mock") {
      if (input.baseUrl || (input.apiKey && input.apiKey.length > 0)) {
        return c.json(
          {
            error: "mock_not_configurable",
            message:
              "The mock provider does not accept a baseUrl or apiKey. Use provider='openai-compatible' for real credentials.",
          },
          400
        );
      }
    }

    let apiKeyCiphertext: string | null | undefined;
    let apiKeyFingerprint: string | null | undefined;

    if (input.apiKey !== undefined) {
      if (input.apiKey === "") {
        // Explicit clear.
        apiKeyCiphertext = null;
        apiKeyFingerprint = null;
      } else {
        const key = loadSecretKey();
        if (!key) {
          return c.json(
            {
              error: "secret_store_unavailable",
              message:
                "Server is not configured to store user-supplied API keys securely. " +
                "Set AIME_SECRET_ENC_KEY (or supply INITIAL_ADMIN_PASSWORD) so the API " +
                "can encrypt the key at rest. The plaintext was NOT persisted.",
            },
            503
          );
        }
        const ciphertext = key.encrypt(input.apiKey);
        apiKeyCiphertext = ciphertext;
        apiKeyFingerprint = key.fingerprint(ciphertext);
      }
    }

    const row = deps.settingsRepo.saveModelSettings({
      userId: user.id,
      provider: input.provider,
      model: input.model,
      baseUrl: input.baseUrl ?? null,
      apiKeyCiphertext,
      apiKeyFingerprint,
    });

    if (input.period) {
      deps.settingsRepo.upsertUsagePeriod({
        userId: user.id,
        periodStart: input.period.start,
        periodEnd: input.period.end,
        resetAt: input.period.resetAt,
        allowanceTokens: input.period.allowanceTokens,
      });
    }

    return c.json(toPublicPayload(row));
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
  // Capabilities is a static, non-secret registry — keep it behind
  // requireAuth so it lines up with the rest of the Settings surface.
  // mustChangePassword users are blocked too so the gate is uniform:
  // the Settings UI is not usable until the first-login password change
  // is complete, and exposing the model picker early would let the user
  // commit to a model they cannot actually use yet.
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

function toPublicPayload(row: {
  userId: string;
  provider: SettingsProvider;
  model: string;
  baseUrl: string | null;
  apiKeyCiphertext: string | null;
  apiKeyFingerprint: string | null;
  updatedAt: string;
}): ModelSettingsPayload {
  return {
    provider: row.provider,
    model: row.model,
    baseUrl: row.baseUrl,
    hasApiKey: row.apiKeyCiphertext !== null && row.apiKeyCiphertext.length > 0,
    apiKeyFingerprint: row.apiKeyFingerprint,
    updatedAt: row.updatedAt,
  };
}

function defaultPayloadFor(username: string): ModelSettingsPayload {
  // No row on file — return the documented default that the Settings UI
  // should pre-fill (matches the env-driven default at startup).
  // The username is intentionally ignored here; we keep the parameter so
  // future server-side defaults can branch on it without changing the
  // public contract.
  void username;
  return {
    provider: "mock",
    model: "mvp-mock-model",
    baseUrl: null,
    hasApiKey: false,
    apiKeyFingerprint: null,
    updatedAt: new Date(0).toISOString(),
  };
}

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
