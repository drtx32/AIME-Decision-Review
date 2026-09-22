/**
 * Per-user daily token quota tests — covers the acceptance criteria from
 * issue ELI-332:
 *   - separate users have separate counters
 *   - day rollover resets effective daily bucket
 *   - 500_000 default/config value loads correctly
 *   - quota exceeded blocks further LLM work with stable error
 *   - provider usage increments correctly
 *   - auth/session identity determines user_id; never trust x-user-id
 *   - no API key in settings responses
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  makeTestServer,
  loginAndCookie,
  type TestServer,
} from "./helpers.ts";
import { hashPassword } from "../src/auth/passwords.ts";
import {
  QuotaRepository,
  QuotaService,
  QuotaExceededError,
  DAILY_TOKEN_QUOTA_EXCEEDED,
  loadDailyQuota,
  localUsageDate,
} from "../src/quota/repository.ts";
import { loadConfig } from "../src/config.ts";
import { _resetModelProviderForTest } from "../src/providers/index.ts";
import { MockModelProvider } from "../src/providers/mock-provider.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";

describe("QuotaRepository — atomic upsert", () => {
  let repo: QuotaRepository;
  const dbPath = join(tmpdir(), `quota-${randomUUID()}.db`);

  beforeEach(() => {
    repo = new QuotaRepository(dbPath);
  });
  afterEach(() => {
    repo.close();
    try {
      rmSync(dbPath, { force: true });
    } catch {
      // ignore
    }
  });

  test("recordUsage creates a row on first call and increments on subsequent calls", () => {
    const userId = "usr_alice";
    const first = repo.recordUsage(userId, {
      inputTokens: 100,
      outputTokens: 50,
      source: "provider",
    });
    expect(first.inputTokens).toBe(100);
    expect(first.outputTokens).toBe(50);
    expect(first.totalTokens).toBe(150);

    const second = repo.recordUsage(userId, {
      inputTokens: 200,
      outputTokens: 75,
      source: "estimated",
    });
    expect(second.inputTokens).toBe(300);
    expect(second.outputTokens).toBe(125);
    expect(second.totalTokens).toBe(425);
  });

  test("two users have separate counters", () => {
    repo.recordUsage("usr_alice", { inputTokens: 100, outputTokens: 50, source: "provider" });
    repo.recordUsage("usr_bob", { inputTokens: 999, outputTokens: 1, source: "provider" });
    expect(repo.getUsage("usr_alice")?.totalTokens).toBe(150);
    expect(repo.getUsage("usr_bob")?.totalTokens).toBe(1000);
  });

  test("usage rolls over when we ask for a different date", () => {
    const userId = "usr_alice";
    repo.recordUsage(userId, { inputTokens: 100, outputTokens: 0, source: "provider" }, new Date("2024-03-15T10:00:00Z"));
    const yesterday = repo.getUsage(userId, new Date("2024-03-15T10:00:00Z"));
    expect(yesterday?.totalTokens).toBe(100);
    const today = repo.getUsage(userId, new Date("2024-03-16T10:00:00Z"));
    expect(today).toBeNull();
  });
});

describe("QuotaService — enforcement", () => {
  let repo: QuotaRepository;
  let service: QuotaService;
  const dbPath = join(tmpdir(), `quota-svc-${randomUUID()}.db`);

  beforeEach(() => {
    repo = new QuotaRepository(dbPath);
    service = new QuotaService({ repo, quota: 500_000 });
  });
  afterEach(() => {
    repo.close();
    try {
      rmSync(dbPath, { force: true });
    } catch {
      // ignore
    }
  });

  test("configuredQuota reads back the configured value", () => {
    expect(service.configuredQuota).toBe(500_000);
  });

  test("snapshot returns 0 used / full remaining for a brand-new user", () => {
    const snap = service.snapshot("usr_alice");
    expect(snap.used).toBe(0);
    expect(snap.remaining).toBe(500_000);
    expect(snap.disabled).toBe(false);
    expect(snap.usageDate).toBe(localUsageDate());
  });

  test("snapshot becomes disabled when quota=0", () => {
    const disabled = new QuotaService({ repo, quota: 0 });
    const snap = disabled.snapshot("usr_alice");
    expect(snap.disabled).toBe(true);
    expect(snap.remaining).toBe(0);
    expect(() => disabled.assertWithinQuota("usr_alice", 1)).toThrow(QuotaExceededError);
  });

  test("assertWithinQuota rejects a planned call that exceeds remaining", () => {
    service.recordAfterCall("usr_alice", { inputTokens: 499_900, outputTokens: 0, source: "provider" });
    expect(() => service.assertWithinQuota("usr_alice", 200)).toThrow(QuotaExceededError);
  });

  test("assertWithinQuota allows a planned call within remaining", () => {
    service.recordAfterCall("usr_alice", { inputTokens: 100, outputTokens: 0, source: "provider" });
    expect(() => service.assertWithinQuota("usr_alice", 499_800)).not.toThrow();
  });

  test("recordAfterCall persists and updates the snapshot", () => {
    const usage = service.recordAfterCall("usr_alice", { inputTokens: 500, outputTokens: 100, source: "provider" });
    expect(usage.totalTokens).toBe(600);
    const snap = service.snapshot("usr_alice");
    expect(snap.used).toBe(600);
    expect(snap.remaining).toBe(500_000 - 600);
  });

  test("recordAfterCall still throws after pushing the user over the quota", () => {
    service.recordAfterCall("usr_alice", { inputTokens: 500_000, outputTokens: 0, source: "provider" });
    expect(() =>
      service.recordAfterCall("usr_alice", { inputTokens: 1, outputTokens: 0, source: "provider" })
    ).toThrow(QuotaExceededError);
  });

  test("QuotaExceededError carries the stable error code", () => {
    try {
      service.assertWithinQuota("usr_alice", 500_001);
    } catch (e) {
      expect(e).toBeInstanceOf(QuotaExceededError);
      expect((e as QuotaExceededError).code).toBe(DAILY_TOKEN_QUOTA_EXCEEDED);
      return;
    }
    throw new Error("expected QuotaExceededError");
  });
});

describe("Config — PLATFORM_DAILY_TOKEN_QUOTA parsing", () => {
  test("default is 500_000 when env is empty", () => {
    expect(loadDailyQuota({})).toBe(500_000);
    expect(loadConfig({}).platformDailyTokenQuota).toBe(500_000);
  });

  test("explicit 500_000 value is loaded", () => {
    expect(loadDailyQuota({ PLATFORM_DAILY_TOKEN_QUOTA: "500000" })).toBe(500_000);
    expect(loadConfig({ PLATFORM_DAILY_TOKEN_QUOTA: "500000" }).platformDailyTokenQuota).toBe(500_000);
  });

  test("0 is allowed (free tier disabled)", () => {
    expect(loadDailyQuota({ PLATFORM_DAILY_TOKEN_QUOTA: "0" })).toBe(0);
    expect(loadConfig({ PLATFORM_DAILY_TOKEN_QUOTA: "0" }).platformDailyTokenQuota).toBe(0);
  });

  test("negative value is rejected", () => {
    expect(() => loadDailyQuota({ PLATFORM_DAILY_TOKEN_QUOTA: "-1" })).toThrow(/>= 0/);
    expect(() => loadConfig({ PLATFORM_DAILY_TOKEN_QUOTA: "-5" })).toThrow(/>= 0/);
  });

  test("non-integer value is rejected", () => {
    expect(() => loadDailyQuota({ PLATFORM_DAILY_TOKEN_QUOTA: "12.5" })).toThrow(/integer/);
  });
});

describe("MockModelProvider — usage reporting", () => {
  test("returns a usage block derived from character count", async () => {
    const provider = new MockModelProvider("mock-model");
    const completion = await provider.complete({
      system: "abcdefgh", // 8 chars => 2 tokens
      user: "a".repeat(40), // 40 chars => 10 tokens
      maxOutputTokens: 32,
    });
    expect(completion.usage).toBeDefined();
    expect(completion.usage!.input).toBe(12);
    expect(completion.usage!.output).toBeGreaterThan(0);
  });
});

describe("Settings API — Settings & Usage contract", () => {
  let ctx: TestServer;
  let aliceCookie: string;
  let bobCookie: string;
  let adminCookie: string;

  beforeEach(async () => {
    ctx = makeTestServer();
    const hash = async (s: string) => hashPassword(s);
    ctx.userRepo.createUser({
      username: "alice",
      passwordHash: await hash("alice-pass-12345"),
      role: "user",
      mustChangePassword: false,
    });
    ctx.userRepo.createUser({
      username: "bob",
      passwordHash: await hash("bob-pass-12345"),
      role: "user",
      mustChangePassword: false,
    });
    ctx.userRepo.createUser({
      username: "ops",
      passwordHash: await hash("ops-pass-12345"),
      role: "admin",
      mustChangePassword: false,
    });
    aliceCookie = await loginAndCookie(ctx.app, ctx.userRepo, "alice", "alice-pass-12345");
    bobCookie = await loginAndCookie(ctx.app, ctx.userRepo, "bob", "bob-pass-12345");
    adminCookie = await loginAndCookie(ctx.app, ctx.userRepo, "ops", "ops-pass-12345");
    _resetModelProviderForTest();
  });
  afterEach(() => ctx.cleanup());

  test("GET /api/settings/quota returns the user's snapshot", async () => {
    const res = await ctx.app.request("/api/settings/quota", { headers: { cookie: aliceCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { quota: { used: number; remaining: number; quota: number } };
    expect(body.quota.quota).toBe(500_000);
    expect(body.quota.used).toBe(0);
    expect(body.quota.remaining).toBe(500_000);
  });

  test("settings/quota is 401 without a session cookie", async () => {
    const res = await ctx.app.request("/api/settings/quota");
    expect(res.status).toBe(401);
  });

  test("settings/model requires admin (403 for normal user)", async () => {
    const res = await ctx.app.request("/api/settings/model", { headers: { cookie: aliceCookie } });
    expect(res.status).toBe(403);
  });

  test("settings/model returns provider info WITHOUT api key and with aggregate", async () => {
    // Pre-record some usage for alice and bob.
    const alice = ctx.userRepo.findByUsername("alice")!;
    const bob = ctx.userRepo.findByUsername("bob")!;
    ctx.quotaRepo.recordUsage(alice.id, { inputTokens: 100, outputTokens: 0, source: "provider" });
    ctx.quotaRepo.recordUsage(bob.id, { inputTokens: 250, outputTokens: 50, source: "provider" });

    const res = await ctx.app.request("/api/settings/model", { headers: { cookie: adminCookie } });
    expect(res.status).toBe(200);
    const raw = await res.text();
    // API key never appears in the payload — baseUrl itself is sanitized to host only.
    expect(raw.includes("apiKey")).toBe(false);
    expect(raw.includes("API_KEY")).toBe(false);
    expect(raw.includes("LLM_API_KEY")).toBe(false);
    const body = JSON.parse(raw) as {
      provider: { id: string; modelName: string; baseHost: string | null; configured: boolean };
      quota: { configured: number; source: string };
      usage: {
        self: { used: number };
        aggregate: Array<{ username: string; usedToday: number; quota: number }>;
      };
    };
    expect(body.provider.id).toBe("mock");
    expect(body.provider.baseHost).toBeNull(); // mock has no baseUrl
    expect(body.quota.configured).toBe(500_000);
    expect(body.quota.source).toBe("PLATFORM_DAILY_TOKEN_QUOTA");
    const usernames = body.usage.aggregate.map((r) => r.username);
    expect(usernames).toContain("alice");
    expect(usernames).toContain("bob");
    const aliceRow = body.usage.aggregate.find((r) => r.username === "alice")!;
    expect(aliceRow.usedToday).toBe(100);
    const bobRow = body.usage.aggregate.find((r) => r.username === "bob")!;
    expect(bobRow.usedToday).toBe(300);
  });

  test("settings endpoints reject client-supplied x-user-id header", async () => {
    const res = await ctx.app.request("/api/settings/quota", {
      headers: { cookie: aliceCookie, "x-user-id": "usr_bob" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("x_user_id_header_not_allowed");
  });
});

describe("Review API — quota enforcement", () => {
  let ctx: TestServer;
  let cookie: string;
  let userId: string;

  beforeEach(async () => {
    ctx = makeTestServer();
    const hash = await hashPassword("quota-user-pass-12345");
    const user = ctx.userRepo.createUser({
      username: "quota-user",
      passwordHash: hash,
      role: "user",
      mustChangePassword: false,
    });
    userId = user.id;
    cookie = await loginAndCookie(ctx.app, ctx.userRepo, "quota-user", "quota-user-pass-12345");
    _resetModelProviderForTest();
  });
  afterEach(() => ctx.cleanup());

  test("successful review increments the user's daily token bucket", async () => {
    const before = ctx.quotaRepo.getUsage(userId)?.totalTokens ?? 0;
    const res = await ctx.app.request("/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        symbol: "600519",
        market: "CN",
        action: "buy",
        executedAt: "2024-03-15T00:00:00Z",
        price: 1620,
        quantity: 100,
        userReason: "Channel checks pre-T0; brand pricing intact.",
      }),
    });
    expect(res.status).toBe(202);
    const after = ctx.quotaRepo.getUsage(userId)?.totalTokens ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  test("quota=0 disables LLM work and surfaces the stable error code", async () => {
    // Build a fresh server with quota=0 — simulates PLATFORM_DAILY_TOKEN_QUOTA=0.
    const freshCfg = { ...ctx.cfg, platformDailyTokenQuota: 0 };
    const disabled = makeTestServer();
    // Reuse the same DB path but rebuild with disabled quota.
    disabled.cleanup();
    const { buildServer } = await import("../src/server.ts");
    const zero = buildServer(freshCfg);
    try {
      const freshHash = await hashPassword("quota-disabled-pass-12345");
      zero.userRepo.createUser({
        username: "quota-disabled-user",
        passwordHash: freshHash,
        role: "user",
        mustChangePassword: false,
      });
      const disabledCookie = await loginAndCookie(zero.app, zero.userRepo, "quota-disabled-user", "quota-disabled-pass-12345");
      const res = await zero.app.request("/api/reviews", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: disabledCookie },
        body: JSON.stringify({
          symbol: "600519",
          market: "CN",
          action: "buy",
          executedAt: "2024-03-15T00:00:00Z",
          userReason: "test",
        }),
      });
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("DAILY_TOKEN_QUOTA_EXCEEDED");
    } finally {
      zero.repo.close();
      zero.userRepo.close();
      zero.deps.quotaRepo.close();
      try {
        rmSync(freshCfg.sqlitePath, { force: true });
      } catch {
        // ignore
      }
    }
  });

  test("quota exceeded mid-run blocks further LLM work with stable error code", async () => {
    // Simulate "exhausted" by pre-filling the user's bucket right up to the
    // configured limit, then make a review call. The agent's pre-check
    // should trip before any LLM call is attempted, but in case the
    // provider reports more than estimated we want the stable error code
    // to be visible.
    ctx.quotaRepo.recordUsage(userId, { inputTokens: 500_000, outputTokens: 0, source: "provider" });

    const res = await ctx.app.request("/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        symbol: "600519",
        market: "CN",
        action: "buy",
        executedAt: "2024-03-15T00:00:00Z",
        userReason: "test",
      }),
    });
    // Pre-check fires; returns 429 with stable error code.
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("DAILY_TOKEN_QUOTA_EXCEEDED");
  });

  test("two users have separate counters", async () => {
    const aliceHash = await hashPassword("quota-alice-pass-12345");
    const bobHash = await hashPassword("quota-bob-pass-12345");
    const aliceUser = ctx.userRepo.createUser({
      username: "quota-alice",
      passwordHash: aliceHash,
      role: "user",
      mustChangePassword: false,
    });
    const bobUser = ctx.userRepo.createUser({
      username: "quota-bob",
      passwordHash: bobHash,
      role: "user",
      mustChangePassword: false,
    });
    // Manually record usage for each.
    ctx.quotaRepo.recordUsage(aliceUser.id, { inputTokens: 100, outputTokens: 0, source: "provider" });
    ctx.quotaRepo.recordUsage(bobUser.id, { inputTokens: 200, outputTokens: 50, source: "provider" });
    expect(ctx.quotaRepo.getUsage(aliceUser.id)?.totalTokens).toBe(100);
    expect(ctx.quotaRepo.getUsage(bobUser.id)?.totalTokens).toBe(250);
    // Distinct snapshots.
    const aliceSnap = ctx.deps.quota.snapshot(aliceUser.id);
    const bobSnap = ctx.deps.quota.snapshot(bobUser.id);
    expect(aliceSnap.used).toBe(100);
    expect(bobSnap.used).toBe(250);
  });
});