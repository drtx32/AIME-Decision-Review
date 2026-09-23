/**
 * Test helpers — build a server with a fresh in-memory SQLite and the
 * default mock registry. Each test gets a clean state.
 *
 * The `initialAdmin.password` here is a placeholder used only to satisfy
 * the non-null AppConfig shape; the bootstrap path is bypassed in tests
 * by seeding users directly via UserRepository, so this value never
 * reaches the database and is never logged.
 */

/**
 * Shared test-only password. Not a credential shape, not committed to
 * any production path — only used by bun:test cases that need to log in
 * as a seeded admin/user. The plaintext-vs-hash separation tests rely
 * on this exact value never appearing in stored hashes or response
 * bodies; see the secret-hygiene describe block in auth.test.ts.
 */
export const TEST_PASSWORD = "test-only-bootstrap-password-do-not-reuse";

import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../src/config.ts";
import { buildServer } from "../src/server.ts";
import { hashPassword } from "../src/auth/passwords.ts";

export function makeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    sqlitePath: join(tmpdir(), `decision-review-${randomUUID()}.db`),
    logLevel: "error",
    isProduction: false,
    initialAdmin: {
      username: "admin",
      // Test-only placeholder. The bootstrap path runs only in the
      // dedicated ensureBootstrapAdmin tests; everywhere else users are
      // seeded explicitly. Never reuse this literal as a real credential.
      password: TEST_PASSWORD,
    },
    llm: {
      provider: "mock",
      model: "mvp-mock",
      baseUrl: null,
      apiKey: null,
    },
    fuyao: {
      baseUrl: null,
      apiKey: null,
      servers: ["a-share", "a-share-index", "fund", "futures", "options", "meta"],
    },
    ifind: {
      baseUrl: null,
      authorization: null,
      servers: ["ds", "enterprise", "law", "stock", "fund", "edb", "news", "bond", "global-stock", "index", "futures"],
    },
    ...overrides,
  } as AppConfig;
}

export function makeTestServer(): TestServer {
  const cfg = makeTestConfig();
  const { app, deps, repo, userRepo, settingsRepo } = buildServer(cfg);
  return {
    app,
    deps,
    repo,
    userRepo,
    settingsRepo,
    cfg,
    cleanup: () => {
      repo.close();
      userRepo.close();
      settingsRepo.close();
      try {
        rmSync(cfg.sqlitePath, { force: true });
      } catch {
        // ignore
      }
    },
  };
}

export interface TestServer {
  app: ReturnType<typeof buildServer>["app"];
  deps: ReturnType<typeof buildServer>["deps"];
  repo: ReturnType<typeof buildServer>["repo"];
  userRepo: ReturnType<typeof buildServer>["userRepo"];
  settingsRepo: ReturnType<typeof buildServer>["settingsRepo"];
  cfg: AppConfig;
  cleanup: () => void;
}

/**
 * Seed a normal user with the given username + password. Useful for tests
 * that want to log in via the API rather than poke the repo directly.
 */
export async function seedUser(
  userRepo: TestServer["userRepo"],
  username: string,
  password: string,
  opts: { role?: "admin" | "user"; mustChangePassword?: boolean } = {}
) {
  const hash = await hashPassword(password);
  return userRepo.createUser({
    username,
    passwordHash: hash,
    role: opts.role ?? "user",
    mustChangePassword: opts.mustChangePassword ?? false,
  });
}

/**
 * Issue a session token for an existing user. The returned cookie header
 * can be passed to subsequent ctx.app.request() calls.
 */
export function sessionCookieFor(userRepo: TestServer["userRepo"], userId: string): string {
  const session = userRepo.createSession(userId);
  // Match the production cookie attributes: HttpOnly; SameSite=Lax; Path=/.
  // Secure flag is omitted because tests do not run over HTTPS.
  return `aime_session=${session.token}; Path=/; HttpOnly; SameSite=Lax`;
}

/**
 * Convenience: seed a user, log in via the API and return the cookie
 * header value.
 */
export async function loginAndCookie(
  app: TestServer["app"],
  userRepo: TestServer["userRepo"],
  username: string,
  password: string,
  opts: { role?: "admin" | "user"; mustChangePassword?: boolean } = {}
): Promise<string> {
  // Seed if absent (idempotent across describe-scoped helper re-use).
  if (!userRepo.findByUsername(username)) {
    const hash = await hashPassword(password);
    userRepo.createUser({
      username,
      passwordHash: hash,
      role: opts.role ?? "user",
      mustChangePassword: opts.mustChangePassword ?? false,
    });
  }
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) {
    throw new Error(`login failed (${res.status}): ${await res.text()}`);
  }
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no Set-Cookie header from /api/auth/login");
  // Strip the Expires/SameSite/Secure attributes — fetch will accept the
  // raw cookie header as a Cookie request header.
  return setCookie.split(";")[0];
}