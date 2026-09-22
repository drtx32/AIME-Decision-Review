/**
 * Auth domain types shared by routes, repository and middleware.
 *
 * Passwords are never persisted in plaintext — only argon2id hashes stored
 * in users.passwordHash (algorithm pinned to argon2id via Bun.password).
 */

export type UserRole = "admin" | "user";

export interface UserRow {
  id: string;
  username: string;
  role: UserRole;
  passwordHash: string;
  mustChangePassword: 0 | 1;
  enabled: 0 | 1;
  createdAt: string;
  updatedAt: string;
}

export interface PublicUser {
  id: string;
  username: string;
  role: UserRole;
  mustChangePassword: boolean;
  enabled: boolean;
  createdAt: string;
}

export interface SessionRow {
  token: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
}

export interface AuthenticatedUserContext {
  user: PublicUser;
  session: SessionRow;
}

export const SESSION_COOKIE_NAME = "aime_session";
export const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8 hours