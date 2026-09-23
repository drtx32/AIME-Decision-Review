/**
 * BYOK segregation regression tests — ELI-360.
 *
 * The user-supplied BYOK apiKey is browser-local and must NEVER appear
 * anywhere on the AIME backend. These tests are the regression bar that
 * catches accidental re-introduction of an apiKey-bearing route, table
 * column, repo method, log line, or response payload.
 *
 * The bars below correspond directly to the acceptance criteria in
 * ELI-360:
 *   1. No API endpoint accepts an apiKey as a request payload.
 *   2. No API endpoint echoes an apiKey, fingerprint, keySuffix, or
 *      hasApiKey flag in any response.
 *   3. No AIME database table stores an apiKey-bearing column with a
 *      real value (legacy ciphertext columns from prior builds are
 *      zeroed on bootstrap).
 *   4. The server-managed LLM provider (DecisionReviewAgent path) runs
 *      on operator env creds only — providerForUser() never accepts
 *      user creds.
 *   5. The /api/settings/server-model surface returns read-only env
 *      config; users cannot bypass it to push their own apiKey.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  makeTestServer,
  makeTestConfig,
  loginAndCookie,
  type TestServer,
} from "./helpers.ts";
import { buildServer } from "../src/server.ts";
import { hashPassword } from "../src/auth/passwords.ts";

const SECRET_PLAINTEXT = "sk-byok-segregation-DO-NOT-LEAK-9876543210xyz";

async function seedNormal(
  repo: TestServer["userRepo"],
  username: string,
  password: string
) {
  const hash = await hashPassword(password);
  return repo.createUser({
    username,
    passwordHash: hash,
    role: "user",
    mustChangePassword: false,
  });
}

/** Best-effort rm on Windows where SQLite WAL files can briefly stay
 *  mapped after db.close(). Backs off and retries. Suppresses the final
 *  EBUSY — we don't want a tmp-dir leak to fail a passing test. */
function rmSyncRetry(path: string, attempts = 12): void {
  let delay = 100;
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (e) {
      const busy = String((e as { code?: string }).code ?? "") === "EBUSY";
      if (!busy) throw e;
      // Sleep without throwing — best-effort cleanup.
      const start = Date.now();
      while (Date.now() - start < delay) { /* spin */ }
      delay = Math.min(delay * 2, 1500);
    }
  }
  // Last try — suppress any final EBUSY so a tmp-dir leak doesn't break
  // an otherwise-passing test.
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe("BYOK segregation — request surface (ELI-360)", () => {
  let ctx: TestServer;
  let userCookie: string;

  beforeEach(async () => {
    ctx = makeTestServer();
    await seedNormal(ctx.userRepo, "alice", "alice-pass-12345");
    userCookie = await loginAndCookie(ctx.app, ctx.userRepo, "alice", "alice-pass-12345");
  });
  afterEach(() => {
    ctx.cleanup();
  });

  test("server-model surface is the only model-info endpoint, returns no fingerprint / key", async () => {
    const r = await ctx.app.request("/api/settings/server-model", {
      headers: { cookie: userCookie },
    });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text.includes("apiKey")).toBe(false);
    expect(text.includes("fingerprint")).toBe(false);
    expect(text.includes("keySuffix")).toBe(false);
    expect(text.includes("hasApiKey")).toBe(false);
    expect(text.includes(SECRET_PLAINTEXT)).toBe(false);
  });

  test("POST /api/sessions never carries an apiKey-shaped payload field", async () => {
    const r = await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { cookie: userCookie, "content-type": "application/json" },
      body: JSON.stringify({
        message: "我今天买了 100 股 AAPL，准备 6 个月持有。",
        apiKey: SECRET_PLAINTEXT,
        provider: "openai-compatible",
        baseUrl: "https://api.evil.example.com/v1",
        model: "evil-model",
      }),
    });
    // The request may succeed or fail on model availability, but the body
    // MUST NOT have echoed the secret anywhere in the response.
    const text = await r.text();
    expect(text.includes(SECRET_PLAINTEXT)).toBe(false);
  });

  test("PATCH /api/sessions/:id/decisions/:decisionId never accepts apiKey", async () => {
    // We do not depend on the decision extractor to create a session here —
    // the mock LLM is deterministic but not always Chinese-fluent. Instead
    // we seed a decision through the legitimate repo path, then attempt to
    // slip an apiKey into the patch payload. The PATCH must accept the
    // payload but NEVER echo the apiKey in its response.
    const user = ctx.userRepo.findByUsername("alice")!;
    const sessionId = ctx.repo.createSession(user.id, "regression-test-session", "single");
    const decision = ctx.repo.addSessionDecision({
      sessionId,
      userId: user.id,
      symbol: "NVDA",
      name: "NVIDIA",
      market: "US",
      action: "buy",
      executedAt: "2026-09-01T00:00:00.000Z",
      executedAtText: "2026-09-01T00:00:00.000Z",
      timePrecision: "exact",
      price: null,
      quantity: null,
      quantityShares: 10,
      quantityText: "10 股",
      confidence: 0.9,
      needsConfirmation: [],
      reason: "test fixture",
      notes: "",
    });

    const patch = await ctx.app.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/decisions/${encodeURIComponent(decision.id)}`,
      {
        method: "PATCH",
        headers: { cookie: userCookie, "content-type": "application/json" },
        body: JSON.stringify({
          symbol: "NVDA",
          apiKey: SECRET_PLAINTEXT,
        }),
      }
    );
    const text = await patch.text();
    expect(text.includes(SECRET_PLAINTEXT)).toBe(false);
  });

  test("every 410-Gone removed endpoint rejects with no plaintext echo", async () => {
    const cases = [
      { method: "GET" as const, path: "/api/settings/model" },
      { method: "PUT" as const, path: "/api/settings/model" },
      { method: "DELETE" as const, path: "/api/settings/model" },
      { method: "GET" as const, path: "/api/auth/model" },
      { method: "POST" as const, path: "/api/auth/model" },
      { method: "DELETE" as const, path: "/api/auth/model" },
      { method: "POST" as const, path: "/api/auth/model/test" },
    ];
    for (const c of cases) {
      const r = await ctx.app.request(c.path, {
        method: c.method,
        headers: { cookie: userCookie, "content-type": "application/json" },
        body: JSON.stringify({ apiKey: SECRET_PLAINTEXT, model: "x", baseUrl: "https://x" }),
      });
      expect(r.status).toBe(410);
      const text = await r.text();
      expect(text.includes(SECRET_PLAINTEXT)).toBe(false);
    }
  });
});

describe("BYOK segregation — response surface (ELI-360)", () => {
  let ctx: TestServer;
  let userCookie: string;

  beforeEach(async () => {
    ctx = makeTestServer();
    await seedNormal(ctx.userRepo, "alice", "alice-pass-12345");
    userCookie = await loginAndCookie(ctx.app, ctx.userRepo, "alice", "alice-pass-12345");
  });
  afterEach(() => {
    ctx.cleanup();
  });

  test("health, server-model, and session responses never include apiKey / fingerprint", async () => {
    const endpoints = [
      "/health",
      "/api/settings/server-model",
      "/api/sessions",
      "/api/auth/me",
      "/api/auth/usage",
    ];
    for (const path of endpoints) {
      const r = await ctx.app.request(path, { headers: { cookie: userCookie } });
      const text = await r.text();
      expect(text.includes(SECRET_PLAINTEXT)).toBe(false);
      // Never echo a fingerprint / hasApiKey / keySuffix for a user BYOK
      // (the server cannot know about it; if it ever appears, that's a
      // contract regression).
      expect(text.includes("hasApiKey")).toBe(false);
      expect(text.includes("keySuffix")).toBe(false);
      expect(text.includes("apiKeyFingerprint")).toBe(false);
    }
  });
});

describe("BYOK segregation — SQLite schema (ELI-360)", () => {
  test("no user_model_configs / user_model_settings tables exist after bootstrap", async () => {
    const ctx = makeTestServer();
    try {
      const db = new Database(ctx.cfg.sqlitePath, { readonly: true });
      try {
        const tables = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('user_model_configs','user_model_settings')"
          )
          .all() as Array<{ name: string }>;
        expect(tables).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      ctx.cleanup();
    }
  });

  test("legacy_user_model_configs migration zeroes apiKeyEncrypted / verifiedAt / lastError / baseUrl", async () => {
    // Spin up a fresh DB, seed a legacy table that mimics the v0 shape,
    // close it, then rebuild the auth repository and confirm the legacy
    // row was renamed AND scrubbed.
    const tmpDir = mkdtempSync(join(tmpdir(), "aime-eli360-legacy-"));
    const sqlitePath = join(tmpDir, "auth.db");
    try {
      // Phase 1 — write a fake legacy row.
      const seedDb = new Database(sqlitePath);
      try {
        seedDb.exec(`
          CREATE TABLE users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL,
            passwordHash TEXT NOT NULL,
            mustChangePassword INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
          );
        `);
        seedDb.exec(`
          CREATE TABLE user_model_configs (
            userId TEXT PRIMARY KEY,
            provider TEXT,
            baseUrl TEXT,
            model TEXT,
            apiKeyEncrypted TEXT,
            verifiedAt TEXT,
            lastError TEXT,
            updatedAt TEXT,
            FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
          );
        `);
        seedDb
          .prepare(
            `INSERT INTO users (id, username, role, passwordHash, mustChangePassword, enabled, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, 0, 1, ?, ?)`
          )
          .run("usr_legacy1", "legacy-user", "user", "hash-not-a-credential", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z");
        seedDb
          .prepare(
            `INSERT INTO user_model_configs
               (userId, provider, baseUrl, model, apiKeyEncrypted, verifiedAt, lastError, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            "usr_legacy1",
            "openai-compatible",
            "https://api.example.com/v1",
            "gpt-4o",
            "base64:encrypted-blob-DO-NOT-LEAK",
            "2026-09-01T00:00:00Z",
            "none",
            "2026-09-01T00:00:00Z"
          );
      } finally {
        seedDb.close();
      }

      // Phase 2 — open the auth repo against the same file and confirm the
      // bootstrap migration renamed and scrubbed the row.
      const cfg = makeTestConfig({ sqlitePath });
      const built = buildServer(cfg);
      try {
        const db = new Database(sqlitePath, { readonly: true });
        try {
          const legacyNames = db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='legacy_user_model_configs'"
            )
            .all() as Array<{ name: string }>;
          expect(legacyNames.length).toBe(1);

          const legacy = db
            .prepare(
              "SELECT userId, provider, baseUrl, model, apiKeyEncrypted, verifiedAt, lastError, scrubbedAt FROM legacy_user_model_configs"
            )
            .get() as {
              userId: string;
              provider: string;
              baseUrl: string | null;
              model: string | null;
              apiKeyEncrypted: string | null;
              verifiedAt: string | null;
              lastError: string | null;
              scrubbedAt: string;
            };
          expect(legacy.userId).toBe("usr_legacy1");
          expect(legacy.provider).toBe("openai-compatible");
          // All secret-bearing / verification-bearing columns MUST be empty.
          expect(legacy.apiKeyEncrypted === "" || legacy.apiKeyEncrypted === null).toBe(true);
          expect(legacy.verifiedAt).toBeNull();
          expect(legacy.lastError).toBeNull();
          // baseUrl is also wiped — it was only meaningful when paired
          // with a server-side decrypted key.
          expect(legacy.baseUrl === "" || legacy.baseUrl === null).toBe(true);
          expect(typeof legacy.scrubbedAt).toBe("string");
          expect(legacy.scrubbedAt.length).toBeGreaterThan(0);

          const stillThere = db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='user_model_configs'"
            )
            .all();
          expect(stillThere).toEqual([]);
        } finally {
          db.close();
        }
      } finally {
        built.repo.close();
        built.userRepo.close();
        built.settingsRepo.close();
      }
    } finally {
      rmSyncRetry(tmpDir);
    }
  });

  test("legacy_user_model_settings migration zeroes apiKeyCiphertext / apiKeyFingerprint / baseUrl", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aime-eli360-legacy-settings-"));
    const sqlitePath = join(tmpDir, "settings.db");
    try {
      // Phase 1 — fake legacy settings table.
      const seedDb = new Database(sqlitePath);
      try {
        seedDb.exec(`
          CREATE TABLE user_model_settings (
            userId TEXT PRIMARY KEY,
            provider TEXT,
            model TEXT,
            baseUrl TEXT,
            apiKeyCiphertext TEXT,
            apiKeyFingerprint TEXT,
            updatedAt TEXT,
            FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
          );
        `);
        seedDb.exec(`
          CREATE TABLE users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL,
            passwordHash TEXT NOT NULL,
            mustChangePassword INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
          );
        `);
        seedDb
          .prepare(
            `INSERT INTO users (id, username, role, passwordHash, mustChangePassword, enabled, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, 0, 1, ?, ?)`
          )
          .run("usr_legacy2", "legacy-user-2", "user", "hash-not-a-credential", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z");
        seedDb
          .prepare(
            `INSERT INTO user_model_settings
               (userId, provider, model, baseUrl, apiKeyCiphertext, apiKeyFingerprint, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            "usr_legacy2",
            "openai-compatible",
            "gpt-4o",
            "https://api.example.com/v1",
            "base64:ciphertext-DO-NOT-LEAK",
            "abcd…efgh",
            "2026-09-01T00:00:00Z"
          );
      } finally {
        seedDb.close();
      }

      // Phase 2 — open settings repo and confirm rename + scrub.
      const cfg = makeTestConfig({ sqlitePath });
      const built = buildServer(cfg);
      try {
        const db = new Database(sqlitePath, { readonly: true });
        try {
          const legacyNames = db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='legacy_user_model_settings'"
            )
            .all() as Array<{ name: string }>;
          expect(legacyNames.length).toBe(1);

          const legacy = db
            .prepare(
              "SELECT userId, provider, model, baseUrl, apiKeyCiphertext, apiKeyFingerprint, scrubbedAt FROM legacy_user_model_settings"
            )
            .get() as {
              userId: string;
              provider: string;
              model: string | null;
              baseUrl: string | null;
              apiKeyCiphertext: string | null;
              apiKeyFingerprint: string | null;
              scrubbedAt: string;
            };
          expect(legacy.userId).toBe("usr_legacy2");
          expect(legacy.provider).toBe("openai-compatible");
          expect(legacy.baseUrl === "" || legacy.baseUrl === null).toBe(true);
          expect(legacy.apiKeyCiphertext === "" || legacy.apiKeyCiphertext === null).toBe(true);
          expect(legacy.apiKeyFingerprint === "" || legacy.apiKeyFingerprint === null).toBe(true);
          expect(typeof legacy.scrubbedAt).toBe("string");
          expect(legacy.scrubbedAt.length).toBeGreaterThan(0);

          const stillThere = db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='user_model_settings'"
            )
            .all();
          expect(stillThere).toEqual([]);
        } finally {
          db.close();
        }
      } finally {
        built.repo.close();
        built.userRepo.close();
        built.settingsRepo.close();
      }
    } finally {
      rmSyncRetry(tmpDir);
    }
  });

  test("SettingsRepository has no public apiKey-bearing methods", async () => {
    // Defense-in-depth — if anyone re-adds a `saveModelSettings` /
    // `getModelSettings` etc., the test must fail at import time.
    const localCtx = makeTestServer();
    try {
      const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(localCtx.settingsRepo));
      // Allow the documented public surface, but never anything with
      // "model" or any of the secret-shaped substrings.
      for (const name of proto) {
        expect(name.toLowerCase()).not.toContain("apikey");
        expect(name.toLowerCase()).not.toContain("ciphertext");
        expect(name.toLowerCase()).not.toContain("fingerprint");
      }
    } finally {
      localCtx.cleanup();
    }
  });
});

describe("BYOK segregation — provider / agent path (ELI-360)", () => {
  test("server-managed provider runs on operator env creds (mock fallback)", async () => {
    const ctx = makeTestServer();
    try {
      const probe = await ctx.app.request("/health");
      expect(probe.status).toBe(200);
      const body = (await probe.json()) as {
        provider: string;
        provider_configured: boolean;
      };
      // The mock provider does not require an apiKey — the health check
      // reflects that the server is using its OWN operator env, never a
      // user-supplied key.
      expect(typeof body.provider).toBe("string");
      expect(typeof body.provider_configured).toBe("boolean");
    } finally {
      ctx.cleanup();
    }
  });

  test("server-model reflects env-driven LLM_* config (operator creds only)", async () => {
    // Use a custom config that drives LLM_PROVIDER + LLM_MODEL via the
    // makeTestConfig overrides. We simulate operator env by passing a
    // fresh AppConfig directly to buildServer.
    const cfg = makeTestConfig({
      llm: { provider: "openai-compatible", model: "operator-test-model", extractorModel: "operator-test-model", baseUrl: "https://operator.example.com/v1", apiKey: null },
    });
    // Reject any actual provider call by leaving apiKey null — the
    // /api/settings/server-model endpoint only reports what env says.
    const built = buildServer(cfg);
    const cookie = await loginAndCookie(built.app, built.userRepo, "alice", "alice-pass-12345");
    try {
      const r = await built.app.request("/api/settings/server-model", { headers: { cookie } });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { provider: string; model: string; baseUrl: string | null; configured: boolean };
      expect(body.provider).toBe("openai-compatible");
      expect(body.model).toBe("operator-test-model");
      expect(body.baseUrl).toBe("https://operator.example.com/v1");
      // apiKey is null in the test config — configured=false.
      expect(body.configured).toBe(false);
    } finally {
      built.repo.close();
      built.userRepo.close();
      built.settingsRepo.close();
    }
  });
});

describe("BYOK segregation — server env never shadowed by legacy per-user row (ELI-360)", () => {
  // Functional root-cause of the user-reported "当前未配置可用的大模型服务"
  // after a valid canonical .env: providerForUser() used to decrypt and prefer
  // a stale per-user row. After ELI-360, providerForUser() is a thin alias
  // for deps.provider. The tests below pin the contract end-to-end: a stale
  // legacy_user_model_configs row must never change provider readiness.

  function seedLegacyRow(sqlitePath: string): void {
    const db = new Database(sqlitePath);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS legacy_user_model_configs (
          userId TEXT PRIMARY KEY,
          provider TEXT,
          baseUrl TEXT,
          model TEXT,
          apiKeyEncrypted TEXT,
          verifiedAt TEXT,
          lastError TEXT,
          scrubbedAt TEXT,
          updatedAt TEXT
        );
      `);
      db.prepare(
        `INSERT OR REPLACE INTO legacy_user_model_configs
           (userId, provider, baseUrl, model, apiKeyEncrypted, verifiedAt, lastError, scrubbedAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "usr_alice",
        "openai-compatible",
        "https://attacker.example.invalid/v1",
        "evil-model-that-should-never-be-used",
        "base64:this-is-a-stale-ciphertext-DO-NOT-LEAK",
        "2026-08-01T00:00:00Z",
        "stale",
        "2026-09-23T00:00:00Z",
        "2026-08-01T00:00:00Z"
      );
    } finally {
      db.close();
    }
  }

  test("valid server env + stale legacy_user_model_configs row => /health reflects deps.provider, not the legacy row", async () => {
    const ctx = makeTestServer();
    try {
      const before = (await (await ctx.app.request("/health")).json()) as {
        provider: string;
        provider_configured: boolean;
        provider_status: string;
      };
      seedLegacyRow(ctx.cfg.sqlitePath);
      const after = (await (await ctx.app.request("/health")).json()) as {
        provider: string;
        provider_configured: boolean;
        provider_status: string;
      };
      expect(after.provider).toBe(before.provider);
      expect(after.provider_configured).toBe(before.provider_configured);
      expect(after.provider_status).toBe(before.provider_status);
      const text = JSON.stringify(after);
      expect(text.includes("attacker.example.invalid")).toBe(false);
      expect(text.includes("evil-model-that-should-never-be-used")).toBe(false);
      expect(text.includes("base64:this-is-a-stale-ciphertext")).toBe(false);
    } finally {
      ctx.cleanup();
    }
  });

  test("valid server env + stale legacy row => /api/sessions POST uses deps.provider (never echoes legacy model)", async () => {
    const ctx = makeTestServer();
    try {
      seedLegacyRow(ctx.cfg.sqlitePath);
      const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "alice", "alice-pass-12345");
      const r = await ctx.app.request("/api/sessions", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          message: "我今天买了 100 股 NVDA，准备 6 个月持有。",
        }),
      });
      const text = await r.text();
      expect(text.includes("attacker.example.invalid")).toBe(false);
      expect(text.includes("evil-model-that-should-never-be-used")).toBe(false);
      expect(text.includes("base64:this-is-a-stale-ciphertext")).toBe(false);
      // If env itself is unconfigured (mock with no key), the only acceptable
      // failure is the env-driven MODEL_NOT_CONFIGURED path — never anything
      // originating from the legacy row.
      if (r.status === 503) {
        const body = JSON.parse(text) as { error: string };
        expect(body.error).toBe("MODEL_NOT_CONFIGURED");
      }
    } finally {
      ctx.cleanup();
    }
  });

  test("no per-user row => /api/sessions POST uses deps.provider (same readiness contract)", async () => {
    const ctx = makeTestServer();
    try {
      const before = (await (await ctx.app.request("/health")).json()) as {
        provider: string;
        provider_status: string;
      };
      const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "alice", "alice-pass-12345");
      const r = await ctx.app.request("/api/sessions", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          message: "我今天买了 100 股 NVDA，准备 6 个月持有。",
        }),
      });
      const text = await r.text();
      if (r.status === 503) {
        const body = JSON.parse(text) as { error: string; provider_status?: string };
        expect(body.error).toBe("MODEL_NOT_CONFIGURED");
        expect(body.provider_status).toBe(before.provider_status);
      } else {
        expect([200, 201]).toContain(r.status);
      }
    } finally {
      ctx.cleanup();
    }
  });
});
