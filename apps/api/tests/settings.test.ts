/**
 * Settings / usage / model-capability contract tests — ELI-341.
 *
 * Covers the acceptance bar from issue ELI-341:
 *   - Settings (GET/PUT /api/settings/model) with encrypted-at-rest secret
 *     storage. Plaintext apiKey must NEVER appear in responses, logs, or
 *     the SQLite row.
 *   - Usage quota summary (GET /api/usage) — configured allowance,
 *     consumed tokens, remaining/unknown semantics, period metadata.
 *     The endpoint MUST NOT fabricate a provider quota we cannot verify.
 *   - Provider/model capability metadata (GET /api/models/capabilities)
 *     — vision support is only flagged `verified` when we have actually
 *     checked the provider's published capability matrix.
 *   - Authorization: mustChangePassword users and unauthenticated
 *     requests are rejected. Normal users CAN reach their own settings;
 *     admin endpoints remain admin-only.
 *   - Secret redaction: apiKeyCiphertext never appears in any response;
 *     plaintext is not echoed back; the SQLite row contains only
 *     ciphertext + fingerprint, never the secret itself.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  makeTestServer,
  loginAndCookie,
  TEST_PASSWORD,
  type TestServer,
} from "./helpers.ts";
import { hashPassword } from "../src/auth/passwords.ts";
import {
  loadSecretKey,
  plaintextFingerprint,
  _resetSecretKeyForTest,
} from "../src/settings/crypto.ts";

function deterministicKeyEnv() {
  // 32 zero bytes — deterministic, easy to assert against.
  // The base64 of [0x00 * 32] is "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".
  const b64 = Buffer.alloc(32, 0).toString("base64");
  process.env.AIME_SECRET_ENC_KEY = b64;
}

async function seedNormal(
  repo: TestServer["userRepo"],
  username: string,
  password: string,
  opts: { mustChange?: boolean } = {}
) {
  const hash = await hashPassword(password);
  return repo.createUser({
    username,
    passwordHash: hash,
    role: "user",
    mustChangePassword: opts.mustChange ?? false,
  });
}

async function seedAdmin(
  repo: TestServer["userRepo"],
  username = "admin",
  password = TEST_PASSWORD,
  mustChange = false
) {
  const hash = await hashPassword(password);
  return repo.createUser({
    username,
    passwordHash: hash,
    role: "admin",
    mustChangePassword: mustChange,
  });
}

describe("Settings — auth + authorization (ELI-341)", () => {
  let ctx: TestServer;
  let userCookie: string;
  let adminCookie: string;

  beforeEach(async () => {
    deterministicKeyEnv();
    _resetSecretKeyForTest();
    ctx = makeTestServer();
    await seedAdmin(ctx.userRepo);
    await seedNormal(ctx.userRepo, "alice", "alice-pass-12345");
    userCookie = await loginAndCookie(ctx.app, ctx.userRepo, "alice", "alice-pass-12345");
    adminCookie = await loginAndCookie(ctx.app, ctx.userRepo, "admin", TEST_PASSWORD);
  });
  afterEach(() => {
    delete process.env.AIME_SECRET_ENC_KEY;
    _resetSecretKeyForTest();
    ctx.cleanup();
  });

  test("unauthenticated request is rejected with 401", async () => {
    const r = await ctx.app.request("/api/settings/model");
    expect(r.status).toBe(401);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("unauthenticated");
  });

  test("mustChangePassword user is blocked from /api/settings/* (403 must_change_password)", async () => {
    // Seed a fresh user that is still in the must-change state.
    const hash = await hashPassword("must-pass-9876");
    ctx.userRepo.createUser({
      username: "mustchange",
      passwordHash: hash,
      role: "user",
      mustChangePassword: true,
    });
    const cookie = await loginAndCookie(
      ctx.app,
      ctx.userRepo,
      "mustchange",
      "must-pass-9876",
      { mustChangePassword: true }
    );
    const r = await ctx.app.request("/api/settings/model", { headers: { cookie } });
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("must_change_password");

    const r2 = await ctx.app.request("/api/usage", { headers: { cookie } });
    expect(r2.status).toBe(403);
    const r3 = await ctx.app.request("/api/models/capabilities", { headers: { cookie } });
    expect(r3.status).toBe(403);
  });

  test("normal user CAN reach their own /api/settings/model (per-user scope)", async () => {
    // ELI-341 explicitly carves out a per-user settings contract. The
    // forbidden-on-admin rule from ELI-325 only covers /api/admin/*.
    const r = await ctx.app.request("/api/settings/model", { headers: { cookie: userCookie } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { provider: string; hasApiKey: boolean };
    expect(body.provider).toBe("mock");
    expect(body.hasApiKey).toBe(false);
  });

  test("normal user CANNOT invoke admin mutations (ELI-341 authorization bar)", async () => {
    // Re-pin the ELI-325 admin guard at the settings/usage/capabilities
    // boundary as well. A normal user must never reach an admin mutation
    // through the new surface.
    const forbidden = [
      { method: "GET" as const, path: "/api/admin/users" },
      { method: "POST" as const, path: "/api/admin/users", body: { username: "evil" } },
      { method: "POST" as const, path: "/api/admin/users/usr_anything/reset-password" },
      { method: "POST" as const, path: "/api/admin/users/usr_anything/disable" },
    ];
    for (const req of forbidden) {
      const init: RequestInit = {
        method: req.method,
        headers: { cookie: userCookie, "content-type": "application/json" },
      };
      if (req.body) init.body = JSON.stringify(req.body);
      const r = await ctx.app.request(req.path, init);
      expect([401, 403]).toContain(r.status);
    }
  });

  test("admin session is required for /api/admin/* mutations", async () => {
    // Sanity: the admin CAN list users, the user CANNOT.
    const adminList = await ctx.app.request("/api/admin/users", {
      headers: { cookie: adminCookie },
    });
    expect(adminList.status).toBe(200);
    const userList = await ctx.app.request("/api/admin/users", {
      headers: { cookie: userCookie },
    });
    expect(userList.status).toBe(403);
  });
});

describe("Settings — secret redaction (ELI-341)", () => {
  let ctx: TestServer;
  let userCookie: string;
  const SECRET_PLAINTEXT = "sk-test-supplied-by-user-DO-NOT-LEAK-9876543210";

  beforeEach(async () => {
    deterministicKeyEnv();
    _resetSecretKeyForTest();
    ctx = makeTestServer();
    await seedNormal(ctx.userRepo, "alice", "alice-pass-12345");
    userCookie = await loginAndCookie(ctx.app, ctx.userRepo, "alice", "alice-pass-12345");
  });
  afterEach(() => {
    delete process.env.AIME_SECRET_ENC_KEY;
    _resetSecretKeyForTest();
    ctx.cleanup();
  });

  test("PUT /api/settings/model stores ciphertext only — never plaintext", async () => {
    const res = await ctx.app.request("/api/settings/model", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({
        provider: "openai-compatible",
        model: "gpt-4o",
        baseUrl: "https://api.example.com/v1",
        apiKey: SECRET_PLAINTEXT,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hasApiKey: boolean;
      apiKeyFingerprint: string | null;
      apiKey?: string;
      apiKeyCiphertext?: string;
    };
    expect(body.hasApiKey).toBe(true);
    expect(typeof body.apiKeyFingerprint).toBe("string");
    // The public payload must NOT include either the plaintext or the ciphertext.
    expect("apiKey" in body).toBe(false);
    expect("apiKeyCiphertext" in body).toBe(false);
    const text = JSON.stringify(body);
    expect(text.includes(SECRET_PLAINTEXT)).toBe(false);
  });

  test("GET /api/settings/model never echoes the stored ciphertext or plaintext", async () => {
    await ctx.app.request("/api/settings/model", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({
        provider: "openai-compatible",
        model: "gpt-4o",
        apiKey: SECRET_PLAINTEXT,
      }),
    });
    const r = await ctx.app.request("/api/settings/model", { headers: { cookie: userCookie } });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text.includes(SECRET_PLAINTEXT)).toBe(false);
    // The ciphertext is a base64 string that does not contain "sk-" so
    // we also confirm it is not present by checking the plaintext-shaped
    // prefix does not appear.
    expect(text.includes("sk-")).toBe(false);

    const body = JSON.parse(text) as Record<string, unknown>;
    expect("apiKeyCiphertext" in body).toBe(false);
    expect("apiKey" in body).toBe(false);
  });

  test("persisted SQLite row contains ciphertext, not the plaintext", async () => {
    await ctx.app.request("/api/settings/model", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({
        provider: "openai-compatible",
        model: "gpt-4o",
        apiKey: SECRET_PLAINTEXT,
      }),
    });
    // Use the settings repository directly to inspect the persisted row.
    const user = ctx.userRepo.findByUsername("alice")!;
    const row = ctx.settingsRepo.getModelSettings(user.id);
    expect(row).not.toBeNull();
    expect(row!.apiKeyCiphertext).not.toBeNull();
    expect(row!.apiKeyCiphertext).not.toContain(SECRET_PLAINTEXT);
    // Ciphertext is base64 and does NOT contain the plaintext substring.
    expect(row!.apiKeyCiphertext!.includes(SECRET_PLAINTEXT)).toBe(false);
  });

  test("503 when secret-encryption handle is unavailable and an apiKey is supplied", async () => {
    // Wipe the env-derivable secret key so the API has nowhere to
    // store a plaintext. The PUT must be rejected rather than silently
    // downgrading to plaintext persistence.
    delete process.env.AIME_SECRET_ENC_KEY;
    delete process.env.INITIAL_ADMIN_PASSWORD;
    _resetSecretKeyForTest();

    const res = await ctx.app.request("/api/settings/model", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({
        provider: "openai-compatible",
        model: "gpt-4o",
        apiKey: SECRET_PLAINTEXT,
      }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("secret_store_unavailable");
    expect(JSON.stringify(body).includes(SECRET_PLAINTEXT)).toBe(false);

    // The plaintext was NOT persisted — the settings row remains absent
    // (or, if a previous row existed, its ciphertext is unchanged).
    const user = ctx.userRepo.findByUsername("alice")!;
    const row = ctx.settingsRepo.getModelSettings(user.id);
    if (row) {
      expect(row.apiKeyCiphertext === null || !row.apiKeyCiphertext.includes(SECRET_PLAINTEXT)).toBe(
        true
      );
    }

    // Re-establish the key so afterEach can run cleanly.
    deterministicKeyEnv();
  });

  test("omitting apiKey on PUT preserves the existing ciphertext", async () => {
    // First PUT: set the key.
    await ctx.app.request("/api/settings/model", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({
        provider: "openai-compatible",
        model: "gpt-4o",
        apiKey: SECRET_PLAINTEXT,
      }),
    });
    const user = ctx.userRepo.findByUsername("alice")!;
    const before = ctx.settingsRepo.getModelSettings(user.id)!;

    // Second PUT: rotate the model without re-supplying the key.
    const r = await ctx.app.request("/api/settings/model", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({
        provider: "openai-compatible",
        model: "gpt-4o-mini",
      }),
    });
    expect(r.status).toBe(200);
    const after = ctx.settingsRepo.getModelSettings(user.id)!;
    expect(after.model).toBe("gpt-4o-mini");
    expect(after.apiKeyCiphertext).toBe(before.apiKeyCiphertext);
    expect(after.apiKeyFingerprint).toBe(before.apiKeyFingerprint);

    const r2 = await ctx.app.request("/api/settings/model", { headers: { cookie: userCookie } });
    const body = (await r2.json()) as { hasApiKey: boolean };
    expect(body.hasApiKey).toBe(true);
  });

  test("empty-string apiKey on PUT clears the stored ciphertext", async () => {
    await ctx.app.request("/api/settings/model", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({
        provider: "openai-compatible",
        model: "gpt-4o",
        apiKey: SECRET_PLAINTEXT,
      }),
    });
    const user = ctx.userRepo.findByUsername("alice")!;
    const r = await ctx.app.request("/api/settings/model", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({
        provider: "openai-compatible",
        model: "gpt-4o",
        apiKey: "",
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { hasApiKey: boolean; apiKeyFingerprint: string | null };
    expect(body.hasApiKey).toBe(false);
    expect(body.apiKeyFingerprint).toBeNull();
    const persisted = ctx.settingsRepo.getModelSettings(user.id)!;
    expect(persisted.apiKeyCiphertext).toBeNull();
    expect(persisted.apiKeyFingerprint).toBeNull();
  });

  test("mock provider rejects baseUrl / apiKey (provider is intentionally non-configurable)", async () => {
    const r1 = await ctx.app.request("/api/settings/model", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({
        provider: "mock",
        model: "mvp-mock-model",
        apiKey: "should-be-rejected",
      }),
    });
    expect(r1.status).toBe(400);
    const body = (await r1.json()) as { error: string };
    expect(body.error).toBe("mock_not_configurable");

    const r2 = await ctx.app.request("/api/settings/model", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({
        provider: "mock",
        model: "mvp-mock-model",
        baseUrl: "https://example.invalid",
      }),
    });
    expect(r2.status).toBe(400);
  });

  test("invalid baseUrl is rejected with invalid_input", async () => {
    const r = await ctx.app.request("/api/settings/model", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({
        provider: "openai-compatible",
        model: "gpt-4o",
        baseUrl: "not-a-url",
      }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("invalid_input");
  });

  test("GET returns a documented default when no row exists", async () => {
    const r = await ctx.app.request("/api/settings/model", { headers: { cookie: userCookie } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      provider: string;
      model: string;
      hasApiKey: boolean;
      apiKeyFingerprint: string | null;
      baseUrl: string | null;
    };
    expect(body.provider).toBe("mock");
    expect(body.model).toBe("mvp-mock-model");
    expect(body.hasApiKey).toBe(false);
    expect(body.apiKeyFingerprint).toBeNull();
    expect(body.baseUrl).toBeNull();
  });
});

describe("Settings — crypto round-trip", () => {
  test("encrypt → decrypt round-trips for non-empty ASCII plaintexts", () => {
    _resetSecretKeyForTest();
    process.env.AIME_SECRET_ENC_KEY = Buffer.alloc(32, 1).toString("base64");
    const key = loadSecretKey()!;
    const plaintext = "sk-roundtrip-1234567890";
    const cipher = key.encrypt(plaintext);
    expect(cipher).not.toContain(plaintext);
    const recovered = key.decrypt(cipher);
    expect(recovered).toBe(plaintext);
    delete process.env.AIME_SECRET_ENC_KEY;
    _resetSecretKeyForTest();
  });

  test("encryption uses a fresh IV per call (ciphertexts differ for identical plaintexts)", () => {
    _resetSecretKeyForTest();
    process.env.AIME_SECRET_ENC_KEY = Buffer.alloc(32, 2).toString("base64");
    const key = loadSecretKey()!;
    const a = key.encrypt("identical");
    const b = key.encrypt("identical");
    expect(a).not.toBe(b);
    expect(key.decrypt(a)).toBe("identical");
    expect(key.decrypt(b)).toBe("identical");
    delete process.env.AIME_SECRET_ENC_KEY;
    _resetSecretKeyForTest();
  });

  test("decryption fails closed on a tampered ciphertext", () => {
    _resetSecretKeyForTest();
    process.env.AIME_SECRET_ENC_KEY = Buffer.alloc(32, 3).toString("base64");
    const key = loadSecretKey()!;
    const cipher = key.encrypt("hello-world");
    // Flip one base64 character to invalidate the auth tag.
    const tampered = `${cipher.slice(0, -2)}AA`;
    expect(key.decrypt(tampered)).toBeNull();
    delete process.env.AIME_SECRET_ENC_KEY;
    _resetSecretKeyForTest();
  });

  test("fingerprint is short, non-reversible, and stable per ciphertext", () => {
    _resetSecretKeyForTest();
    process.env.AIME_SECRET_ENC_KEY = Buffer.alloc(32, 4).toString("base64");
    const key = loadSecretKey()!;
    const cipher = key.encrypt("sk-stable-9876543210");
    const fp1 = key.fingerprint(cipher);
    const fp2 = key.fingerprint(cipher);
    expect(fp1).toBe(fp2);
    expect(fp1.length).toBeLessThan(20);
    expect(fp1).toContain("…");
    // The plaintext fingerprint is also deterministic, but it is computed
    // by the same helper the routes use — pinning it here so we cannot
    // accidentally widen the format.
    expect(plaintextFingerprint("hello")).toMatch(/^[0-9a-f]{4}…[0-9a-f]{4}$/);
    delete process.env.AIME_SECRET_ENC_KEY;
    _resetSecretKeyForTest();
  });

  test("loadSecretKey returns null when no key source is configured", () => {
    _resetSecretKeyForTest();
    delete process.env.AIME_SECRET_ENC_KEY;
    delete process.env.INITIAL_ADMIN_PASSWORD;
    const handle = loadSecretKey({});
    expect(handle).toBeNull();
  });
});

describe("Usage quota (ELI-341)", () => {
  let ctx: TestServer;
  let userCookie: string;

  beforeEach(async () => {
    deterministicKeyEnv();
    _resetSecretKeyForTest();
    ctx = makeTestServer();
    await seedNormal(ctx.userRepo, "alice", "alice-pass-12345");
    userCookie = await loginAndCookie(ctx.app, ctx.userRepo, "alice", "alice-pass-12345");
  });
  afterEach(() => {
    delete process.env.AIME_SECRET_ENC_KEY;
    _resetSecretKeyForTest();
    ctx.cleanup();
  });

  test("default rolling period + unknown allowance semantics when no config exists", async () => {
    const r = await ctx.app.request("/api/usage", { headers: { cookie: userCookie } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      period: { start: string; end: string; resetAt: string };
      allowance: { tokens: number | null; source: "configured" | "unknown" };
      consumed: { tokens: number; lastUpdatedAt: string | null };
      remaining: { tokens: number | null; known: boolean };
      recent: unknown[];
    };
    expect(new Date(body.period.end).getTime()).toBeGreaterThan(new Date(body.period.start).getTime());
    expect(body.period.resetAt).toBe(body.period.end);
    // Unknown allowance is the explicit contract — never fabricate a quota.
    expect(body.allowance.tokens).toBeNull();
    expect(body.allowance.source).toBe("unknown");
    expect(body.remaining.tokens).toBeNull();
    expect(body.remaining.known).toBe(false);
    expect(body.consumed.tokens).toBe(0);
    expect(body.consumed.lastUpdatedAt).toBeNull();
    expect(Array.isArray(body.recent)).toBe(true);
  });

  test("PUT /api/settings/model with period persists allowanceTokens and the period is reflected", async () => {
    const start = "2026-09-01T00:00:00.000Z";
    const end = "2026-10-01T00:00:00.000Z";
    const resetAt = end;
    const put = await ctx.app.request("/api/settings/model", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({
        provider: "openai-compatible",
        model: "gpt-4o",
        period: {
          start,
          end,
          resetAt,
          allowanceTokens: 1_000_000,
        },
      }),
    });
    expect(put.status).toBe(200);

    const r = await ctx.app.request("/api/usage", { headers: { cookie: userCookie } });
    const body = (await r.json()) as {
      period: { start: string; end: string; resetAt: string };
      allowance: { tokens: number | null; source: string };
      remaining: { tokens: number | null; known: boolean };
    };
    expect(body.period.start).toBe(start);
    expect(body.period.end).toBe(end);
    expect(body.period.resetAt).toBe(resetAt);
    expect(body.allowance.tokens).toBe(1_000_000);
    expect(body.allowance.source).toBe("configured");
    expect(body.remaining.tokens).toBe(1_000_000);
    expect(body.remaining.known).toBe(true);
  });

  test("null allowanceTokens is preserved as 'unknown' (never fabricated)", async () => {
    const start = "2026-09-01T00:00:00.000Z";
    const end = "2026-10-01T00:00:00.000Z";
    await ctx.app.request("/api/settings/model", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({
        provider: "openai-compatible",
        model: "gpt-4o",
        period: {
          start,
          end,
          resetAt: end,
          allowanceTokens: null,
        },
      }),
    });
    const r = await ctx.app.request("/api/usage", { headers: { cookie: userCookie } });
    const body = (await r.json()) as {
      allowance: { tokens: number | null; source: string };
      remaining: { tokens: number | null; known: boolean };
    };
    expect(body.allowance.tokens).toBeNull();
    expect(body.allowance.source).toBe("unknown");
    expect(body.remaining.tokens).toBeNull();
    expect(body.remaining.known).toBe(false);
  });

  test("recorded usage is summed into consumed and surfaced in recent[]", async () => {
    const user = ctx.userRepo.findByUsername("alice")!;
    ctx.settingsRepo.recordUsage({
      userId: user.id,
      reviewId: "rev_demo",
      kind: "llm.completion",
      promptTokens: 1234,
      completionTokens: 56,
      at: "2026-09-10T12:00:00.000Z",
    });
    ctx.settingsRepo.recordUsage({
      userId: user.id,
      reviewId: "rev_demo_2",
      kind: "llm.completion",
      promptTokens: 7,
      completionTokens: 11,
      at: "2026-09-11T12:00:00.000Z",
    });

    const r = await ctx.app.request("/api/usage", { headers: { cookie: userCookie } });
    const body = (await r.json()) as {
      consumed: { tokens: number; lastUpdatedAt: string | null };
      recent: Array<{
        reviewId: string | null;
        kind: string;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      }>;
    };
    expect(body.consumed.tokens).toBe(1234 + 56 + 7 + 11);
    expect(body.consumed.lastUpdatedAt).toBe("2026-09-11T12:00:00.000Z");
    expect(body.recent.length).toBe(2);
    for (const e of body.recent) {
      expect(e.totalTokens).toBe(e.promptTokens + e.completionTokens);
    }
  });

  test("consumed is bounded by the configured period start (no future-fabrication)", async () => {
    const user = ctx.userRepo.findByUsername("alice")!;
    // Event AFTER the period end — should not be counted in the current
    // window if we put the period around it.
    ctx.settingsRepo.recordUsage({
      userId: user.id,
      kind: "llm.completion",
      promptTokens: 500,
      completionTokens: 0,
      at: "2026-09-15T00:00:00.000Z",
    });
    const start = "2026-09-01T00:00:00.000Z";
    const end = "2026-09-10T00:00:00.000Z";
    await ctx.app.request("/api/settings/model", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({
        provider: "openai-compatible",
        model: "gpt-4o",
        period: { start, end, resetAt: end, allowanceTokens: 1_000_000 },
      }),
    });
    const r = await ctx.app.request("/api/usage", { headers: { cookie: userCookie } });
    const body = (await r.json()) as { consumed: { tokens: number }; remaining: { tokens: number } };
    // Event is after `end`, so the window has 0 consumed and remaining
    // equals the full allowance. (Recorded events are an audit trail,
    // not a sliding-window ledger.)
    expect(body.consumed.tokens).toBe(0);
    expect(body.remaining.tokens).toBe(1_000_000);
  });

  test("GET /api/usage is unauthenticated-blocked", async () => {
    const r = await ctx.app.request("/api/usage");
    expect(r.status).toBe(401);
  });
});

describe("Model capabilities (ELI-341)", () => {
  let ctx: TestServer;
  let userCookie: string;

  beforeEach(async () => {
    deterministicKeyEnv();
    _resetSecretKeyForTest();
    ctx = makeTestServer();
    await seedNormal(ctx.userRepo, "alice", "alice-pass-12345");
    userCookie = await loginAndCookie(ctx.app, ctx.userRepo, "alice", "alice-pass-12345");
  });
  afterEach(() => {
    delete process.env.AIME_SECRET_ENC_KEY;
    _resetSecretKeyForTest();
    ctx.cleanup();
  });

  test("GET /api/models/capabilities returns providers + vision metadata", async () => {
    const r = await ctx.app.request("/api/models/capabilities", { headers: { cookie: userCookie } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      providers: Array<{
        id: string;
        displayName: string;
        configurable: boolean;
        models: Array<{
          id: string;
          vision: boolean;
          visionSource: "verified" | "static" | "unknown";
        }>;
      }>;
      notes: string;
    };
    expect(body.providers.length).toBeGreaterThan(0);
    const openai = body.providers.find((p) => p.id === "openai-compatible")!;
    expect(openai.configurable).toBe(true);
    const gpt4o = openai.models.find((m) => m.id === "gpt-4o")!;
    expect(gpt4o.vision).toBe(true);
    expect(gpt4o.visionSource).toBe("verified");

    const gpt35 = openai.models.find((m) => m.id === "gpt-3.5-turbo")!;
    expect(gpt35.vision).toBe(false);
    expect(gpt35.visionSource).toBe("verified");

    const mock = body.providers.find((p) => p.id === "mock")!;
    expect(mock.configurable).toBe(false);
    for (const m of mock.models) {
      expect(m.visionSource).not.toBe("verified");
    }
    expect(typeof body.notes).toBe("string");
    expect(body.notes.length).toBeGreaterThan(0);
  });

  test("capabilities endpoint requires authentication", async () => {
    const r = await ctx.app.request("/api/models/capabilities");
    expect(r.status).toBe(401);
  });

  test("every entry declares a visionSource field (no undefined metadata)", async () => {
    const r = await ctx.app.request("/api/models/capabilities", { headers: { cookie: userCookie } });
    const body = (await r.json()) as {
      providers: Array<{ models: Array<{ visionSource: string }> }>;
    };
    for (const p of body.providers) {
      for (const m of p.models) {
        expect(["verified", "static", "unknown"]).toContain(m.visionSource);
      }
    }
  });
});

describe("Settings — session / cookie hygiene (ELI-341)", () => {
  let ctx: TestServer;
  let userCookie: string;

  beforeEach(async () => {
    deterministicKeyEnv();
    _resetSecretKeyForTest();
    ctx = makeTestServer();
    await seedNormal(ctx.userRepo, "alice", "alice-pass-12345");
    userCookie = await loginAndCookie(ctx.app, ctx.userRepo, "alice", "alice-pass-12345");
  });
  afterEach(() => {
    delete process.env.AIME_SECRET_ENC_KEY;
    _resetSecretKeyForTest();
    ctx.cleanup();
  });

  test("x-user-id header is rejected on settings / usage / capabilities", async () => {
    // The identity-contract guard already covers /api/*; pin it here for
    // the new surface so a future refactor cannot quietly drop it.
    const targets = [
      { method: "GET" as const, path: "/api/settings/model" },
      { method: "PUT" as const, path: "/api/settings/model", body: { provider: "mock", model: "x" } },
      { method: "GET" as const, path: "/api/usage" },
      { method: "GET" as const, path: "/api/models/capabilities" },
    ];
    for (const t of targets) {
      const init: RequestInit = {
        method: t.method,
        headers: {
          cookie: userCookie,
          "content-type": "application/json",
          "x-user-id": "usr_evil-forged-id",
        },
      };
      if (t.body) init.body = JSON.stringify(t.body);
      const r = await ctx.app.request(t.path, init);
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      // All routes in this surface live under /api/*, so the guard must
      // reject before any business logic runs.
      expect([400, 401]).toContain(r.status);
      expect(body.error).toBe("x_user_id_header_not_allowed");
    }
  });

  test("disabled accounts are auto-logged-out on the settings surface", async () => {
    // Confirm the disabled-account revocation propagates to /api/settings/*
    // the same way it does to /api/reviews/* (ELI-325 contract).
    const r1 = await ctx.app.request("/api/settings/model", { headers: { cookie: userCookie } });
    expect(r1.status).toBe(200);
    const user = ctx.userRepo.findByUsername("alice")!;
    ctx.userRepo.setEnabled(user.id, false);
    const r2 = await ctx.app.request("/api/settings/model", { headers: { cookie: userCookie } });
    expect(r2.status).toBe(401);
    const r3 = await ctx.app.request("/api/usage", { headers: { cookie: userCookie } });
    expect(r3.status).toBe(401);
  });
});
