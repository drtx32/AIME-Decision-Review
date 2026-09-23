/**
 * Settings + usage persistence (SQLite).
 *
 * Tables (one connection, one DB file):
 *   usage_events   — append-only token-usage rows
 *   usage_periods  — optional configured allowance per user (null = unknown)
 *
 * ELI-360 — per-user BYOK persistence has been removed from the trust
 * boundary. A legacy `user_model_settings` table may still exist on
 * upgraded databases from before this change; the bootstrap migration
 * renames it to `legacy_user_model_settings` and zeroes the
 * apiKeyCiphertext / apiKeyFingerprint columns so no key material —
 * ciphertext or fingerprint — persists server-side. The
 * `UserModelSettingsRow` shape, `getModelSettings`, `saveModelSettings`,
 * and the /api/settings/model surface that consumed them are GONE.
 * Server-managed LLM provider config (LLM_PROVIDER / LLM_MODEL /
 * LLM_BASE_URL / LLM_API_KEY) lives only in process env and never
 * crosses the SQLite boundary.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

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
    // ELI-360 — defensive migration: if a legacy per-user BYOK table is
    // present from a previous build, rename it out of the way AND wipe
    // any apiKeyCiphertext / apiKeyFingerprint columns. We never want
    // server-side ciphertext (or a fingerprint that lets an operator
    // correlate accounts) to outlive the trust-boundary change. The
    // renamed table is preserved (renamed, not dropped) so an operator
    // who needs to audit a historical DB still has the row shape, minus
    // any secret material.
    const legacy = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='user_model_settings'"
      )
      .get();
    if (legacy) {
      const scrubbedAt = new Date().toISOString();
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS legacy_user_model_settings (
            userId TEXT PRIMARY KEY,
            provider TEXT,
            model TEXT,
            baseUrl TEXT,
            apiKeyCiphertext TEXT,
            apiKeyFingerprint TEXT,
            updatedAt TEXT,
            scrubbedAt TEXT NOT NULL,
            FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
          );
        `);
        this.db
          .prepare(
            `INSERT OR IGNORE INTO legacy_user_model_settings
               (userId, provider, model, baseUrl, apiKeyCiphertext, apiKeyFingerprint, updatedAt, scrubbedAt)
             SELECT userId, provider, model, '' AS baseUrl,
                    '' AS apiKeyCiphertext, '' AS apiKeyFingerprint,
                    updatedAt, ? AS scrubbedAt
             FROM user_model_settings`
          )
          .run(scrubbedAt);
        this.db.exec("DROP TABLE user_model_settings");
      })();
    }
    this.db.exec(`
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

  /**
   * Operator-configured per-user quota window. `allowanceTokens = null`
   * means "no operator-supplied quota" — the usage endpoint surfaces that
   * as `allowance.source = "unknown"` so the UI can render "Unknown"
   * instead of a fabricated number.
   *
   * Persisted purely from server-operator intent (today: legacy
   * /api/settings/model period migration path is gone — see ELI-360).
   * Kept on the table for backwards-compatible migrations from prior
   * builds; new code paths should treat this as read-only telemetry.
   */
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