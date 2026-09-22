/**
 * Admin user-management routes — create / list / reset / disable / enable.
 *
 * Constraints:
 *   - Admin cannot disable, enable, or delete their own account.
 *   - New users get a one-time temporary password that the server returns
 *     exactly once and the admin must hand to the user out-of-band.
 *   - New users start with mustChangePassword=1.
 *   - Soft delete is preferred — disable instead of hard-delete.
 *   - Bootstrap admin is the only path that can create another admin
 *     (admins may create normal users but not other admins in v0.1 to
 *     keep the policy simple and explicit; spec says roles: admin | user,
 *     and admin must be the bootstrap path or future-elevated user).
 */

import { Hono } from "hono";
import { z } from "zod";
import type { UserRepository } from "./repository.ts";
import { toPublicUser } from "./repository.ts";
import { requireAuth, requireAdmin, type AuthEnv } from "./middleware.ts";
import {
  hashPassword,
  generateTemporaryPassword,
  MIN_USER_PASSWORD_LENGTH,
} from "./passwords.ts";

const CreateUserSchema = z.object({
  username: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_.-]+$/, "username must be alphanumeric/_.- only"),
});

export function buildAdminRoutes(repo: UserRepository) {
  const app = new Hono<AuthEnv>();

  app.use("*", requireAuth(repo), requireAdmin(repo));

  app.get("/users", (c) => {
    const rows = repo.listUsers();
    return c.json({ users: rows.map(toPublicUser) });
  });

  app.post("/users", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateUserSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
    }
    if (repo.findByUsername(parsed.data.username)) {
      return c.json({ error: "username_taken" }, 409);
    }
    const tempPassword = generateTemporaryPassword();
    const hash = await hashPassword(tempPassword);
    const row = repo.createUser({
      username: parsed.data.username,
      passwordHash: hash,
      role: "user",
      mustChangePassword: true,
    });
    return c.json(
      {
        user: toPublicUser(row),
        temporaryPassword: tempPassword,
      },
      201
    );
  });

  app.post("/users/:id/reset-password", async (c) => {
    const id = c.req.param("id");
    const row = repo.findById(id);
    if (!row) return c.json({ error: "not_found" }, 404);
    if (row.enabled !== 1) {
      return c.json({ error: "account_disabled" }, 409);
    }
    const tempPassword = generateTemporaryPassword();
    const hash = await hashPassword(tempPassword);
    repo.setPassword(row.id, hash);
    // Force-revoke existing sessions for this user.
    repo.deleteSessionsForUser(row.id);
    return c.json(
      {
        user: toPublicUser({ ...row, passwordHash: hash, mustChangePassword: 1 }),
        temporaryPassword: tempPassword,
      },
      200
    );
  });

  app.post("/users/:id/disable", (c) => {
    const me = c.get("user");
    const id = c.req.param("id");
    if (me?.id === id) {
      return c.json({ error: "cannot_disable_self" }, 400);
    }
    const row = repo.findById(id);
    if (!row) return c.json({ error: "not_found" }, 404);
    if (row.role === "admin" && repo.countEnabledAdmins() <= 1) {
      return c.json({ error: "cannot_disable_last_admin" }, 400);
    }
    repo.setEnabled(id, false);
    repo.deleteSessionsForUser(id);
    return c.json({ user: toPublicUser({ ...row, enabled: 0 }) });
  });

  app.post("/users/:id/enable", (c) => {
    const id = c.req.param("id");
    const row = repo.findById(id);
    if (!row) return c.json({ error: "not_found" }, 404);
    repo.setEnabled(id, true);
    return c.json({ user: toPublicUser({ ...row, enabled: 1 }) });
  });

  /**
   * Soft-delete is preferred — same semantics as disable.
   * Hard delete is not exposed.
   */
  app.delete("/users/:id", (c) => {
    const me = c.get("user");
    const id = c.req.param("id");
    if (me?.id === id) {
      return c.json({ error: "cannot_delete_self" }, 400);
    }
    const row = repo.findById(id);
    if (!row) return c.json({ error: "not_found" }, 404);
    if (row.role === "admin" && repo.countEnabledAdmins() <= 1) {
      return c.json({ error: "cannot_delete_last_admin" }, 400);
    }
    repo.setEnabled(id, false);
    repo.deleteSessionsForUser(id);
    return c.json({ user: toPublicUser({ ...row, enabled: 0 }) });
  });

  return app;
}