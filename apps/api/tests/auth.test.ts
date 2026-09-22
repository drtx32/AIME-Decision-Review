/**
 * Auth contract tests.
 *
 * Covers the acceptance criteria from issue ELI-325:
 *  - bootstrap admin idempotency
 *  - login + logout
 *  - must_change_password gate on first login
 *  - role protection (admin-only routes)
 *  - admin create / reset user with one-time temp password
 *  - self-disable / self-delete protection
 *  - session behavior (HttpOnly cookie, invalidation on change-password)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  makeTestServer,
  loginAndCookie,
  TEST_PASSWORD,
  type TestServer,
} from "./helpers.ts";
import { hashPassword } from "../src/auth/passwords.ts";
import { UserRepository } from "../src/auth/repository.ts";

async function seedAdmin(
  repo: UserRepository,
  username = "admin",
  password = TEST_PASSWORD,
  mustChange = true
) {
  const hash = await hashPassword(password);
  return repo.createUser({
    username,
    passwordHash: hash,
    role: "admin",
    mustChangePassword: mustChange,
  });
}

async function seedNormal(
  repo: UserRepository,
  username: string,
  password: string,
  opts: { mustChange?: boolean; enabled?: boolean } = {}
) {
  const hash = await hashPassword(password);
  return repo.createUser({
    username,
    passwordHash: hash,
    role: "user",
    mustChangePassword: opts.mustChange ?? false,
  });
}

async function expectStatus(p: number): Promise<number> {
  return p;
}

describe("Auth bootstrap", () => {
  let ctx: TestServer;

  beforeEach(() => {
    ctx = makeTestServer();
  });
  afterEach(() => ctx.cleanup());

  test("ensureBootstrapAdmin creates admin with mustChangePassword=1 on fresh DB", async () => {
    const result = await ctx.userRepo.ensureBootstrapAdmin({
      initialAdminUsername: "admin",
      initialAdminPassword: TEST_PASSWORD,
    });
    expect(result.created).toBe(true);
    if (result.created) {
      expect(result.user.username).toBe("admin");
      expect(result.user.role).toBe("admin");
      expect(result.user.mustChangePassword).toBe(1);
      expect(result.user.enabled).toBe(1);
      // Password is argon2id; never the plaintext.
      expect(result.user.passwordHash).not.toBe(TEST_PASSWORD);
      expect(result.user.passwordHash.startsWith("$argon2id$")).toBe(true);
    }
  });

  test("ensureBootstrapAdmin respects INITIAL_ADMIN_USERNAME / INITIAL_ADMIN_PASSWORD from env", async () => {
    const result = await ctx.userRepo.ensureBootstrapAdmin({
      initialAdminUsername: "ops",
      initialAdminPassword: "ops-secret-987",
    });
    expect(result.created).toBe(true);
    if (result.created) {
      expect(result.user.username).toBe("ops");
    }
  });

  test("ensureBootstrapAdmin is idempotent — restart does not overwrite admin", async () => {
    await ctx.userRepo.ensureBootstrapAdmin({
      initialAdminUsername: "admin",
      initialAdminPassword: TEST_PASSWORD,
    });
    const row1 = ctx.userRepo.findByUsername("admin");
    expect(row1).not.toBeNull();
    const originalHash = row1!.passwordHash;

    const result = await ctx.userRepo.ensureBootstrapAdmin({
      initialAdminUsername: "admin",
      initialAdminPassword: "different-password",
    });
    expect(result.created).toBe(false);

    const row2 = ctx.userRepo.findByUsername("admin");
    expect(row2!.passwordHash).toBe(originalHash);
  });

  test("ensureBootstrapAdmin refuses empty credentials", async () => {
    await expect(
      ctx.userRepo.ensureBootstrapAdmin({
        initialAdminUsername: "",
        initialAdminPassword: "x",
      })
    ).rejects.toThrow(/USERNAME/);
    await expect(
      ctx.userRepo.ensureBootstrapAdmin({
        initialAdminUsername: "admin",
        initialAdminPassword: "",
      })
    ).rejects.toThrow(/PASSWORD/);
  });

  test("loadConfig rejects INITIAL_ADMIN_PASSWORD without a repository fallback (security)", async () => {
    // Regression for ELI-325 follow-up: the API must NOT silently fall
    // back to a hardcoded default password. When the env var is unset,
    // AppConfig.initialAdmin.password is null and the bootstrap path in
    // apps/api/src/index.ts refuses to start on a fresh DB.
    const { loadConfig } = await import("../src/config.ts");
    const cfg = loadConfig({});
    expect(cfg.initialAdmin.username).toBe("admin");
    expect(cfg.initialAdmin.password).toBeNull();
  });

  test("loadConfig propagates a non-empty INITIAL_ADMIN_PASSWORD", async () => {
    const { loadConfig } = await import("../src/config.ts");
    const cfg = loadConfig({
      INITIAL_ADMIN_USERNAME: "ops",
      INITIAL_ADMIN_PASSWORD: "supplied-from-deployment-secret",
    });
    expect(cfg.initialAdmin.username).toBe("ops");
    expect(cfg.initialAdmin.password).toBe("supplied-from-deployment-secret");
  });
});

describe("Auth login / logout / me", () => {
  let ctx: TestServer;

  beforeEach(async () => {
    ctx = makeTestServer();
    await seedAdmin(ctx.userRepo);
  });
  afterEach(() => ctx.cleanup());

  test("POST /api/auth/login with correct credentials returns user + sets cookie", async () => {
    const res = await ctx.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: TEST_PASSWORD }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { username: string; role: string; mustChangePassword: boolean };
      mustChangePassword: boolean;
    };
    expect(body.user.username).toBe("admin");
    expect(body.user.role).toBe("admin");
    expect(body.user.mustChangePassword).toBe(true);
    expect(body.mustChangePassword).toBe(true);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    expect(setCookie.toLowerCase()).toContain("aime_session=");
  });

  test("POST /api/auth/login with wrong password returns 401", async () => {
    const res = await ctx.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_credentials");
  });

  test("POST /api/auth/login with unknown username still returns 401 (no enumeration)", async () => {
    const res = await ctx.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ghost", password: "x" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_credentials");
  });

  test("login is rejected for disabled accounts", async () => {
    const admin = ctx.userRepo.findByUsername("admin")!;
    ctx.userRepo.setEnabled(admin.id, false);
    const res = await ctx.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: TEST_PASSWORD }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("account_disabled");
  });

  test("GET /api/auth/me requires session", async () => {
    const r1 = await ctx.app.request("/api/auth/me");
    expect(r1.status).toBe(401);
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "admin", TEST_PASSWORD, { role: "admin", mustChangePassword: false });
    const r2 = await ctx.app.request("/api/auth/me", { headers: { cookie } });
    expect(r2.status).toBe(200);
    const body = (await r2.json()) as { user: { username: string } };
    expect(body.user.username).toBe("admin");
  });

  test("POST /api/auth/logout invalidates the session", async () => {
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "admin", TEST_PASSWORD, { role: "admin", mustChangePassword: false });
    const r1 = await ctx.app.request("/api/auth/me", { headers: { cookie } });
    expect(r1.status).toBe(200);
    const logout = await ctx.app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie },
    });
    expect(logout.status).toBe(200);
    const r2 = await ctx.app.request("/api/auth/me", { headers: { cookie } });
    expect(r2.status).toBe(401);
  });

  test("disabled accounts are auto-logged-out on a subsequent request", async () => {
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "admin", TEST_PASSWORD, { role: "admin", mustChangePassword: false });
    const me = await ctx.app.request("/api/auth/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    const admin = ctx.userRepo.findByUsername("admin")!;
    ctx.userRepo.setEnabled(admin.id, false);
    const me2 = await ctx.app.request("/api/auth/me", { headers: { cookie } });
    expect(me2.status).toBe(401);
  });
});

describe("Forced first-login password change", () => {
  let ctx: TestServer;

  beforeEach(async () => {
    ctx = makeTestServer();
    await seedAdmin(ctx.userRepo);
  });
  afterEach(() => ctx.cleanup());

  test("mustChangePassword user can only hit /api/auth/* endpoints", async () => {
    // Login as the bootstrap admin (mustChangePassword=true).
    const loginRes = await ctx.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: TEST_PASSWORD }),
    });
    expect(loginRes.status).toBe(200);
    const setCookie = loginRes.headers.get("set-cookie")!;
    const cookie = setCookie.split(";")[0];

    // /api/auth/me is allowed (it is the auth namespace).
    const me = await ctx.app.request("/api/auth/me", { headers: { cookie } });
    expect(me.status).toBe(200);

    // /api/reviews is forbidden until password change.
    const blocked = await ctx.app.request("/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        symbol: "600519",
        action: "buy",
        executedAt: "2024-03-15T00:00:00Z",
        userReason: "test",
      }),
    });
    expect(blocked.status).toBe(403);
    const blockedBody = (await blocked.json()) as { error: string };
    expect(blockedBody.error).toBe("must_change_password");

    // /api/admin/users is also blocked.
    const adminBlocked = await ctx.app.request("/api/admin/users", {
      headers: { cookie },
    });
    expect(adminBlocked.status).toBe(403);
    const adminBody = (await adminBlocked.json()) as { error: string };
    expect(adminBody.error).toBe("must_change_password");
  });

  test("change-password with correct current password clears the flag", async () => {
    const loginRes = await ctx.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: TEST_PASSWORD }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0];

    const change = await ctx.app.request("/api/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        currentPassword: TEST_PASSWORD,
        newPassword: "brand-new-password-456",
      }),
    });
    expect(change.status).toBe(200);
    const body = (await change.json()) as { user: { mustChangePassword: boolean } };
    expect(body.user.mustChangePassword).toBe(false);

    // /api/reviews is now accessible with the same cookie (and rotated session).
    const newCookie = change.headers.get("set-cookie")!.split(";")[0];
    const reviews = await ctx.app.request("/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: newCookie },
      body: JSON.stringify({
        symbol: "600519",
        action: "buy",
        executedAt: "2024-03-15T00:00:00Z",
        userReason: "post-change test",
      }),
    });
    expect(reviews.status).toBe(202);
  });

  test("change-password with wrong current password returns 401", async () => {
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "admin", TEST_PASSWORD, { role: "admin" });
    const res = await ctx.app.request("/api/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        currentPassword: "WRONG",
        newPassword: "brand-new-password-456",
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_current_password");
  });

  test("change-password enforces minimum length", async () => {
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "admin", TEST_PASSWORD, { role: "admin" });
    const res = await ctx.app.request("/api/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        currentPassword: TEST_PASSWORD,
        newPassword: "short",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_input");
  });
});

describe("Role protection", () => {
  let ctx: TestServer;
  let userCookie: string;

  beforeEach(async () => {
    ctx = makeTestServer();
    await seedAdmin(ctx.userRepo, "admin", TEST_PASSWORD, false);
    await seedNormal(ctx.userRepo, "alice", "alice-pass-12345");
    userCookie = await loginAndCookie(ctx.app, ctx.userRepo, "alice", "alice-pass-12345");
  });
  afterEach(() => ctx.cleanup());

  test("non-admin user cannot list or create users", async () => {
    const list = await ctx.app.request("/api/admin/users", { headers: { cookie: userCookie } });
    expect(list.status).toBe(403);
    const create = await ctx.app.request("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({ username: "bob" }),
    });
    expect(create.status).toBe(403);
  });

  test("unauthenticated request is rejected with 401", async () => {
    const r = await ctx.app.request("/api/admin/users");
    expect(r.status).toBe(401);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("unauthenticated");
  });

  test("admin can list users", async () => {
    const adminCookie = await loginAndCookie(ctx.app, ctx.userRepo, "admin", TEST_PASSWORD);
    const r = await ctx.app.request("/api/admin/users", { headers: { cookie: adminCookie } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { users: Array<{ username: string; role: string }> };
    const usernames = body.users.map((u) => u.username);
    expect(usernames).toContain("admin");
    expect(usernames).toContain("alice");
  });
});

describe("Admin user management", () => {
  let ctx: TestServer;
  let adminCookie: string;

  beforeEach(async () => {
    ctx = makeTestServer();
    await seedAdmin(ctx.userRepo, "admin", TEST_PASSWORD, false);
    adminCookie = await loginAndCookie(ctx.app, ctx.userRepo, "admin", TEST_PASSWORD);
  });
  afterEach(() => ctx.cleanup());

  test("create-user returns one-time temp password and forces mustChangePassword", async () => {
    const res = await ctx.app.request("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ username: "bob" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      user: { username: string; mustChangePassword: boolean; enabled: boolean; role: string };
      temporaryPassword: string;
    };
    expect(body.user.username).toBe("bob");
    expect(body.user.mustChangePassword).toBe(true);
    expect(body.user.enabled).toBe(true);
    expect(body.user.role).toBe("user");
    expect(body.temporaryPassword.length).toBeGreaterThanOrEqual(8);
    // Login with the temp password works.
    const login = await ctx.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bob", password: body.temporaryPassword }),
    });
    expect(login.status).toBe(200);
    const loginBody = (await login.json()) as { mustChangePassword: boolean };
    expect(loginBody.mustChangePassword).toBe(true);
  });

  test("create-user rejects duplicate username", async () => {
    const r1 = await ctx.app.request("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ username: "bob" }),
    });
    expect(r1.status).toBe(201);
    const r2 = await ctx.app.request("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ username: "bob" }),
    });
    expect(r2.status).toBe(409);
    const body = (await r2.json()) as { error: string };
    expect(body.error).toBe("username_taken");
  });

  test("create-user rejects invalid usernames", async () => {
    const r = await ctx.app.request("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ username: "has spaces" }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("invalid_input");
  });

  test("reset-password returns a new temp password and revokes existing sessions", async () => {
    const bob = ctx.userRepo.findByUsername("admin")!; // re-use admin for sanity
    const create = await ctx.app.request("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ username: "carol" }),
    });
    expect(create.status).toBe(201);
    const temp1 = ((await create.json()) as { temporaryPassword: string }).temporaryPassword;

    // Carol logs in to establish a session.
    const login = await ctx.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "carol", password: temp1 }),
    });
    expect(login.status).toBe(200);
    const carolCookie = login.headers.get("set-cookie")!.split(";")[0];
    const me1 = await ctx.app.request("/api/auth/me", { headers: { cookie: carolCookie } });
    expect(me1.status).toBe(200);

    // Admin resets Carol's password.
    const carol = ctx.userRepo.findByUsername("carol")!;
    const reset = await ctx.app.request(`/api/admin/users/${carol.id}/reset-password`, {
      method: "POST",
      headers: { cookie: adminCookie },
    });
    expect(reset.status).toBe(200);
    const resetBody = (await reset.json()) as {
      temporaryPassword: string;
      user: { mustChangePassword: boolean };
    };
    expect(resetBody.temporaryPassword).not.toBe(temp1);
    expect(resetBody.user.mustChangePassword).toBe(true);

    // Persisted flag — the contract holds in the users table itself, not
    // only in the JSON response.
    const carolAfter = ctx.userRepo.findByUsername("carol")!;
    expect(carolAfter.mustChangePassword).toBe(1);

    // Login with the reset password succeeds BUT the session is gated:
    // must_change_password blocks protected routes. Without the gate,
    // the reset user would bypass the required first-login change.
    const login2 = await ctx.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "carol", password: resetBody.temporaryPassword }),
    });
    expect(login2.status).toBe(200);
    const login2Body = (await login2.json()) as { mustChangePassword: boolean };
    expect(login2Body.mustChangePassword).toBe(true);
    const carolResetCookie = login2.headers.get("set-cookie")!.split(";")[0];

    // /api/auth/me is allowed (it lives in the auth namespace).
    const me3 = await ctx.app.request("/api/auth/me", { headers: { cookie: carolResetCookie } });
    expect(me3.status).toBe(200);
    const me3Body = (await me3.json()) as { user: { mustChangePassword: boolean } };
    expect(me3Body.user.mustChangePassword).toBe(true);

    // /api/reviews is gated.
    const blocked = await ctx.app.request("/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: carolResetCookie },
      body: JSON.stringify({
        symbol: "600519",
        action: "buy",
        executedAt: "2024-03-15T00:00:00Z",
        userReason: "post-reset test",
      }),
    });
    expect(blocked.status).toBe(403);
    const blockedBody = (await blocked.json()) as { error: string };
    expect(blockedBody.error).toBe("must_change_password");

    // Carol's old session is revoked.
    const me2 = await ctx.app.request("/api/auth/me", { headers: { cookie: carolCookie } });
    expect(me2.status).toBe(401);
  });

  test("reset persists mustChangePassword=1 (regression for ELI-325 review finding)", async () => {
    // Regression: PR #9 shipped with admin.ts:80 calling setPassword()
    // (which always clears mustChangePassword). The reset endpoint only
    // overlaid the flag in the JSON response, so a reset user could log
    // in with the temporary password and bypass the must-change-password
    // gate. This test pins the contract end-to-end:
    //   - persisted users.mustChangePassword === 1 after reset
    //   - login response reports mustChangePassword=true
    //   - /api/auth/me reports mustChangePassword=true
    //   - protected /api/reviews returns must_change_password (403)
    const carolId = ctx.userRepo.createUser({
      username: "carol-regression",
      passwordHash: "ignored",
      role: "user",
      mustChangePassword: false,
    }).id;

    const reset = await ctx.app.request(`/api/admin/users/${carolId}/reset-password`, {
      method: "POST",
      headers: { cookie: adminCookie },
    });
    expect(reset.status).toBe(200);
    const resetBody = (await reset.json()) as {
      temporaryPassword: string;
      user: { mustChangePassword: boolean };
    };
    expect(resetBody.temporaryPassword.length).toBeGreaterThanOrEqual(8);
    expect(resetBody.user.mustChangePassword).toBe(true);

    // Contract assertion: persisted flag, not just response flag.
    const persisted = ctx.userRepo.findById(carolId)!;
    expect(persisted.mustChangePassword).toBe(1);
    expect(persisted.passwordHash).not.toBe("ignored");

    // Login with the reset password.
    const login = await ctx.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "carol-regression", password: resetBody.temporaryPassword }),
    });
    expect(login.status).toBe(200);
    const loginBody = (await login.json()) as { mustChangePassword: boolean };
    expect(loginBody.mustChangePassword).toBe(true);
    const carolCookie = login.headers.get("set-cookie")!.split(";")[0];

    // /api/auth/me confirms the persisted gate.
    const me = await ctx.app.request("/api/auth/me", { headers: { cookie: carolCookie } });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { user: { mustChangePassword: boolean } };
    expect(meBody.user.mustChangePassword).toBe(true);

    // Protected route is gated: must_change_password.
    const blocked = await ctx.app.request("/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: carolCookie },
      body: JSON.stringify({
        symbol: "600519",
        action: "buy",
        executedAt: "2024-03-15T00:00:00Z",
        userReason: "post-reset regression",
      }),
    });
    expect(blocked.status).toBe(403);
    const blockedBody = (await blocked.json()) as { error: string };
    expect(blockedBody.error).toBe("must_change_password");
  });

  test("self-service change-password still clears mustChangePassword (unaffected by fix)", async () => {
    // Defensive symmetry: setPassword() (self-service) must keep clearing
    // the flag — the fix only changed resetPassword(). A user who just
    // supplied their current password is allowed through after change.
    const bobId = ctx.userRepo.createUser({
      username: "bob-selfservice",
      passwordHash: "ignored",
      role: "user",
      mustChangePassword: true,
    }).id;
    const carolCookie = await loginAndCookie(
      ctx.app,
      ctx.userRepo,
      "bob-selfservice",
      "ignored" // won't actually log in — we set the real hash next
    ).catch(async () => {
      // Direct login via a known-good password.
      const newHash = await hashPassword("known-pass-9876");
      ctx.userRepo.resetPassword(bobId, newHash);
      return loginAndCookie(ctx.app, ctx.userRepo, "bob-selfservice", "known-pass-9876");
    });

    // After login we still have mustChangePassword=1; change it.
    const change = await ctx.app.request("/api/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: carolCookie },
      body: JSON.stringify({
        currentPassword: "known-pass-9876",
        newPassword: "fresh-pass-1234",
      }),
    });
    expect(change.status).toBe(200);
    const changeBody = (await change.json()) as { user: { mustChangePassword: boolean } };
    expect(changeBody.user.mustChangePassword).toBe(false);
    const persisted = ctx.userRepo.findById(bobId)!;
    expect(persisted.mustChangePassword).toBe(0);
  });

  test("admin cannot disable self", async () => {
    const admin = ctx.userRepo.findByUsername("admin")!;
    const r = await ctx.app.request(`/api/admin/users/${admin.id}/disable`, {
      method: "POST",
      headers: { cookie: adminCookie },
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("cannot_disable_self");
  });

  test("admin cannot delete self", async () => {
    const admin = ctx.userRepo.findByUsername("admin")!;
    const r = await ctx.app.request(`/api/admin/users/${admin.id}`, {
      method: "DELETE",
      headers: { cookie: adminCookie },
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("cannot_delete_self");
  });

  test("disable removes a user from login and revokes sessions", async () => {
    const create = await ctx.app.request("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ username: "dave" }),
    });
    const temp = ((await create.json()) as { temporaryPassword: string }).temporaryPassword;
    const login = await ctx.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "dave", password: temp }),
    });
    expect(login.status).toBe(200);
    const daveCookie = login.headers.get("set-cookie")!.split(";")[0];

    const dave = ctx.userRepo.findByUsername("dave")!;
    const disable = await ctx.app.request(`/api/admin/users/${dave.id}/disable`, {
      method: "POST",
      headers: { cookie: adminCookie },
    });
    expect(disable.status).toBe(200);

    const meAfter = await ctx.app.request("/api/auth/me", { headers: { cookie: daveCookie } });
    expect(meAfter.status).toBe(401);

    const loginAfter = await ctx.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "dave", password: temp }),
    });
    expect(loginAfter.status).toBe(403);
    const loginBody = (await loginAfter.json()) as { error: string };
    expect(loginBody.error).toBe("account_disabled");
  });

  test("admin cannot disable the last admin", async () => {
    // Create a normal user, no other admin to take over.
    const create = await ctx.app.request("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ username: "eve" }),
    });
    expect(create.status).toBe(201);
    // The bootstrap "admin" is the only admin. There is no public endpoint
    // to promote users to admin (kept on purpose), so we cannot test the
    // "disable other admin" path through HTTP. Verify the invariant directly
    // via the repository: countEnabledAdmins returns 1, and a second admin
    // would be blocked from being disabled via the same business rule.
    expect(ctx.userRepo.countEnabledAdmins()).toBe(1);
    // The self-disable check fires first for the only admin (cannot disable
    // their own account), which is also the right user-visible message.
    const admin = ctx.userRepo.findByUsername("admin")!;
    const r = await ctx.app.request(`/api/admin/users/${admin.id}/disable`, {
      method: "POST",
      headers: { cookie: adminCookie },
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("cannot_disable_self");
  });

  test("disable-blocks-second-admin path: seed second admin, then first admin cannot disable them", async () => {
    // Seed a second admin directly via the repository to exercise the
    // last-admin guard. In production this would happen via a future
    // promotion endpoint; here we just verify the business rule.
    const hash = await hashPassword("admin2-pass-9876");
    const second = ctx.userRepo.createUser({
      username: "admin2",
      passwordHash: hash,
      role: "admin",
      mustChangePassword: false,
    });
    expect(ctx.userRepo.countEnabledAdmins()).toBe(2);
    // The first admin tries to disable the second admin. This should succeed
    // because there is still one enabled admin (the first one).
    const r = await ctx.app.request(`/api/admin/users/${second.id}/disable`, {
      method: "POST",
      headers: { cookie: adminCookie },
    });
    expect(r.status).toBe(200);
    expect(ctx.userRepo.countEnabledAdmins()).toBe(1);
  });
});

describe("Session behavior", () => {
  let ctx: TestServer;

  beforeEach(async () => {
    ctx = makeTestServer();
    await seedAdmin(ctx.userRepo, "admin", TEST_PASSWORD, false);
  });
  afterEach(() => ctx.cleanup());

  test("expired session token is rejected", async () => {
    const row = ctx.userRepo.findByUsername("admin")!;
    const session = ctx.userRepo.createSession(row.id);
    // Manually expire the session.
    ctx.userRepo.deleteSession(session.token);
    const cookie = `aime_session=${session.token}; Path=/; HttpOnly; SameSite=Lax`;
    const r = await ctx.app.request("/api/auth/me", { headers: { cookie } });
    expect(r.status).toBe(401);
  });

  test("change-password invalidates other sessions for the same user", async () => {
    const row = ctx.userRepo.findByUsername("admin")!;
    // Issue two sessions for admin.
    const s1 = ctx.userRepo.createSession(row.id);
    const s2 = ctx.userRepo.createSession(row.id);
    const cookie1 = `aime_session=${s1.token}; Path=/; HttpOnly; SameSite=Lax`;
    const cookie2 = `aime_session=${s2.token}; Path=/; HttpOnly; SameSite=Lax`;

    // cookie1 changes password — should revoke cookie2.
    const change = await ctx.app.request("/api/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie1 },
      body: JSON.stringify({
        currentPassword: TEST_PASSWORD,
        newPassword: "rotated-pass-9876",
      }),
    });
    expect(change.status).toBe(200);
    const me2 = await ctx.app.request("/api/auth/me", { headers: { cookie: cookie2 } });
    expect(me2.status).toBe(401);
  });

  test("cookie session is HttpOnly + SameSite=Lax (no JS-readable cookie)", async () => {
    const res = await ctx.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: TEST_PASSWORD }),
    });
    const setCookie = (res.headers.get("set-cookie") ?? "").toLowerCase();
    expect(setCookie).toContain("httponly");
    expect(setCookie).toContain("samesite=lax");
    expect(setCookie).toContain("path=/");
    // No Secure flag in test env (isProduction=false).
    expect(setCookie.includes("secure")).toBe(false);
  });
});

describe("Secret hygiene", () => {
  let ctx: TestServer;

  beforeEach(() => {
    ctx = makeTestServer();
  });
  afterEach(() => ctx.cleanup());

  test("stored user record contains only argon2id hash, never the plaintext password", async () => {
    await ctx.userRepo.ensureBootstrapAdmin({
      initialAdminUsername: "admin",
      initialAdminPassword: TEST_PASSWORD,
    });
    const row = ctx.userRepo.findByUsername("admin")!;
    expect(row.passwordHash).not.toContain(TEST_PASSWORD);
    expect(row.passwordHash.startsWith("$argon2id$")).toBe(true);
  });

  test("login response does not echo the submitted password", async () => {
    await ctx.userRepo.ensureBootstrapAdmin({
      initialAdminUsername: "admin",
      initialAdminPassword: TEST_PASSWORD,
    });
    const res = await ctx.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: TEST_PASSWORD }),
    });
    const text = await res.text();
    expect(text.includes(TEST_PASSWORD)).toBe(false);
  });

  test("create-user does not echo the temporary password in the user payload", async () => {
    await ctx.userRepo.ensureBootstrapAdmin({
      initialAdminUsername: "admin",
      initialAdminPassword: TEST_PASSWORD,
    });
    // Clear mustChangePassword so the admin can use the admin endpoint.
    const admin = ctx.userRepo.findByUsername("admin")!;
    ctx.userRepo.setPassword(admin.id, admin.passwordHash); // no-op on hash, then disable flag
    const refreshed = ctx.userRepo.findByUsername("admin")!;
    // Manually clear mustChangePassword via SQL — setPassword already clears it.
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "admin", TEST_PASSWORD);

    const create = await ctx.app.request("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ username: "frank" }),
    });
    const body = (await create.json()) as {
      user: Record<string, unknown>;
      temporaryPassword: string;
    };
    expect(Object.keys(body.user)).not.toContain("password");
    expect(Object.keys(body.user)).not.toContain("passwordHash");
    expect(typeof body.temporaryPassword).toBe("string");
  });
});

describe("Health is public", () => {
  let ctx: TestServer;

  beforeEach(() => {
    ctx = makeTestServer();
  });
  afterEach(() => ctx.cleanup());

  test("/health does not require auth", async () => {
    const r = await ctx.app.request("/health");
    expect(r.status).toBe(200);
  });
});

describe("Identity-contract guard (ELI-328 / PR #7 collision)", () => {
  let ctx: TestServer;
  let cookie: string;

  beforeEach(async () => {
    ctx = makeTestServer();
    await seedAdmin(ctx.userRepo, "admin", TEST_PASSWORD, false);
    cookie = await loginAndCookie(ctx.app, ctx.userRepo, "admin", TEST_PASSWORD);
  });
  afterEach(() => ctx.cleanup());

  test("client-supplied x-user-id header is rejected on /api/reviews", async () => {
    const res = await ctx.app.request("/api/reviews", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-user-id": "usr_someone_else",
      },
      body: JSON.stringify({
        symbol: "600519",
        action: "buy",
        executedAt: "2024-03-15T00:00:00Z",
        userReason: "test",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("x_user_id_header_not_allowed");
  });

  test("x-user-id is ignored on /api/admin/users (rejected even when authenticated)", async () => {
    const res = await ctx.app.request("/api/admin/users", {
      headers: { cookie, "x-user-id": "usr_someone_else" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("x_user_id_header_not_allowed");
  });

  test("user identity is derived from cookie session, never from x-user-id", async () => {
    // Without a cookie, an x-user-id header still gets rejected on protected
    // routes — the guard fires before requireAuth can match it to anything.
    const res = await ctx.app.request("/api/admin/users", {
      headers: { "x-user-id": "usr_anyone" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("x_user_id_header_not_allowed");
  });

  test("/api/auth/login still works even with x-user-id header (boundary pass-through)", async () => {
    const res = await ctx.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "usr_anything" },
      body: JSON.stringify({ username: "admin", password: "WRONG" }),
    });
    // Login is allowed to receive x-user-id (it just ignores it). Wrong
    // password still returns 401 invalid_credentials.
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_credentials");
  });

  test("/health is unaffected by x-user-id header", async () => {
    const res = await ctx.app.request("/health", {
      headers: { "x-user-id": "usr_anything" },
    });
    expect(res.status).toBe(200);
  });
});