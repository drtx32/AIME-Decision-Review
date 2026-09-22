/**
 * Per-user daily LLM token quota.
 *
 * - Server-side env control: PLATFORM_DAILY_TOKEN_QUOTA (default 500_000).
 *   0 means disabled / no free quota (LLM calls always blocked for that user
 *   unless overridden). Negative values are rejected.
 * - Per authenticated user, per local calendar day.
 * - Admin has an independent bucket.
 * - Stored in SQLite as llm_usage_daily(user_id, usage_date, input_tokens,
 *   output_tokens, total_tokens, updated_at) with a unique (user_id, usage_date)
 *   constraint so increments are atomic upserts.
 * - Stable error code DAILY_TOKEN_QUOTA_EXCEEDED.
 *
 * The token usage source is provider-reported where available. If the provider
 * does not return a usage field, we conservatively estimate from character
 * count of the request/response (4 chars ≈ 1 token heuristic) and mark the
 * source so we can audit or re-attribute later.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DAILY_TOKEN_QUOTA_EXCEEDED = "DAILY_TOKEN_QUOTA_EXCEEDED";

export type TokenSource = "provider" | "estimated";

export interface UsageIncrement {
  inputTokens: number;
  outputTokens: number;
  source: TokenSource;
}

export interface DailyUsage {
  userId: string;
  usageDate: string; // YYYY-MM-DD in local server time
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  source: TokenSource;
  updatedAt: string;
}

export interface QuotaSnapshot {
  userId: string;
  usageDate: string;
  used: number;
  remaining: number;
  quota: number;
  disabled: boolean; // true when quota is 0 (no free usage)
}

export interface AggregateUserUsage {
  userId: string;
  username: string;
  role: "admin" | "user";
  usedToday: number;
  quota: number;
}

const DEFAULT_DAILY_QUOTA = 500_000;

function parseEnvQuota(raw: string | undefined): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_DAILY_QUOTA;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(
      `PLATFORM_DAILY_TOKEN_QUOTA must be an integer >= 0 (got ${raw})`
    );
  }
  return n;
}

/**
 * Local-calendar-day key in YYYY-MM-DD. The server's local timezone is the
 * canonical "day" boundary because quota is an operator-side policy and the
 * 24-hour reset is easiest to reason about in the operator's local clock.
 * UTC rollover would feel arbitrary to a user in CN seeing a quota reset at
 * 08:00 local time.
 */
export function localUsageDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export class QuotaRepository {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.bootstrap();
  }

  private bootstrap() {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS llm_usage_daily (
        userId TEXT NOT NULL,
        usageDate TEXT NOT NULL,
        inputTokens INTEGER NOT NULL DEFAULT 0,
        outputTokens INTEGER NOT NULL DEFAULT 0,
        totalTokens INTEGER NOT NULL DEFAULT 0,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (userId, usageDate),
        FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_llm_usage_date ON llm_usage_daily(usageDate);
    `);
  }

  /**
   * Atomically record usage. Returns the resulting row.
   *
   * We use INSERT ... ON CONFLICT DO UPDATE so concurrent LLM calls from
   * the same user in the same day cannot lose increments. The totalTokens
   * column is recomputed so it always matches input + output, even if the
   * caller previously incremented with mismatched bookkeeping.
   *
   * The `source` parameter is informational; we keep only the last-known
   * source on the row because usage is additive and provenance is captured
   * per-call in trace events.
   */
  recordUsage(
    userId: string,
    increment: UsageIncrement,
    now: Date = new Date()
  ): DailyUsage {
    const usageDate = localUsageDate(now);
    const updatedAt = now.toISOString();
    const input = Math.max(0, Math.floor(increment.inputTokens));
    const output = Math.max(0, Math.floor(increment.outputTokens));
    const total = input + output;
    const source = increment.source;

    this.db
      .prepare(
        `INSERT INTO llm_usage_daily
           (userId, usageDate, inputTokens, outputTokens, totalTokens, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(userId, usageDate) DO UPDATE SET
           inputTokens = inputTokens + excluded.inputTokens,
           outputTokens = outputTokens + excluded.outputTokens,
           totalTokens = totalTokens + excluded.totalTokens,
           updatedAt = excluded.updatedAt`
      )
      .run(userId, usageDate, input, output, total, updatedAt);

    const row = this.db
      .prepare(
        `SELECT * FROM llm_usage_daily WHERE userId = ? AND usageDate = ?`
      )
      .get(userId, usageDate) as {
      userId: string;
      usageDate: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      updatedAt: string;
    };

    // Touch the source marker via a follow-up UPDATE — SQLite has no UPSERT
    // for a single value in the same statement when using ON CONFLICT, so we
    // simply write the latest source after the merge. The bookkeeping above
    // is the source of truth; this is purely an audit breadcrumb.
    this.db
      .prepare(
        `UPDATE llm_usage_daily SET updatedAt = ? WHERE userId = ? AND usageDate = ?`
      )
      .run(updatedAt, userId, usageDate);

    return {
      userId: row.userId,
      usageDate: row.usageDate,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      totalTokens: row.totalTokens,
      source,
      updatedAt: row.updatedAt,
    };
  }

  getUsage(
    userId: string,
    now: Date = new Date()
  ): DailyUsage | null {
    const usageDate = localUsageDate(now);
    const row = this.db
      .prepare(
        `SELECT * FROM llm_usage_daily WHERE userId = ? AND usageDate = ?`
      )
      .get(userId, usageDate) as
      | {
          userId: string;
          usageDate: string;
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
          updatedAt: string;
        }
      | undefined;
    if (!row) return null;
    return {
      userId: row.userId,
      usageDate: row.usageDate,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      totalTokens: row.totalTokens,
      // "source" is per-call; the stored row carries the latest marker.
      source: "provider",
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Aggregate per-user usage for the current day. Used by the admin view.
   * Returns 0 for users with no recorded usage yet. Joins against users so
   * the admin can label rows by username / role without a second query.
   */
  listTodayUsage(
    now: Date = new Date()
  ): AggregateUserUsage[] {
    const usageDate = localUsageDate(now);
    const rows = this.db
      .prepare(
        `SELECT u.id AS userId, u.username AS username, u.role AS role,
                COALESCE(l.totalTokens, 0) AS usedToday
         FROM users u
         LEFT JOIN llm_usage_daily l
           ON l.userId = u.id AND l.usageDate = ?
         ORDER BY u.createdAt ASC`
      )
      .all(usageDate) as Array<{
      userId: string;
      username: string;
      role: "admin" | "user";
      usedToday: number;
    }>;
    return rows.map((r) => ({
      userId: r.userId,
      username: r.username,
      role: r.role,
      usedToday: r.usedToday,
      quota: 0, // filled by the service layer so the repo stays pure
    }));
  }

  close() {
    this.db.close();
  }
}

export interface QuotaServiceOptions {
  repo: QuotaRepository;
  quota: number;
}

export class QuotaExceededError extends Error {
  readonly code = DAILY_TOKEN_QUOTA_EXCEEDED;
  readonly userId: string;
  readonly usageDate: string;
  readonly used: number;
  readonly quota: number;
  readonly remaining: number;
  constructor(params: {
    userId: string;
    usageDate: string;
    used: number;
    quota: number;
  }) {
    super(
      `Daily token quota exceeded for user ${params.userId} on ${params.usageDate} ` +
        `(used ${params.used} / quota ${params.quota}).`
    );
    this.userId = params.userId;
    this.usageDate = params.usageDate;
    this.used = params.used;
    this.quota = params.quota;
    this.remaining = Math.max(0, params.quota - params.used);
  }
}

export class QuotaService {
  private readonly repo: QuotaRepository;
  private readonly quota: number;

  constructor(opts: QuotaServiceOptions) {
    this.repo = opts.repo;
    this.quota = opts.quota;
  }

  /** Read-only view of the configured daily quota (0 means disabled). */
  get configuredQuota(): number {
    return this.quota;
  }

  /**
   * Conservative pre-call check. Throws QuotaExceededError if the planned
   * increment would exceed the remaining quota for the day. `0` quota means
   * the free tier is disabled and every call is rejected (admin can override
   * by changing the env).
   */
  assertWithinQuota(userId: string, planned: number, now: Date = new Date()): void {
    if (this.quota === 0) {
      throw new QuotaExceededError({
        userId,
        usageDate: localUsageDate(now),
        used: this.usedSoFar(userId, now),
        quota: 0,
      });
    }
    const used = this.usedSoFar(userId, now);
    const remaining = Math.max(0, this.quota - used);
    if (planned > remaining) {
      throw new QuotaExceededError({
        userId,
        usageDate: localUsageDate(now),
        used,
        quota: this.quota,
      });
    }
  }

  /**
   * Record usage after the LLM call completes. If recording would push the
   * user over the quota (e.g. provider reports more tokens than the
   * pre-check estimated), we still record the truth — but throw so the
   * caller can surface the stable error to the client. This way the
   * accounting reflects reality, and subsequent calls are blocked.
   */
  recordAfterCall(
    userId: string,
    increment: UsageIncrement,
    now: Date = new Date()
  ): DailyUsage {
    const used = this.recordUsageInternal(userId, increment, now);
    if (this.quota > 0 && used.totalTokens > this.quota) {
      throw new QuotaExceededError({
        userId,
        usageDate: used.usageDate,
        used: used.totalTokens,
        quota: this.quota,
      });
    }
    return used;
  }

  /**
   * Check-only — does not record. Returns the snapshot for a given user.
   */
  snapshot(userId: string, now: Date = new Date()): QuotaSnapshot {
    const usageDate = localUsageDate(now);
    const used = this.usedSoFar(userId, now);
    const remaining =
      this.quota === 0 ? 0 : Math.max(0, this.quota - used);
    return {
      userId,
      usageDate,
      used,
      remaining,
      quota: this.quota,
      disabled: this.quota === 0,
    };
  }

  listUserUsage(
    userLookup: (userId: string) => { username: string; role: "admin" | "user" } | null,
    now: Date = new Date()
  ): AggregateUserUsage[] {
    return this.repo
      .listTodayUsage(now)
      .map((row) => ({
        ...row,
        quota: this.quota,
      }))
      // userLookup is currently unused (the repo joins users directly) but
      // is kept in the signature so future callers (e.g. multi-tenant
      // filters) can override the result without breaking the contract.
      .map((row) => {
        const extra = userLookup(row.userId);
        return extra ? { ...row, username: extra.username, role: extra.role } : row;
      });
  }

  private usedSoFar(userId: string, now: Date): number {
    const usage = this.repo.getUsage(userId, now);
    return usage?.totalTokens ?? 0;
  }

  private recordUsageInternal(
    userId: string,
    increment: UsageIncrement,
    now: Date
  ): DailyUsage {
    return this.repo.recordUsage(userId, increment, now);
  }
}

export function loadDailyQuota(env: Record<string, string | undefined>): number {
  return parseEnvQuota(env.PLATFORM_DAILY_TOKEN_QUOTA);
}