/**
 * Settings / usage / model-capability contract tests — ELI-341 + ELI-360.
 *
 * ELI-360 contract pivot (preserved in the regression bar below):
 *   - The AIME backend no longer accepts, persists, echoes, or fingerprints
 *     a user-supplied BYOK apiKey. The old PUT /api/settings/model route
 *     is gone; the route now answers 410 Gone so a stale frontend bundle
 *     fails closed instead of silently downgrading.
 *   - User BYOK is browser-local. The server only ever returns the
 *     read-only server-managed LLM provider config (LLM_* env) via
 *     /api/settings/server-model.
 *   - Legacy per-user ciphertext columns from prior builds must be
 *     zeroed on bootstrap so no historical apiKey material survives
 *     the trust-boundary change.
 *
 * This file still covers the ELI-341 usage / capability bars — those
 * endpoints are unchanged.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  makeTestServer,
  loginAndCookie,
  TEST_PASSWORD,
  type TestServer,
} from "./helpers.ts";
import { hashPassword } from "../src/auth/passwords.ts";

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

describe("Settings — auth + authorization (ELI-341 / ELI-360)", () => {
  let ctx: TestServer;
  let userCookie: string;
  let adminCookie: string;

  beforeEach(async () => {
    ctx = makeTestServer();
    await seedAdmin(ctx.userRepo);
    await seedNormal(ctx.userRepo, "alice", "alice-pass-12345");
    userCookie = await loginAndCookie(ctx.app, ctx.userRepo, "alice", "alice-pass-12345");
    adminCookie = await loginAndCookie(ctx.app, ctx.userRepo, "admin", TEST_PASSWORD);
  });
  afterEach(() => {
    ctx.cleanup();
  });

  test("unauthenticated request to /api/settings/server-model is 401", async () => {
    const r = await ctx.app.request("/api/settings/server-model");
    expect(r.status).toBe(401);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("unauthenticated");
  });

  test("mustChangePassword user is blocked from settings / usage / capabilities (403)", async () => {
    const cookie = await loginAndCookie(
      ctx.app,
      ctx.userRepo,
      "mustchange",
      "must-pass-9876",
      { mustChangePassword: true }
    );
    for (const path of [
      "/api/settings/server-model",
      "/api/usage",
      "/api/models/capabilities",
    ]) {
      const r = await ctx.app.request(path, { headers: { cookie } });
      expect(r.status).toBe(403);
      const body = (await r.json()) as { error: string };
      expect(body.error).toBe("must_change_password");
    }
  });

  test("normal user CAN reach /api/settings/server-model — only env-derived config, no fingerprint", async () => {
    const r = await ctx.app.request("/api/settings/server-model", {
      headers: { cookie: userCookie },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      provider: string;
      model: string;
      baseUrl: string | null;
      configured: boolean;
    };
    // Default test config uses the mock provider with no LLM_BASE_URL.
    expect(body.provider).toBe("mock");
    expect(typeof body.model).toBe("string");
    expect(body.configured).toBe(false);
    // ELI-360 — no fingerprint / hasApiKey / apiKeySuffix / keySuffix is
    // ever returned by this surface. The server literally cannot know
    // about the user's browser BYOK.
    const text = JSON.stringify(body);
    for (const forbidden of ["apiKey", "fingerprint", "keySuffix", "hasApiKey"]) {
      expect(text.toLowerCase().includes(forbidden.toLowerCase())).toBe(false);
    }
  });

  test("normal user CANNOT invoke admin mutations (ELI-341 authorization bar)", async () => {
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

describe("Settings — removed BYOK surface answers 410 Gone (ELI-360)", () => {
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

  test("GET /api/settings/model → 410 Gone with explicit ELI-360 explanation", async () => {
    const r = await ctx.app.request("/api/settings/model", { headers: { cookie: userCookie } });
    expect(r.status).toBe(410);
    const body = (await r.json()) as { error: string; message?: string };
    expect(body.error).toBe("endpoint_removed");
    // The error body must NOT contain any apiKey-shaped material, even
    // an explanatory placeholder, that could leak through a future refactor.
    const text = JSON.stringify(body);
    expect(text.includes("sk-")).toBe(false);
  });

  test("PUT /api/settings/model → 410 Gone", async () => {
    const r = await ctx.app.request("/api/settings/model", {
      method: "PUT",
      headers: { cookie: userCookie, "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openai-compatible",
        model: "gpt-4o",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-this-must-not-reach-the-server-9876543210",
      }),
    });
    expect(r.status).toBe(410);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("endpoint_removed");
    const text = JSON.stringify(body);
    expect(text.includes("sk-this-must-not-reach-the-server-9876543210")).toBe(false);
  });

  test("GET /api/auth/model → 410 Gone", async () => {
    const r = await ctx.app.request("/api/auth/model", { headers: { cookie: userCookie } });
    expect(r.status).toBe(410);
  });

  test("POST /api/auth/model → 410 Gone", async () => {
    const r = await ctx.app.request("/api/auth/model", {
      method: "POST",
      headers: { cookie: userCookie, "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai-compatible", model: "x", apiKey: "sk-should-not-leak" }),
    });
    expect(r.status).toBe(410);
  });

  test("DELETE /api/auth/model → 410 Gone", async () => {
    const r = await ctx.app.request("/api/auth/model", {
      method: "DELETE",
      headers: { cookie: userCookie },
    });
    expect(r.status).toBe(410);
  });

  test("POST /api/auth/model/test → 410 Gone", async () => {
    const r = await ctx.app.request("/api/auth/model/test", {
      method: "POST",
      headers: { cookie: userCookie, "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://x", model: "m", apiKey: "sk-should-not-leak" }),
    });
    expect(r.status).toBe(410);
  });

  test("410 Gone bodies never echo the supplied plaintext apiKey", async () => {
    const SECRET = "sk-attacker-supplied-DO-NOT-LEAK-9876543210";
    const cases = [
      { method: "PUT" as const, path: "/api/settings/model", body: { apiKey: SECRET, model: "x" } },
      { method: "POST" as const, path: "/api/auth/model", body: { apiKey: SECRET, model: "x" } },
      { method: "POST" as const, path: "/api/auth/model/test", body: { apiKey: SECRET, model: "x", baseUrl: "https://x" } },
    ];
    for (const c of cases) {
      const r = await ctx.app.request(c.path, {
        method: c.method,
        headers: { cookie: userCookie, "content-type": "application/json" },
        body: JSON.stringify(c.body),
      });
      expect(r.status).toBe(410);
      const text = await r.text();
      expect(text.includes(SECRET)).toBe(false);
    }
  });
});

describe("Usage quota (ELI-341)", () => {
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

  test("GET /api/usage is unauthenticated-blocked", async () => {
    const r = await ctx.app.request("/api/usage");
    expect(r.status).toBe(401);
  });
});

describe("Model capabilities (ELI-341)", () => {
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

describe("Settings — session / cookie hygiene (ELI-341 / ELI-360)", () => {
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

  test("x-user-id header is rejected on settings / usage / capabilities", async () => {
    const targets = [
      { method: "GET" as const, path: "/api/settings/server-model" },
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
      const r = await ctx.app.request(t.path, init);
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      expect([400, 401]).toContain(r.status);
      expect(body.error).toBe("x_user_id_header_not_allowed");
    }
  });

  test("disabled accounts are auto-logged-out on the settings surface", async () => {
    const r1 = await ctx.app.request("/api/settings/server-model", { headers: { cookie: userCookie } });
    expect(r1.status).toBe(200);
    const user = ctx.userRepo.findByUsername("alice")!;
    ctx.userRepo.setEnabled(user.id, false);
    const r2 = await ctx.app.request("/api/settings/server-model", { headers: { cookie: userCookie } });
    expect(r2.status).toBe(401);
    const r3 = await ctx.app.request("/api/usage", { headers: { cookie: userCookie } });
    expect(r3.status).toBe(401);
  });
});
