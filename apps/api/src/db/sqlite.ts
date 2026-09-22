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
  executedAt: string;
  price: number | null;
  quantity: number | null;
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
        executedAt TEXT NOT NULL,
        price REAL,
        quantity REAL,
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

  addMessage(sessionId: string, userId: string, role: SessionMessageRow["role"], content: string): SessionMessageRow {
    const row = { id: `msg_${randomUUID()}`, sessionId, userId, role, content, createdAt: new Date().toISOString() };
    this.db.prepare(`INSERT INTO conversation_messages (id,sessionId,userId,role,content,createdAt) VALUES (?,?,?,?,?,?)`)
      .run(row.id, row.sessionId, row.userId, row.role, row.content, row.createdAt);
    this.db.prepare(`UPDATE review_sessions SET updatedAt=? WHERE id=? AND userId=?`).run(row.createdAt, sessionId, userId);
    return row;
  }

  addSessionDecision(input: Omit<SessionDecisionRow, "id" | "reviewId" | "confirmed">): SessionDecisionRow {
    const row: SessionDecisionRow = { ...input, id: `dec_${randomUUID()}`, reviewId: null, confirmed: false };
    this.db.prepare(`INSERT INTO session_decisions (id,sessionId,userId,symbol,market,action,executedAt,price,quantity,reason,notes,reviewId,confirmed) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id,row.sessionId,row.userId,row.symbol,row.market,row.action,row.executedAt,row.price,row.quantity,row.reason,row.notes,null,0);
    return row;
  }

  listSessions(userId: string) { return this.db.prepare(`SELECT * FROM review_sessions WHERE userId=? ORDER BY updatedAt DESC`).all(userId) as Array<Record<string, unknown>>; }
  getSession(id: string, userId: string) { return this.db.prepare(`SELECT * FROM review_sessions WHERE id=? AND userId=?`).get(id,userId) as Record<string, unknown> | null; }
  listMessages(sessionId: string, userId: string) { return this.db.prepare(`SELECT * FROM conversation_messages WHERE sessionId=? AND userId=? ORDER BY createdAt ASC`).all(sessionId,userId) as SessionMessageRow[]; }
  listSessionDecisions(sessionId: string, userId: string) { return this.db.prepare(`SELECT * FROM session_decisions WHERE sessionId=? AND userId=? ORDER BY rowid ASC`).all(sessionId,userId).map((r: any) => ({ ...r, price: r.price ?? null, quantity: r.quantity ?? null, confirmed: Boolean(r.confirmed) })) as SessionDecisionRow[]; }
  linkDecisionReview(decisionId: string, userId: string, reviewId: string): void { this.db.prepare(`UPDATE session_decisions SET reviewId=?, confirmed=1 WHERE id=? AND userId=?`).run(reviewId, decisionId, userId); }
  listMemories(userId: string) { return this.db.prepare(`SELECT * FROM learning_memories WHERE userId=? AND active=1 ORDER BY updatedAt DESC`).all(userId) as LearningMemoryRow[]; }
  addMemory(userId: string, text: string, kind: LearningMemoryRow["kind"], sourceSessionId: string, sourceDecisionId: string | null): void {
    const now = new Date().toISOString();
    const existing = this.db.prepare(`SELECT id FROM learning_memories WHERE userId=? AND text=? AND active=1`).get(userId,text) as { id: string } | null;
    if (existing) this.db.prepare(`UPDATE learning_memories SET strength=strength+1, updatedAt=? WHERE id=? AND userId=?`).run(now, existing.id, userId);
    else this.db.prepare(`INSERT INTO learning_memories (id,userId,text,kind,sourceSessionId,sourceDecisionId,strength,active,createdAt,updatedAt) VALUES (?,?,?,?,?,?,1,1,?,?)`).run(`mem_${randomUUID()}`,userId,text,kind,sourceSessionId,sourceDecisionId,now,now);
  }
}
