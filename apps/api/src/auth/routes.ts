/**
 * Auth route handlers — login / logout / me / change-password.
 *
 * Login sets an HttpOnly cookie. The one-time temporary password for
 * newly-created or reset users is returned ONLY by the admin endpoints,
 * never logged.
 *
 * No public registration. No password reset by email — admin-mediated only.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { UserRepository } from "./repository.ts";
import { toPublicUser } from "./repository.ts";
import {
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  type AuthEnv,
} from "./middleware.ts";
import {
  verifyPassword,
  hashPassword,
  MIN_USER_PASSWORD_LENGTH,
} from "./passwords.ts";

const LoginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(512),
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: z.string().min(MIN_USER_PASSWORD_LENGTH).max(512),
});

export function buildAuthRoutes(repo: UserRepository, isProduction: boolean) {
  const app = new Hono<AuthEnv>();

  app.post("/login", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = LoginSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
    }
    const { username, password } = parsed.data;
    const user = repo.findByUsername(username);
    if (!user) {
      // Always hash to even out timing even on unknown usernames.
      await hashPassword("does-not-matter");
      return c.json({ error: "invalid_credentials" }, 401);
    }
    if (user.enabled !== 1) {
      return c.json({ error: "account_disabled" }, 403);
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      return c.json({ error: "invalid_credentials" }, 401);
    }
    const session = repo.createSession(user.id);
    setSessionCookie(c, session.token, session.expiresAt, isProduction);
    const pub = toPublicUser(user);
    return c.json({
      user: pub,
      mustChangePassword: pub.mustChangePassword,
    });
  });

  app.post("/logout", (c) => {
    const session = c.get("session");
    if (session) repo.deleteSession(session.token);
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  app.get("/me", requireAuth(repo), (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    return c.json({
      user,
      mustChangePassword: user.mustChangePassword,
    });
  });

  app.post("/change-password", requireAuth(repo), async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const body = await c.req.json().catch(() => null);
    const parsed = ChangePasswordSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
    }
    const row = repo.findById(user.id);
    if (!row) return c.json({ error: "not_found" }, 404);
    const ok = await verifyPassword(parsed.data.currentPassword, row.passwordHash);
    if (!ok) return c.json({ error: "invalid_current_password" }, 401);
    const newHash = await hashPassword(parsed.data.newPassword);
    repo.setPassword(row.id, newHash);
    // Invalidate other sessions to force re-auth on other devices.
    repo.deleteSessionsForUser(row.id);
    // Re-issue the current session.
    const session = repo.createSession(row.id);
    setSessionCookie(c, session.token, session.expiresAt, isProduction);
    return c.json({
      user: toPublicUser({
        ...row,
        passwordHash: newHash,
        mustChangePassword: 0,
        updatedAt: new Date().toISOString(),
      }),
      mustChangePassword: false,
    });
  });

  return app;
}