/**
 * SQLite persistence via bun:sqlite.
 *
 * Tables:
 *   review_runs       — run-level state
 *   decisions         — the decision input
 *   evidence          — every evidence item (with relationToDecision)
 *   review_results    — the final structured result
 *   lessons           — flat lesson rows (separate from result JSON for queryability)
 *   events            — product-level trace events (no chain-of-thought)
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  DecisionInput,
  DecisionReviewResult,
  Evidence,
  ReviewStatus,
  TraceEvent,
} from "../types/index.ts";

export interface ReviewRunRow {
  id: string;
  status: ReviewStatus;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
}

export interface SessionDecisionRow {
  id: string;
  sessionId: string;
  userId: string;
  symbol: string;
  market: string;
  action: "buy" | "sell";
  executedAt: string | null;
  name: string | null;
  executedAtText: string;
  timePrecision: "exact" | "approximate" | "unknown";
  price: number | null;
  quantity: number | null;
  quantityShares: number | null;
  quantityText: string | null;
  confidence: number;
  needsConfirmation: string[];
  reason: string;
  notes: string;
  reviewId: string | null;
  confirmed: boolean;
}

export interface SessionMessageRow {
  id: string;
  sessionId: string;
  userId: string;
  role: "user" | "assistant" | "status";
  content: string;
  createdAt: string;
  state?: "accepted" | "extracting" | "needs_input" | "failed" | "completed" | "cancelled";
  errorMessage?: string | null;
  deletedAt?: string | null;
}

export interface LearningMemoryRow {
  id: string;
  userId: string;
  text: string;
  kind: "pattern" | "lesson" | "preference";
  sourceSessionId: string;
  sourceDecisionId: string | null;
  strength: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export class ReviewRepository {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.bootstrap();
  }

  private bootstrap() {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS review_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        finishedAt TEXT,
        errorMessage TEXT
      );

      CREATE TABLE IF NOT EXISTS decisions (
        reviewId TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        action TEXT NOT NULL,
        executedAt TEXT NOT NULL,
        T0 TEXT NOT NULL,
        price REAL,
        quantity REAL,
        userReason TEXT,
        notes TEXT,
        market TEXT,
        payload TEXT NOT NULL,
        FOREIGN KEY(reviewId) REFERENCES review_runs(id)
      );

      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        reviewId TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        sourceUrl TEXT,
        publishedAt TEXT NOT NULL,
        retrievedAt TEXT NOT NULL,
        relationToDecision TEXT NOT NULL,
        confidence REAL,
        metadata TEXT,
        FOREIGN KEY(reviewId) REFERENCES review_runs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_evidence_reviewId ON evidence(reviewId);
      CREATE INDEX IF NOT EXISTS idx_evidence_relation ON evidence(relationToDecision);

      CREATE TABLE IF NOT EXISTS review_results (
        reviewId TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        FOREIGN KEY(reviewId) REFERENCES review_runs(id)
      );

      CREATE TABLE IF NOT EXISTS lessons (
        reviewId TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (reviewId, ordinal),
        FOREIGN KEY(reviewId) REFERENCES review_runs(id)
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        reviewId TEXT NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        at TEXT NOT NULL,
        metadata TEXT,
        FOREIGN KEY(reviewId) REFERENCES review_runs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_events_reviewId ON events(reviewId);

      CREATE TABLE IF NOT EXISTS review_sessions (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        title TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'single',
        status TEXT NOT NULL DEFAULT 'draft',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_review_sessions_user ON review_sessions(userId, updatedAt DESC);

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        userId TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'accepted',
        errorMessage TEXT,
        deletedAt TEXT,
        FOREIGN KEY(sessionId) REFERENCES review_sessions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_messages_session ON conversation_messages(sessionId, createdAt);

      CREATE TABLE IF NOT EXISTS session_decisions (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        userId TEXT NOT NULL,
        symbol TEXT NOT NULL,
        market TEXT NOT NULL,
        action TEXT NOT NULL,
        executedAt TEXT,
        name TEXT,
        executedAtText TEXT NOT NULL DEFAULT '',
        timePrecision TEXT NOT NULL DEFAULT 'unknown',
        price REAL,
        quantity REAL,
        quantityShares REAL,
        quantityText TEXT,
        confidence REAL NOT NULL DEFAULT 0,
        needsConfirmation TEXT NOT NULL DEFAULT '[]',
        reason TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        reviewId TEXT,
        confirmed INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(sessionId) REFERENCES review_sessions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_session_decisions_user ON session_decisions(userId, sessionId);

      CREATE TABLE IF NOT EXISTS learning_memories (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        text TEXT NOT NULL,
        kind TEXT NOT NULL,
        sourceSessionId TEXT NOT NULL,
        sourceDecisionId TEXT,
        strength INTEGER NOT NULL DEFAULT 1,
        active INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_learning_memories_user ON learning_memories(userId, active, updatedAt DESC);
    `);
    // Safe migration for databases created before sessions were introduced.
    for (const statement of [
      "ALTER TABLE review_runs ADD COLUMN sessionId TEXT",
      "ALTER TABLE review_runs ADD COLUMN userId TEXT",
    ]) {
      try { this.db.exec(statement); } catch { /* column already exists */ }
    }
    for (const statement of [
      "ALTER TABLE session_decisions ADD COLUMN name TEXT",
      "ALTER TABLE session_decisions ADD COLUMN executedAtText TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE session_decisions ADD COLUMN timePrecision TEXT NOT NULL DEFAULT 'unknown'",
      "ALTER TABLE session_decisions ADD COLUMN quantityShares REAL",
      "ALTER TABLE session_decisions ADD COLUMN quantityText TEXT",
      "ALTER TABLE session_decisions ADD COLUMN confidence REAL NOT NULL DEFAULT 0",
      "ALTER TABLE session_decisions ADD COLUMN needsConfirmation TEXT NOT NULL DEFAULT '[]'",
    ]) { try { this.db.exec(statement); } catch { /* column already exists */ } }
    for (const statement of [
      "ALTER TABLE conversation_messages ADD COLUMN state TEXT NOT NULL DEFAULT 'accepted'",
      "ALTER TABLE conversation_messages ADD COLUMN errorMessage TEXT",
      "ALTER TABLE conversation_messages ADD COLUMN deletedAt TEXT",
    ]) { try { this.db.exec(statement); } catch { /* column already exists */ } }
    // ELI-358 — conversation library: archive, soft delete, manual rename lock.
    for (const statement of [
      "ALTER TABLE review_sessions ADD COLUMN archivedAt TEXT",
      "ALTER TABLE review_sessions ADD COLUMN deletedAt TEXT",
      "ALTER TABLE review_sessions ADD COLUMN manualTitle INTEGER NOT NULL DEFAULT 0",
    ]) { try { this.db.exec(statement); } catch { /* column already exists */ } }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_review_sessions_archived ON review_sessions(userId, archivedAt, updatedAt DESC)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_review_sessions_deleted ON review_sessions(userId, deletedAt)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_conversation_messages_content ON conversation_messages(sessionId, userId)`);
  }

  /**
   * ELI-358 — deterministic title derivation.
   *
   * - 0 decisions: empty string (caller decides whether to fall back to a
   *   generic placeholder).
   * - 1 decision: "{symbol} 决策复盘".
   * - 2+: "{symbol1} / {symbol2} 复盘" using the first two unique non-empty
   *   symbols (or decision names when present).
   *
   * Pure function — easy to unit test and to recompute when a session is
   * re-extracted.
   */
  static deriveSessionTitle(decisions: Array<{ symbol: string; name?: string | null }>): string {
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const d of decisions) {
      const raw = (d.name?.trim() || d.symbol?.trim() || "").trim();
      if (!raw || seen.has(raw)) continue;
      seen.add(raw);
      unique.push(raw);
      if (unique.length >= 2) break;
    }
    if (!unique.length) return "";
    if (unique.length === 1) return `${unique[0]} 决策复盘`;
    return `${unique[0]} / ${unique[1]} 复盘`;
  }

  createRun(id: string, decision: DecisionInput, T0: string, sessionId?: string, userId?: string): ReviewRunRow {
    const now = new Date().toISOString();
    const row: ReviewRunRow = {
      id,
      status: "created",
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      errorMessage: null,
    };
    this.db
      .prepare(
        `INSERT INTO review_runs (id, status, createdAt, updatedAt, finishedAt, errorMessage, sessionId, userId)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`
      )
      .run(row.id, row.status, row.createdAt, row.updatedAt, sessionId ?? null, userId ?? null);

    this.db
      .prepare(
        `INSERT INTO decisions (reviewId, symbol, action, executedAt, T0, price, quantity, userReason, notes, market, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        decision.symbol,
        decision.action,
        decision.executedAt,
        T0,
        decision.price ?? null,
        decision.quantity ?? null,
        decision.userReason ?? null,
        decision.notes ?? null,
        decision.market ?? null,
        JSON.stringify(decision)
      );
    return row;
  }

  updateStatus(
    id: string,
    status: ReviewStatus,
    extra: { errorMessage?: string; finishedAt?: string } = {}
  ): void {
    const now = new Date().toISOString();
    const finishedAt = extra.finishedAt ?? null;
    this.db
      .prepare(
        `UPDATE review_runs
         SET status = ?, updatedAt = ?, finishedAt = COALESCE(?, finishedAt), errorMessage = COALESCE(?, errorMessage)
         WHERE id = ?`
      )
      .run(status, now, finishedAt, extra.errorMessage ?? null, id);
  }

  getRun(id: string): ReviewRunRow | null {
    const row = this.db
      .prepare(`SELECT * FROM review_runs WHERE id = ?`)
      .get(id) as ReviewRunRow | undefined;
    return row ?? null;
  }

  getDecision(id: string): { decision: DecisionInput; T0: string } | null {
    const row = this.db
      .prepare(`SELECT payload, T0 FROM decisions WHERE reviewId = ?`)
      .get(id) as { payload: string; T0: string } | undefined;
    if (!row) return null;
    return { decision: JSON.parse(row.payload) as DecisionInput, T0: row.T0 };
  }

  insertEvidence(reviewId: string, items: Evidence[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO evidence
       (id, reviewId, type, title, content, source, sourceUrl, publishedAt, retrievedAt, relationToDecision, confidence, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const e of items) {
      stmt.run(
        e.id,
        reviewId,
        e.type,
        e.title,
        e.content,
        e.source,
        e.sourceUrl ?? null,
        e.publishedAt,
        e.retrievedAt,
        e.relationToDecision,
        e.confidence ?? null,
        e.metadata ? JSON.stringify(e.metadata) : null
      );
    }
  }

  getEvidence(reviewId: string): Evidence[] {
    const rows = this.db
      .prepare(
        `SELECT id, type, title, content, source, sourceUrl, publishedAt, retrievedAt, relationToDecision, confidence, metadata
         FROM evidence WHERE reviewId = ?`
      )
      .all(reviewId) as Array<{
      id: string;
      type: Evidence["type"];
      title: string;
      content: string;
      source: string;
      sourceUrl: string | null;
      publishedAt: string;
      retrievedAt: string;
      relationToDecision: Evidence["relationToDecision"];
      confidence: number | null;
      metadata: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      content: r.content,
      source: r.source,
      sourceUrl: r.sourceUrl ?? undefined,
      publishedAt: r.publishedAt,
      retrievedAt: r.retrievedAt,
      relationToDecision: r.relationToDecision,
      confidence: r.confidence ?? undefined,
      metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : undefined,
    }));
  }

  saveResult(reviewId: string, result: DecisionReviewResult): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO review_results (reviewId, payload, createdAt)
         VALUES (?, ?, ?)`
      )
      .run(reviewId, JSON.stringify(result), now);

    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO lessons (reviewId, ordinal, text) VALUES (?, ?, ?)`
    );
    result.lessons.forEach((text, ordinal) => {
      stmt.run(reviewId, ordinal, text);
    });
  }

  getResult(reviewId: string): DecisionReviewResult | null {
    const row = this.db
      .prepare(`SELECT payload FROM review_results WHERE reviewId = ?`)
      .get(reviewId) as { payload: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.payload) as DecisionReviewResult;
  }

  insertEvent(event: TraceEvent): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO events (id, reviewId, kind, message, at, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.id,
        event.reviewId,
        event.kind,
        event.message,
        event.at,
        event.metadata ? JSON.stringify(event.metadata) : null
      );
  }

  getEvents(reviewId: string): TraceEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, reviewId, kind, message, at, metadata
         FROM events WHERE reviewId = ? ORDER BY at ASC`
      )
      .all(reviewId) as Array<{
      id: string;
      reviewId: string;
      kind: TraceEvent["kind"];
      message: string;
      at: string;
      metadata: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      reviewId: r.reviewId,
      kind: r.kind,
      message: r.message,
      at: r.at,
      metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : undefined,
    }));
  }

  close() {
    this.db.close();
  }

  createSession(userId: string, title: string, scope: string): string {
    const id = `ses_${randomUUID()}`;
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO review_sessions (id,userId,title,scope,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)`)
      .run(id, userId, title, scope, "draft", now, now);
    return id;
  }

  updateSession(id: string, userId: string, status: string): void {
    this.db.prepare(`UPDATE review_sessions SET status=?, updatedAt=? WHERE id=? AND userId=?`)
      .run(status, new Date().toISOString(), id, userId);
  }

  addMessage(sessionId: string, userId: string, role: SessionMessageRow["role"], content: string, state: SessionMessageRow["state"] = "accepted", errorMessage: string | null = null): SessionMessageRow {
    const row = { id: `msg_${randomUUID()}`, sessionId, userId, role, content, state, errorMessage, createdAt: new Date().toISOString() };
    this.db.prepare(`INSERT INTO conversation_messages (id,sessionId,userId,role,content,createdAt,state,errorMessage) VALUES (?,?,?,?,?,?,?,?)`)
      .run(row.id, row.sessionId, row.userId, row.role, row.content, row.createdAt, row.state, row.errorMessage);
    this.db.prepare(`UPDATE review_sessions SET updatedAt=? WHERE id=? AND userId=?`).run(row.createdAt, sessionId, userId);
    return row;
  }

  addSessionDecision(input: Omit<SessionDecisionRow, "id" | "reviewId" | "confirmed">): SessionDecisionRow {
    const row: SessionDecisionRow = { ...input, id: `dec_${randomUUID()}`, reviewId: null, confirmed: false };
    this.db.prepare(`INSERT INTO session_decisions (id,sessionId,userId,symbol,name,market,action,executedAt,executedAtText,timePrecision,price,quantity,quantityShares,quantityText,confidence,needsConfirmation,reason,notes,reviewId,confirmed) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id,row.sessionId,row.userId,row.symbol,row.name,row.market,row.action,row.executedAt ?? "",row.executedAtText,row.timePrecision,row.price,row.quantity,row.quantityShares,row.quantityText,row.confidence,JSON.stringify(row.needsConfirmation),row.reason,row.notes,null,0);
    return row;
  }

  listSessions(userId: string) { return this.db.prepare(`SELECT * FROM review_sessions WHERE userId=? AND deletedAt IS NULL ORDER BY updatedAt DESC`).all(userId) as Array<Record<string, unknown>>; }
  getSession(id: string, userId: string) { return this.db.prepare(`SELECT * FROM review_sessions WHERE id=? AND userId=? AND deletedAt IS NULL`).get(id,userId) as Record<string, unknown> | null; }

  /**
   * ELI-358 — list sessions with optional archive filter and content search.
   *
   * The search matches across session title, decision symbols/names/reasons,
   * and non-deleted message bodies. Results are user-scoped and ordered by
   * recency. The `archived` flag strictly scopes the result set so the
   * sidebar's Active / Archived filter chips are truly isolated:
   *   - `true` → only sessions with `archivedAt IS NOT NULL`
   *   - `false` or omitted → only sessions with `archivedAt IS NULL`
   * Soft-deleted sessions are excluded from both scopes. The two scopes
   * must return disjoint ID sets; searching archived must never leak rows
   * into the active view and vice versa.
   */
  listSessionsForUser(
    userId: string,
    options: { archived?: boolean; query?: string } = {}
  ): Array<Record<string, unknown>> {
    const archivedScope = options.archived === true;
    const query = options.query?.trim();
    const scopeFilter = archivedScope
      ? "AND archivedAt IS NOT NULL"
      : "AND archivedAt IS NULL";
    if (!query) {
      return this.db
        .prepare(
          `SELECT * FROM review_sessions WHERE userId=? AND deletedAt IS NULL ${scopeFilter} ORDER BY updatedAt DESC`
        )
        .all(userId) as Array<Record<string, unknown>>;
    }
    const like = `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    // Bounded LIKE — matches title, decision symbols/names/reasons, and
    // non-deleted message bodies in one round trip. Always pinned to the
    // selected archive scope so search never leaks across tabs.
    const sql = `SELECT DISTINCT s.* FROM review_sessions s
         WHERE s.userId=? AND s.deletedAt IS NULL ${scopeFilter}
           AND (s.title LIKE ? ESCAPE '\\'
                OR EXISTS (SELECT 1 FROM session_decisions d
                           WHERE d.sessionId = s.id AND d.userId = s.userId
                             AND (d.symbol LIKE ? ESCAPE '\\' OR d.name LIKE ? ESCAPE '\\' OR d.reason LIKE ? ESCAPE '\\'))
                OR EXISTS (SELECT 1 FROM conversation_messages m
                           WHERE m.sessionId = s.id AND m.userId = s.userId
                             AND m.deletedAt IS NULL AND m.content LIKE ? ESCAPE '\\'))
         ORDER BY s.updatedAt DESC`;
    return this.db
      .prepare(sql)
      .all(userId, like, like, like, like, like) as Array<Record<string, unknown>>;
  }

  /**
   * ELI-358 — apply deterministic auto-title to a freshly-extracted session
   * unless the user has manually renamed it. Returns true when the title
   * was actually written.
   */
  applyAutoTitle(id: string, userId: string, decisions: Array<{ symbol: string; name?: string | null }>): boolean {
    const session = this.getSession(id, userId);
    if (!session) return false;
    if (session.manualTitle === 1 || session.manualTitle === true) return false;
    const title = ReviewRepository.deriveSessionTitle(decisions);
    if (!title) return false;
    // Don't overwrite if the title is already meaningful (not the placeholder).
    const current = String(session.title || "");
    if (current && current !== "新建复盘" && current !== title) return false;
    this.db.prepare(`UPDATE review_sessions SET title=?, updatedAt=? WHERE id=? AND userId=?`).run(title, new Date().toISOString(), id, userId);
    return true;
  }

  renameSession(id: string, userId: string, title: string): Record<string, unknown> | null {
    const trimmed = title.trim();
    if (!trimmed) return null;
    if (trimmed.length > 80) return null;
    const session = this.getSession(id, userId);
    if (!session) return null;
    this.db.prepare(`UPDATE review_sessions SET title=?, manualTitle=1, updatedAt=? WHERE id=? AND userId=?`).run(trimmed, new Date().toISOString(), id, userId);
    return this.getSession(id, userId);
  }

  setSessionArchived(id: string, userId: string, archived: boolean): Record<string, unknown> | null {
    const session = this.getSession(id, userId);
    if (!session) return null;
    if (archived) {
      this.db.prepare(`UPDATE review_sessions SET archivedAt=?, updatedAt=? WHERE id=? AND userId=?`).run(new Date().toISOString(), new Date().toISOString(), id, userId);
    } else {
      this.db.prepare(`UPDATE review_sessions SET archivedAt=NULL, updatedAt=? WHERE id=? AND userId=?`).run(new Date().toISOString(), id, userId);
    }
    return this.getSession(id, userId);
  }

  /**
   * Soft-delete a session and its dependent rows. The conversation, attached
   * reviews, lessons, evidence and decisions are also marked/removed so the
   * session disappears from the Recent Reviews list and from search but
   * remains recoverable for support / audit if needed. Lessons are detached
   * (kept active in the user memory store) because they are reusable
   * learning, not session-bound state.
   */
  softDeleteSession(id: string, userId: string): boolean {
    const session = this.getSession(id, userId);
    if (!session) return false;
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE review_sessions SET deletedAt=?, title=?, archivedAt=NULL, updatedAt=? WHERE id=? AND userId=?`).run(now, "[deleted]", now, id, userId);
      this.db.prepare(`UPDATE conversation_messages SET deletedAt=COALESCE(deletedAt, ?) WHERE sessionId=? AND userId=?`).run(now, id, userId);
    });
    tx();
    return true;
  }
  listMessages(sessionId: string, userId: string) { return this.db.prepare(`SELECT * FROM conversation_messages WHERE sessionId=? AND userId=? AND deletedAt IS NULL ORDER BY createdAt ASC`).all(sessionId,userId) as SessionMessageRow[]; }
  updateMessageState(id: string, sessionId: string, userId: string, state: NonNullable<SessionMessageRow["state"]>, errorMessage: string | null = null): void {
    this.db.prepare(`UPDATE conversation_messages SET state=?, errorMessage=? WHERE id=? AND sessionId=? AND userId=? AND deletedAt IS NULL`).run(state, errorMessage, id, sessionId, userId);
  }
  updateMessageAndInvalidate(id: string, sessionId: string, userId: string, content: string): SessionMessageRow | null {
    const row = this.db.prepare(`SELECT * FROM conversation_messages WHERE id=? AND sessionId=? AND userId=? AND deletedAt IS NULL`).get(id, sessionId, userId) as SessionMessageRow | null;
    if (!row || row.role !== "user") return null;
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE conversation_messages SET content=?, state='extracting', errorMessage=NULL WHERE id=? AND sessionId=? AND userId=?`).run(content, id, sessionId, userId);
    this.db.prepare(`UPDATE conversation_messages SET deletedAt=? WHERE sessionId=? AND userId=? AND createdAt>? AND deletedAt IS NULL`).run(now, sessionId, userId, row.createdAt);
    this.db.prepare(`DELETE FROM session_decisions WHERE sessionId=? AND userId=?`).run(sessionId, userId);
    this.db.prepare(`UPDATE review_sessions SET status='draft', updatedAt=? WHERE id=? AND userId=?`).run(now, sessionId, userId);
    return { ...row, content };
  }
  softDeleteMessageAndInvalidate(id: string, sessionId: string, userId: string): boolean {
    const row = this.db.prepare(`SELECT * FROM conversation_messages WHERE id=? AND sessionId=? AND userId=? AND deletedAt IS NULL`).get(id, sessionId, userId) as SessionMessageRow | null;
    if (!row) return false;
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE conversation_messages SET deletedAt=? WHERE id=? AND sessionId=? AND userId=?`).run(now, id, sessionId, userId);
    if (row.role === "user") {
      this.db.prepare(`UPDATE conversation_messages SET deletedAt=? WHERE sessionId=? AND userId=? AND createdAt>? AND deletedAt IS NULL`).run(now, sessionId, userId, row.createdAt);
      this.db.prepare(`DELETE FROM session_decisions WHERE sessionId=? AND userId=?`).run(sessionId, userId);
      this.db.prepare(`UPDATE review_sessions SET status='draft', updatedAt=? WHERE id=? AND userId=?`).run(now, sessionId, userId);
    }
    return true;
  }
  cancelSessionRuns(sessionId: string, userId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE review_runs SET status='cancelled', updatedAt=?, finishedAt=COALESCE(finishedAt,?) WHERE sessionId=? AND userId=? AND status NOT IN ('completed','partial','failed','cancelled')`).run(now, now, sessionId, userId);
    this.db.prepare(`UPDATE review_sessions SET status='cancelled', updatedAt=? WHERE id=? AND userId=?`).run(now, sessionId, userId);
  }
  isCancelled(reviewId: string): boolean { const row = this.db.prepare(`SELECT status FROM review_runs WHERE id=?`).get(reviewId) as { status?: string } | null; return row?.status === "cancelled"; }
  listSessionDecisions(sessionId: string, userId: string) { return this.db.prepare(`SELECT * FROM session_decisions WHERE sessionId=? AND userId=? ORDER BY rowid ASC`).all(sessionId,userId).map((r: any) => ({ ...r, name: r.name ?? null, executedAt: r.executedAt || null, executedAtText: r.executedAtText ?? "", timePrecision: r.timePrecision ?? "unknown", price: r.price ?? null, quantity: r.quantity ?? null, quantityShares: r.quantityShares ?? r.quantity ?? null, quantityText: r.quantityText ?? null, confidence: r.confidence ?? 0, needsConfirmation: JSON.parse(r.needsConfirmation || "[]"), confirmed: Boolean(r.confirmed) })) as SessionDecisionRow[]; }
  linkDecisionReview(decisionId: string, userId: string, reviewId: string): void { this.db.prepare(`UPDATE session_decisions SET reviewId=?, confirmed=1 WHERE id=? AND userId=?`).run(reviewId, decisionId, userId); }
  updateSessionDecision(id: string, userId: string, patch: Partial<Pick<SessionDecisionRow, "symbol" | "name" | "market" | "action" | "executedAt" | "executedAtText" | "timePrecision" | "price" | "quantity" | "quantityShares" | "quantityText" | "needsConfirmation" | "reason" | "notes">>): void {
    const allowed = ["symbol", "name", "market", "action", "executedAt", "executedAtText", "timePrecision", "price", "quantity", "quantityShares", "quantityText", "needsConfirmation", "reason", "notes"] as const;
    const entries = Object.entries(patch).filter(([key, value]) => allowed.includes(key as typeof allowed[number]) && value !== undefined);
    if (!entries.length) return;
    const set = entries.map(([key]) => `${key}=?`).join(", ");
    const values: Array<string | number | null> = entries.map(([key, value]) =>
      key === "executedAt" ? (value || "") : key === "needsConfirmation" ? JSON.stringify(value ?? []) : (value ?? null)
    ) as Array<string | number | null>;
    this.db.prepare(`UPDATE session_decisions SET ${set} WHERE id=? AND userId=?`).run(...values, id, userId);
  }
  listMemories(userId: string) { return this.db.prepare(`SELECT * FROM learning_memories WHERE userId=? AND active=1 ORDER BY updatedAt DESC`).all(userId) as LearningMemoryRow[]; }
  addMemory(userId: string, text: string, kind: LearningMemoryRow["kind"], sourceSessionId: string, sourceDecisionId: string | null): void {
    const now = new Date().toISOString();
    const existing = this.db.prepare(`SELECT id FROM learning_memories WHERE userId=? AND text=? AND active=1`).get(userId,text) as { id: string } | null;
    if (existing) this.db.prepare(`UPDATE learning_memories SET strength=strength+1, updatedAt=? WHERE id=? AND userId=?`).run(now, existing.id, userId);
    else this.db.prepare(`INSERT INTO learning_memories (id,userId,text,kind,sourceSessionId,sourceDecisionId,strength,active,createdAt,updatedAt) VALUES (?,?,?,?,?,?,1,1,?,?)`).run(`mem_${randomUUID()}`,userId,text,kind,sourceSessionId,sourceDecisionId,now,now);
  }
}