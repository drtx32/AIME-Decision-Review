/**
 * Password hashing + random secret generation backed by Bun.password and
 * node:crypto. We intentionally do not expose any secret value through
 * logging or trace events.
 */

import { randomBytes } from "node:crypto";

/**
 * Hash a plaintext password with argon2id (Bun default algorithm).
 * Never log or persist the plaintext.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  if (!plaintext || plaintext.length < 1) {
    throw new Error("password must be non-empty");
  }
  return Bun.password.hash(plaintext, { algorithm: "argon2id" });
}

/**
 * Constant-time verification of a plaintext password against a stored hash.
 */
export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  if (!plaintext || !hash) return false;
  try {
    return await Bun.password.verify(plaintext, hash);
  } catch {
    return false;
  }
}

/**
 * Cryptographically-random temporary password for newly-created or reset users.
 * Returns 16 base64url chars ≈ 96 bits of entropy — safe to display once.
 */
export function generateTemporaryPassword(): string {
  return randomBytes(12).toString("base64url");
}

/**
 * Session token: 32 bytes base64url ≈ 192 bits of entropy.
 */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Minimum password length accepted for self-service change. Bootstrap and
 * admin-temporary passwords are exempt — they are randomly generated.
 */
export const MIN_USER_PASSWORD_LENGTH = 8;