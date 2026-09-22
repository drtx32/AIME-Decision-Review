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
    `);
  }

  createRun(id: string, decision: DecisionInput, T0: string): ReviewRunRow {
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
        `INSERT INTO review_runs (id, status, createdAt, updatedAt, finishedAt, errorMessage)
         VALUES (?, ?, ?, ?, NULL, NULL)`
      )
      .run(row.id, row.status, row.createdAt, row.updatedAt);

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
}