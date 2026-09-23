/**
 * Settings + usage persistence (SQLite).
 *
 * Tables (one connection, one DB file):
 *   user_model_settings   — per-user provider / model / baseUrl / encrypted apiKey
 *   usage_events          — append-only token-usage rows
 *   usage_periods         — optional configured allowance per user (null = unknown)
 *
 * Schema design notes:
 *   - `user_model_settings.apiKeyCiphertext` is AES-256-GCM ciphertext only;
 *     the plaintext is never persisted, never logged, and never returned
 *     over the wire.
 *   - `usage_periods.allowanceTokens` is NULL when the operator has not
 *     configured a quota. The usage endpoint translates that into
 *     `allowance.source = "unknown"` and `remaining.known = false` so the
 *     UI can render "Unknown" instead of a fabricated number.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { SettingsProvider } from "./types.ts";

export interface UserModelSettingsRow {
  userId: string;
  provider: SettingsProvider;
  model: string;
  baseUrl: string | null;
  apiKeyCiphertext: string | null;
  apiKeyFingerprint: string | null;
  updatedAt: string;
}

export interface UsageEventRow {
  id: string;
  userId: string;
  reviewId: string | null;
  kind: string;
  promptTokens: number;
  completionTokens: number;
  at: string;
}

export interface UsagePeriodRow {
  userId: string;
  periodStart: string;
  periodEnd: string;
  resetAt: string;
  allowanceTokens: number | null;
}

export class SettingsRepository {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.bootstrap();
  }

  private bootstrap() {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_model_settings (
        userId TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('openai-compatible', 'mock')),
        model TEXT NOT NULL,
        baseUrl TEXT,
        apiKeyCiphertext TEXT,
        apiKeyFingerprint TEXT,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        reviewId TEXT,
        kind TEXT NOT NULL,
        promptTokens INTEGER NOT NULL DEFAULT 0,
        completionTokens INTEGER NOT NULL DEFAULT 0,
        at TEXT NOT NULL,
        FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_usage_events_userId ON usage_events(userId);
      CREATE INDEX IF NOT EXISTS idx_usage_events_at ON usage_events(at);

      CREATE TABLE IF NOT EXISTS usage_periods (
        userId TEXT PRIMARY KEY,
        periodStart TEXT NOT NULL,
        periodEnd TEXT NOT NULL,
        resetAt TEXT NOT NULL,
        allowanceTokens INTEGER,
        FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
  }

  // ── user_model_settings ───────────────────────────────────────────────────

  getModelSettings(userId: string): UserModelSettingsRow | null {
    const row = this.db
      .prepare(
        `SELECT userId, provider, model, baseUrl, apiKeyCiphertext, apiKeyFingerprint, updatedAt
         FROM user_model_settings WHERE userId = ?`
      )
      .get(userId) as UserModelSettingsRow | undefined;
    return row ?? null;
  }

  /**
   * Upsert settings for the given user.
   *
   * `apiKeyCiphertext` and `apiKeyFingerprint` are written only when a
   * non-null `apiKeyCiphertext` is supplied; `undefined` preserves the
   * existing ciphertext (the Settings UI can rotate model/baseUrl without
   * forcing a re-entry of the key); `null` clears it.
   *
   * Returns the persisted row.
   */
  saveModelSettings(input: {
    userId: string;
    provider: SettingsProvider;
    model: string;
    baseUrl: string | null;
    apiKeyCiphertext?: string | null | undefined;
    apiKeyFingerprint?: string | null | undefined;
  }): UserModelSettingsRow {
    const now = new Date().toISOString();
    const existing = this.getModelSettings(input.userId);

    const nextCiphertext: string | null =
      input.apiKeyCiphertext === undefined
        ? (existing?.apiKeyCiphertext ?? null)
        : input.apiKeyCiphertext;
    const nextFingerprint: string | null =
      input.apiKeyCiphertext === undefined
        ? (existing?.apiKeyFingerprint ?? null)
        : (input.apiKeyFingerprint ?? null);

    this.db
      .prepare(
        `INSERT INTO user_model_settings (userId, provider, model, baseUrl, apiKeyCiphertext, apiKeyFingerprint, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(userId) DO UPDATE SET
           provider = excluded.provider,
           model = excluded.model,
           baseUrl = excluded.baseUrl,
           apiKeyCiphertext = excluded.apiKeyCiphertext,
           apiKeyFingerprint = excluded.apiKeyFingerprint,
           updatedAt = excluded.updatedAt`
      )
      .run(
        input.userId,
        input.provider,
        input.model,
        input.baseUrl,
        nextCiphertext,
        nextFingerprint,
        now
      );

    return this.getModelSettings(input.userId)!;
  }

  // ── usage_events ──────────────────────────────────────────────────────────

  recordUsage(event: {
    userId: string;
    reviewId?: string | null;
    kind: string;
    promptTokens: number;
    completionTokens: number;
    at?: string;
  }): UsageEventRow {
    const row: UsageEventRow = {
      id: `use_${randomUUID()}`,
      userId: event.userId,
      reviewId: event.reviewId ?? null,
      kind: event.kind,
      promptTokens: Math.max(0, Math.trunc(event.promptTokens)),
      completionTokens: Math.max(0, Math.trunc(event.completionTokens)),
      at: event.at ?? new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO usage_events (id, userId, reviewId, kind, promptTokens, completionTokens, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.userId,
        row.reviewId,
        row.kind,
        row.promptTokens,
        row.completionTokens,
        row.at
      );
    return row;
  }

  sumConsumedTokensSince(
    userId: string,
    sinceIso: string,
    beforeIso?: string
  ): {
    tokens: number;
    lastUpdatedAt: string | null;
  } {
    const sql = beforeIso
      ? `SELECT
           COALESCE(SUM(promptTokens + completionTokens), 0) AS tokens,
           MAX(at) AS lastUpdatedAt
         FROM usage_events
         WHERE userId = ? AND at >= ? AND at <= ?`
      : `SELECT
           COALESCE(SUM(promptTokens + completionTokens), 0) AS tokens,
           MAX(at) AS lastUpdatedAt
         FROM usage_events
         WHERE userId = ? AND at >= ?`;
    const row = (beforeIso
      ? this.db.prepare(sql).get(userId, sinceIso, beforeIso)
      : this.db.prepare(sql).get(userId, sinceIso)) as {
      tokens: number;
      lastUpdatedAt: string | null;
    };
    return {
      tokens: Number(row.tokens ?? 0),
      lastUpdatedAt: row.lastUpdatedAt ?? null,
    };
  }

  recentUsage(userId: string, limit = 20): UsageEventRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, userId, reviewId, kind, promptTokens, completionTokens, at
         FROM usage_events
         WHERE userId = ?
         ORDER BY at DESC
         LIMIT ?`
      )
      .all(userId, limit) as UsageEventRow[];
    return rows;
  }

  // ── usage_periods ─────────────────────────────────────────────────────────

  getUsagePeriod(userId: string): UsagePeriodRow | null {
    const row = this.db
      .prepare(
        `SELECT userId, periodStart, periodEnd, resetAt, allowanceTokens
         FROM usage_periods WHERE userId = ?`
      )
      .get(userId) as UsagePeriodRow | undefined;
    return row ?? null;
  }

  upsertUsagePeriod(input: {
    userId: string;
    periodStart: string;
    periodEnd: string;
    resetAt: string;
    allowanceTokens: number | null;
  }): UsagePeriodRow {
    this.db
      .prepare(
        `INSERT INTO usage_periods (userId, periodStart, periodEnd, resetAt, allowanceTokens)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(userId) DO UPDATE SET
           periodStart = excluded.periodStart,
           periodEnd = excluded.periodEnd,
           resetAt = excluded.resetAt,
           allowanceTokens = excluded.allowanceTokens`
      )
      .run(
        input.userId,
        input.periodStart,
        input.periodEnd,
        input.resetAt,
        input.allowanceTokens
      );
    return this.getUsagePeriod(input.userId)!;
  }

  close() {
    this.db.close();
  }
}
