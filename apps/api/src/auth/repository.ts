/**
 * User and session repository — owns the auth-related SQLite tables.
 *
 * Tables:
 *   users        — credentials and role flags
 *   sessions     — opaque server-issued session tokens
 *
 * Bootstrap: ensureBootstrapAdmin() creates the initial admin from env on
 * first startup and is idempotent (no-op if any admin already exists).
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  type UserRow,
  type PublicUser,
  type UserRole,
  type SessionRow,
  SESSION_TTL_MS,
} from "./types.ts";
import { generateSessionToken, hashPassword } from "./passwords.ts";

export interface BootstrapEnv {
  initialAdminUsername: string;
  initialAdminPassword: string;
}

export interface CreateUserInput {
  username: string;
  passwordHash: string;
  role: UserRole;
  mustChangePassword: boolean;
}

export interface StoredModelConfig {
  userId: string;
  provider: "openai-compatible";
  baseUrl: string;
  model: string;
  apiKeyEncrypted: string;
  verifiedAt: string | null;
  lastError: string | null;
}

export interface LlmUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model: string | null;
  provider: string | null;
}

export class UserRepository {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.bootstrap();
  }

  private bootstrap() {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        passwordHash TEXT NOT NULL,
        mustChangePassword INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        lastSeenAt TEXT NOT NULL,
        FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_userId ON sessions(userId);

      CREATE TABLE IF NOT EXISTS user_model_configs (
        userId TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        baseUrl TEXT NOT NULL,
        model TEXT NOT NULL,
        apiKeyEncrypted TEXT NOT NULL,
        verifiedAt TEXT,
        lastError TEXT,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS llm_usage (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        inputTokens INTEGER NOT NULL,
        outputTokens INTEGER NOT NULL,
        totalTokens INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_llm_usage_user_time ON llm_usage(userId, timestamp);
    `);
  }

  // ---------- users ----------

  findByUsername(username: string): UserRow | null {
    const row = this.db
      .prepare(`SELECT * FROM users WHERE username = ?`)
      .get(username) as UserRow | undefined;
    return row ?? null;
  }

  findById(id: string): UserRow | null {
    const row = this.db
      .prepare(`SELECT * FROM users WHERE id = ?`)
      .get(id) as UserRow | undefined;
    return row ?? null;
  }

  listUsers(): UserRow[] {
    return this.db
      .prepare(`SELECT * FROM users ORDER BY createdAt ASC`)
      .all() as UserRow[];
  }

  hasAnyAdmin(): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS x FROM users WHERE role = 'admin' LIMIT 1`)
      .get() as { x: number } | undefined;
    return Boolean(row);
  }

  createUser(input: CreateUserInput): UserRow {
    const now = new Date().toISOString();
    const row: UserRow = {
      id: `usr_${randomUUID()}`,
      username: input.username,
      role: input.role,
      passwordHash: input.passwordHash,
      mustChangePassword: input.mustChangePassword ? 1 : 0,
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO users (id, username, role, passwordHash, mustChangePassword, enabled, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.username,
        row.role,
        row.passwordHash,
        row.mustChangePassword,
        row.enabled,
        row.createdAt,
        row.updatedAt
      );
    return row;
  }

  /**
   * Self-service password change (e.g. /api/auth/change-password).
   * Always clears `mustChangePassword` because the user just supplied the
   * current password — the change is itself proof of possession.
   */
  setPassword(id: string, newHash: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE users SET passwordHash = ?, mustChangePassword = 0, updatedAt = ? WHERE id = ?`
      )
      .run(newHash, now, id);
  }

  /**
   * Admin-initiated password reset. Sets the new hash AND forces
   * `mustChangePassword = 1` so the user must change the temporary
   * password on first login. This is the contract that the bootstrap
   * admin flow and the reset endpoint both depend on — without it, a
   * reset user could log in with the temporary password and bypass the
   * required first-login password change.
   */
  resetPassword(id: string, newHash: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE users SET passwordHash = ?, mustChangePassword = 1, updatedAt = ? WHERE id = ?`
      )
      .run(newHash, now, id);
  }

  setEnabled(id: string, enabled: boolean): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE users SET enabled = ?, updatedAt = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, now, id);
  }

  countEnabledAdmins(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND enabled = 1`)
      .get() as { n: number };
    return row.n;
  }

  // ---------- sessions ----------

  createSession(userId: string): SessionRow {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const row: SessionRow = {
      token: generateSessionToken(),
      userId,
      createdAt: now,
      expiresAt,
      lastSeenAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO sessions (token, userId, createdAt, expiresAt, lastSeenAt)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(row.token, row.userId, row.createdAt, row.expiresAt, row.lastSeenAt);
    return row;
  }

  findSession(token: string): SessionRow | null {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE token = ?`)
      .get(token) as SessionRow | undefined;
    if (!row) return null;
    if (Date.parse(row.expiresAt) < Date.now()) {
      this.deleteSession(token);
      return null;
    }
    return row;
  }

  touchSession(token: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE sessions SET lastSeenAt = ? WHERE token = ?`)
      .run(now, token);
  }

  deleteSession(token: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
  }

  deleteSessionsForUser(userId: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE userId = ?`).run(userId);
  }

  getModelConfig(userId: string): StoredModelConfig | null {
    return (this.db.prepare(`SELECT userId, provider, baseUrl, model, apiKeyEncrypted, verifiedAt, lastError FROM user_model_configs WHERE userId=?`).get(userId) as StoredModelConfig | undefined) ?? null;
  }

  saveModelConfig(input: Omit<StoredModelConfig, "updatedAt">): void {
    this.db.prepare(`INSERT INTO user_model_configs (userId,provider,baseUrl,model,apiKeyEncrypted,verifiedAt,lastError,updatedAt) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(userId) DO UPDATE SET provider=excluded.provider,baseUrl=excluded.baseUrl,model=excluded.model,apiKeyEncrypted=excluded.apiKeyEncrypted,verifiedAt=excluded.verifiedAt,lastError=excluded.lastError,updatedAt=excluded.updatedAt`).run(input.userId,input.provider,input.baseUrl,input.model,input.apiKeyEncrypted,input.verifiedAt,input.lastError,new Date().toISOString());
  }

  clearModelConfig(userId: string): void { this.db.prepare(`DELETE FROM user_model_configs WHERE userId=?`).run(userId); }

  recordLlmUsage(userId: string, usage: { input: number; output: number; provider: string; model: string }): void {
    const input = Math.max(0, Math.floor(usage.input)); const output = Math.max(0, Math.floor(usage.output));
    this.db.prepare(`INSERT INTO llm_usage (id,userId,inputTokens,outputTokens,totalTokens,timestamp,provider,model) VALUES (?,?,?,?,?,?,?,?)`).run(`usage_${randomUUID()}`,userId,input,output,input+output,new Date().toISOString(),usage.provider,usage.model);
  }

  getLlmUsageSummary(userId: string, since: string): LlmUsageSummary {
    const row = this.db.prepare(`SELECT COALESCE(SUM(inputTokens),0) AS inputTokens, COALESCE(SUM(outputTokens),0) AS outputTokens, COALESCE(SUM(totalTokens),0) AS totalTokens, (SELECT model FROM llm_usage WHERE userId=? AND timestamp>=? ORDER BY timestamp DESC LIMIT 1) AS model, (SELECT provider FROM llm_usage WHERE userId=? AND timestamp>=? ORDER BY timestamp DESC LIMIT 1) AS provider FROM llm_usage WHERE userId=? AND timestamp>=?`).get(userId,since,userId,since,userId,since) as LlmUsageSummary;
    return row;
  }

  // ---------- bootstrap ----------

  /**
   * Idempotent: create the initial admin only if no admin exists. Never
   * touches an existing admin. The bootstrap admin is created with
   * mustChangePassword=1 so the public default password cannot linger.
   *
   * Throws if INITIAL_ADMIN_USERNAME/PASSWORD are missing on a fresh DB —
   * the env defaults in config.ts guarantee they are present, but we still
   * defend against an empty/short password.
   */
  async ensureBootstrapAdmin(env: BootstrapEnv): Promise<
    { created: true; user: UserRow } | { created: false }
  > {
    if (this.hasAnyAdmin()) {
      return { created: false };
    }
    const username = env.initialAdminUsername.trim();
    const password = env.initialAdminPassword;
    if (!username) throw new Error("INITIAL_ADMIN_USERNAME must not be empty");
    if (!password) throw new Error("INITIAL_ADMIN_PASSWORD must not be empty");
    const passwordHash = await hashPassword(password);
    const user = this.createUser({
      username,
      passwordHash,
      role: "admin",
      mustChangePassword: true,
    });
    return { created: true, user };
  }

  close() {
    this.db.close();
  }
}

// ---------- mapping ----------

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    mustChangePassword: row.mustChangePassword === 1,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
  };
}
