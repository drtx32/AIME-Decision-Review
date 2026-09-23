/**
 * AttachmentRepository — SQLite + filesystem blob storage.
 *
 * The SQLite row stores every metadata + parsed fragment field that the
 * composer needs (filename, mime, fragments JSON, etc.). The raw upload
 * bytes live on the filesystem under a derived storage root so image
 * attachments remain retrievable for vision-capable LLMs in ELI-336.
 *
 * Per-user access is enforced at the read surface: every getter takes the
 * caller's userId and refuses rows owned by anyone else. A bare id is not
 * enough.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, statSync, unlinkSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ATTACHMENT_CATEGORIES,
  ATTACHMENT_STATUSES,
  type AttachmentCategory,
  type AttachmentFragment,
  type AttachmentMetadata,
  type AttachmentStatus,
  type AttachmentOrImageFragment,
  type ProviderVisionCapability,
} from "./types.ts";

export interface AttachmentRow {
  id: string;
  ownerUserId: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  category: AttachmentCategory;
  status: AttachmentStatus;
  uploadedAt: string;
  retrievedAt: string;
  truncated: number; // 0 | 1
  parsedTextBytes: number;
  parserWarnings: string[];
  sha256: string;
  providerVisionCapability: ProviderVisionCapability;
  fragments: AttachmentOrImageFragment[];
  storagePath: string;
}

export interface CreateAttachmentInput {
  ownerUserId: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  category: AttachmentCategory;
  status: AttachmentStatus;
  fragments: AttachmentOrImageFragment[];
  parsedTextBytes: number;
  parsedTruncated: boolean;
  parserWarnings: string[];
  sha256: string;
  providerVisionCapability: ProviderVisionCapability;
  rawBytes: Uint8Array;
}

export class AttachmentRepository {
  private db: Database;
  private storageRoot: string;

  /**
   * @param sqlitePath  Shared DB file (re-uses the same Database instance as
   *                    ReviewRepository / UserRepository would, in production
   *                    they all live under the same SQLite file). The
   *                    `attachments` table is added in `bootstrap()`.
   * @param storageRoot Directory under which raw bytes are written. Defaults
   *                    to `<sqliteDir>/attachments/`.
   */
  constructor(sqlitePath: string, storageRoot?: string) {
    mkdirSync(dirname(sqlitePath), { recursive: true });
    this.db = new Database(sqlitePath);
    this.storageRoot = storageRoot ?? join(dirname(sqlitePath), "attachments");
    mkdirSync(this.storageRoot, { recursive: true });
    this.bootstrap();
  }

  private bootstrap() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        ownerUserId TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime TEXT NOT NULL,
        sizeBytes INTEGER NOT NULL,
        category TEXT NOT NULL CHECK (category IN (${ATTACHMENT_CATEGORIES.map((c) => `'${c}'`).join(", ")})),
        status TEXT NOT NULL CHECK (status IN (${ATTACHMENT_STATUSES.map((s) => `'${s}'`).join(", ")})),
        uploadedAt TEXT NOT NULL,
        retrievedAt TEXT NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0,
        parsedTextBytes INTEGER NOT NULL DEFAULT 0,
        parserWarnings TEXT NOT NULL DEFAULT '[]',
        sha256 TEXT NOT NULL,
        providerVisionCapability TEXT NOT NULL DEFAULT 'unknown',
        fragments TEXT NOT NULL DEFAULT '[]',
        storagePath TEXT NOT NULL,
        FOREIGN KEY(ownerUserId) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments(ownerUserId);
      CREATE INDEX IF NOT EXISTS idx_attachments_uploadedAt ON attachments(uploadedAt);
    `);
  }

  countOwnedBy(userId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM attachments WHERE ownerUserId = ?`)
      .get(userId) as { n: number };
    return row.n;
  }

  create(input: CreateAttachmentInput): AttachmentRow {
    const id = `att_${randomUUID()}`;
    const uploadedAt = new Date().toISOString();
    const storagePath = join(this.storageRoot, `${id}.bin`);

    // Synchronous file write so the blob is on disk before the route returns.
    // Bun.write returns a Promise; if we don't wait, a subsequent /raw read
    // could see a missing file and 404 even though the row is there.
    writeFileSync(storagePath, input.rawBytes);

    this.db
      .prepare(
        `INSERT INTO attachments
         (id, ownerUserId, filename, mime, sizeBytes, category, status,
          uploadedAt, retrievedAt, truncated, parsedTextBytes, parserWarnings,
          sha256, providerVisionCapability, fragments, storagePath)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.ownerUserId,
        input.filename,
        input.mime,
        input.sizeBytes,
        input.category,
        input.status,
        uploadedAt,
        uploadedAt,
        input.parsedTruncated ? 1 : 0,
        input.parsedTextBytes,
        JSON.stringify(input.parserWarnings),
        input.sha256,
        input.providerVisionCapability,
        JSON.stringify(input.fragments),
        storagePath
      );

    return {
      id,
      ownerUserId: input.ownerUserId,
      filename: input.filename,
      mime: input.mime,
      sizeBytes: input.sizeBytes,
      category: input.category,
      status: input.status,
      uploadedAt,
      retrievedAt: uploadedAt,
      truncated: input.parsedTruncated ? 1 : 0,
      parsedTextBytes: input.parsedTextBytes,
      parserWarnings: input.parserWarnings,
      sha256: input.sha256,
      providerVisionCapability: input.providerVisionCapability,
      fragments: input.fragments,
      storagePath,
    };
  }

  /** Find an attachment the caller owns. Cross-user access returns null. */
  findOwned(id: string, ownerUserId: string): AttachmentRow | null {
    const row = this.db
      .prepare(`SELECT * FROM attachments WHERE id = ? AND ownerUserId = ?`)
      .get(id, ownerUserId) as AttachmentRecord | undefined;
    return row ? toAttachment(row) : null;
  }

  /** List attachments owned by the caller, newest first. */
  listOwned(ownerUserId: string, limit = 50): AttachmentRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM attachments WHERE ownerUserId = ? ORDER BY uploadedAt DESC LIMIT ?`
      )
      .all(ownerUserId, limit) as AttachmentRecord[];
    return rows.map(toAttachment);
  }

  /** Delete an attachment owned by the caller; returns true if a row was removed. */
  deleteOwned(id: string, ownerUserId: string): boolean {
    const row = this.findOwned(id, ownerUserId);
    if (!row) return false;
    const res = this.db
      .prepare(`DELETE FROM attachments WHERE id = ? AND ownerUserId = ?`)
      .run(id, ownerUserId);
    if (res.changes > 0) {
      try {
        if (existsSync(row.storagePath)) unlinkSync(row.storagePath);
      } catch {
        // best-effort cleanup — orphan files don't break access control
      }
      return true;
    }
    return false;
  }

  /** Open the raw upload bytes for the caller. Cross-user access returns null. */
  openOwnedBytes(id: string, ownerUserId: string): Uint8Array | null {
    const row = this.findOwned(id, ownerUserId);
    if (!row) return null;
    if (!existsSync(row.storagePath)) return null;
    const stat = statSync(row.storagePath);
    if (stat.size !== row.sizeBytes) {
      // Defensive: size mismatch would suggest the file got swapped on disk.
      return null;
    }
    return new Uint8Array(readFileSync(row.storagePath));
  }

  close() {
    this.db.close();
  }
}

interface AttachmentRecord {
  id: string;
  ownerUserId: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  category: AttachmentCategory;
  status: AttachmentStatus;
  uploadedAt: string;
  retrievedAt: string;
  truncated: number;
  parsedTextBytes: number;
  parserWarnings: string;
  sha256: string;
  providerVisionCapability: ProviderVisionCapability;
  fragments: string;
  storagePath: string;
}

function toAttachment(r: AttachmentRecord): AttachmentRow {
  let warnings: string[] = [];
  let fragments: AttachmentOrImageFragment[] = [];
  try {
    warnings = JSON.parse(r.parserWarnings) as string[];
  } catch {
    warnings = [];
  }
  try {
    fragments = JSON.parse(r.fragments) as AttachmentOrImageFragment[];
  } catch {
    fragments = [];
  }
  return {
    id: r.id,
    ownerUserId: r.ownerUserId,
    filename: r.filename,
    mime: r.mime,
    sizeBytes: r.sizeBytes,
    category: r.category,
    status: r.status,
    uploadedAt: r.uploadedAt,
    retrievedAt: r.retrievedAt,
    truncated: r.truncated,
    parsedTextBytes: r.parsedTextBytes,
    parserWarnings: warnings,
    sha256: r.sha256,
    providerVisionCapability: r.providerVisionCapability,
    fragments,
    storagePath: r.storagePath,
  };
}

export function attachmentRowToMetadata(row: AttachmentRow): AttachmentMetadata {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    filename: row.filename,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    category: row.category,
    status: row.status,
    uploadedAt: row.uploadedAt,
    retrievedAt: row.retrievedAt,
    fragments: row.fragments,
    parsedTruncated: row.truncated === 1,
    parsedTextBytes: row.parsedTextBytes,
    parserWarnings: row.parserWarnings,
    sha256: row.sha256,
    providerVisionCapability: row.providerVisionCapability,
  };
}