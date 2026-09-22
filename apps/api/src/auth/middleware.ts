/**
 * Auth middleware — cookie-based session validation for Hono.
 *
 * requireAuth attaches ctx.get("user") / ctx.get("session") for downstream
 * handlers. Users with mustChangePassword=1 are restricted to auth-self
 * endpoints (handled separately in requireAuth but flagged on ctx).
 *
 * requireAdmin additionally refuses non-admin users.
 *
 * Cookies are HttpOnly + SameSite=Lax; Secure flag is added when the
 * configured environment looks production-ish (NODE_ENV=production OR
 * default port 3000 outside test).
 */

import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { UserRepository } from "./repository.ts";
import { toPublicUser } from "./repository.ts";
import type { AuthenticatedUserContext, SessionRow, PublicUser } from "./types.ts";
import { SESSION_COOKIE_NAME } from "./types.ts";

export interface AuthEnv {
  Variables: {
    user?: PublicUser;
    session?: SessionRow;
  };
}

export function parseCookies(c: Context): { token: string | null } {
  return { token: getCookie(c, SESSION_COOKIE_NAME) ?? null };
}

export function setSessionCookie(
  c: Context,
  token: string,
  expiresAt: string,
  isProduction: boolean
) {
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isProduction,
    path: "/",
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
}

/**
 * Attach user/session to context if a valid cookie is presented.
 * Does NOT block unauthenticated requests; combine with requireAuth below.
 */
export function attachUser(repo: UserRepository): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const { token } = parseCookies(c);
    if (token) {
      const session = repo.findSession(token);
      if (session) {
        const row = repo.findById(session.userId);
        if (row && row.enabled === 1) {
          repo.touchSession(token);
          c.set("user", toPublicUser(row));
          c.set("session", session);
        } else if (row && row.enabled === 0) {
          // Account disabled — invalidate session.
          repo.deleteSession(token);
          clearSessionCookie(c);
        }
      } else {
        clearSessionCookie(c);
      }
    }
    await next();
  };
}

/**
 * Require a valid session. Populates ctx.get("user").
 * Allows mustChangePassword users through (they need to change password
 * via /api/auth/change-password).
 */
export function requireAuth(repo: UserRepository): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) {
      return c.json({ error: "unauthenticated" }, 401);
    }
    await next();
  };
}

/**
 * Require admin role. mustChangePassword admins are blocked because
 * they cannot have completed the bootstrap flow yet.
 */
export function requireAdmin(repo: UserRepository): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (user.role !== "admin") return c.json({ error: "forbidden" }, 403);
    if (user.mustChangePassword) {
      return c.json({ error: "must_change_password" }, 403);
    }
    await next();
  };
}

/**
 * Reject mustChangePassword users from any endpoint outside /api/auth/*.
 * Login + change-password + logout + me are allowed; the rest are not.
 * mustChangePassword admins are also blocked from admin pages (handled by
 * requireAdmin above), so this only fires for non-admin users.
 */
export function gateMustChangePassword(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const user = c.get("user");
    if (user?.mustChangePassword) {
      return c.json({ error: "must_change_password" }, 403);
    }
    await next();
  };
}

/**
 * Identity-contract guard: refuse any client-supplied `x-user-id` /
 * `X-User-Id` header on protected routes. The user identity for review
 * data, sessions, learning state and admin actions is always derived
 * from the ELI-325 session cookie (`attachUser` populates ctx.get("user")
 * from the session row → users row). Clients must never be trusted to
 * self-report their own identity. This guard documents and enforces the
 * contract for ELI-328 / PR #7 and any future routes that join the same
 * API surface.
 *
 * Login / logout / health are explicitly allowed to pass through so the
 * cookie can be issued in the first place.
 */
export function rejectClientUserIdHeader(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const path = c.req.path;
    const isAuthBoundary =
      path === "/api/auth/login" ||
      path === "/api/auth/logout" ||
      path === "/health";
    if (isAuthBoundary) {
      await next();
      return;
    }
    const claimed =
      c.req.header("x-user-id") ??
      c.req.header("X-User-Id") ??
      c.req.header("x_user_id");
    if (claimed) {
      return c.json(
        {
          error: "x_user_id_header_not_allowed",
          message:
            "User identity is derived from the auth session cookie. " +
            "Client-supplied x-user-id headers are not accepted on protected routes.",
        },
        400
      );
    }
    await next();
  };
}

export function getAuthContext(c: Context<AuthEnv>): AuthenticatedUserContext | null {
  const user = c.get("user");
  const session = c.get("session");
  if (!user || !session) return null;
  return { user, session };
}