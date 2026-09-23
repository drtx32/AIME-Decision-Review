/**
 * AES-256-GCM secret encryption for user-supplied API keys.
 *
 * Contract:
 *   - Secrets are NEVER persisted in plaintext.
 *   - The encryption key comes from server env / GitHub Secrets.
 *     We never log the key, the plaintext, or the ciphertext.
 *   - The API exposes only `hasApiKey` + a short non-reversible
 *     `apiKeyFingerprint` to clients. The actual ciphertext is never
 *     returned over the wire.
 *
 * Key resolution (loadSecretKey):
 *   1. `AIME_SECRET_ENC_KEY` env var, base64-encoded 32 bytes.
 *   2. If absent, derive a key from `INITIAL_ADMIN_PASSWORD` via scrypt
 *      with a fixed, public salt. This is documented as a fallback so a
 *      fresh deployment that only has `INITIAL_ADMIN_PASSWORD` configured
 *      still encrypts at rest instead of falling back to plaintext.
 *
 * The key handle never leaves this module and is never logged. Tests can
 * inject a deterministic 32-byte key via the `AIME_SECRET_ENC_KEY` env
 * var so the encryption output is reproducible.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * Public, fixed salt used only for the documented scrypt fallback.
 * It is OK for this salt to be public — its sole purpose is to make the
 * fallback derivation deterministic and independent of `INITIAL_ADMIN_PASSWORD`
 * length. Without it the fallback would derive a different key from a
 * 16-char vs 32-char password; we want the *same* key from the same
 * password so deployments stay stable across reboots.
 */
const FALLBACK_SALT = Buffer.from("aime/decision-review/settings-fallback-salt/v1", "utf8");

let cachedKey: Buffer | null = null;

export interface SecretKeyHandle {
  /** Encrypt a UTF-8 plaintext. Returns base64(iv || ciphertext || tag). */
  encrypt(plaintext: string): string;
  /** Decrypt a previously-encrypted ciphertext. Returns null on auth failure. */
  decrypt(payload: string): string | null;
  /**
   * Short non-reversible fingerprint suitable for display. The first 8 hex
   * chars of SHA-256(ciphertext) — distinctive enough to tell two keys
   * apart at a glance, useless for offline cracking.
   */
  fingerprint(payload: string): string;
}

/**
 * Load the encryption key handle. Idempotent.
 *
 * Returns null only when neither `AIME_SECRET_ENC_KEY` nor
 * `INITIAL_ADMIN_PASSWORD` is configured. Callers MUST treat that as
 * "secret persistence is unavailable" and reject API-key write paths
 * rather than silently downgrading to plaintext.
 */
export function loadSecretKey(env: Record<string, string | undefined> = process.env): SecretKeyHandle | null {
  if (cachedKey) return handleFor(cachedKey);

  const raw = env.AIME_SECRET_ENC_KEY?.trim();
  if (raw) {
    let buf: Buffer;
    try {
      buf = Buffer.from(raw, "base64");
    } catch {
      return null;
    }
    if (buf.length !== KEY_LENGTH) return null;
    cachedKey = buf;
    return handleFor(cachedKey);
  }

  const fallback = env.INITIAL_ADMIN_PASSWORD;
  if (fallback && fallback.length > 0) {
    cachedKey = scryptSync(fallback, FALLBACK_SALT, KEY_LENGTH);
    return handleFor(cachedKey);
  }

  return null;
}

/** Test-only helper. Always re-derives from env; clears the in-process cache. */
export function _resetSecretKeyForTest() {
  cachedKey = null;
}

function handleFor(key: Buffer): SecretKeyHandle {
  return {
    encrypt(plaintext: string): string {
      if (typeof plaintext !== "string" || plaintext.length === 0) {
        throw new Error("plaintext must be a non-empty string");
      }
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      // base64(iv || ciphertext || tag) so the whole record is one string.
      return Buffer.concat([iv, ciphertext, tag]).toString("base64");
    },
    decrypt(payload: string): string | null {
      if (typeof payload !== "string" || payload.length === 0) return null;
      let raw: Buffer;
      try {
        raw = Buffer.from(payload, "base64");
      } catch {
        return null;
      }
      if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) return null;
      const iv = raw.subarray(0, IV_LENGTH);
      const tag = raw.subarray(raw.length - AUTH_TAG_LENGTH);
      const ciphertext = raw.subarray(IV_LENGTH, raw.length - AUTH_TAG_LENGTH);
      try {
        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return plaintext.toString("utf8");
      } catch {
        // Authentication failed — wrong key or tampered ciphertext.
        return null;
      }
    },
    fingerprint(payload: string): string {
      const h = createHash("sha256").update(payload, "utf8").digest("hex");
      return `${h.slice(0, 4)}…${h.slice(4, 8)}`;
    },
  };
}

/**
 * Stable, non-secret fingerprint of a plaintext value. Useful for tests
 * that want to assert "this plaintext produces this fingerprint" without
 * revealing the secret.
 */
export function plaintextFingerprint(plaintext: string): string {
  const h = createHash("sha256").update(plaintext, "utf8").digest("hex");
  return `${h.slice(0, 4)}…${h.slice(4, 8)}`;
}
