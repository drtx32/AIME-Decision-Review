/**
 * Attachment domain types — ELI-337.
 *
 * This module defines the controlled file ingestion contract. Each
 * attachment is bounded by:
 *
 *   - allowlisted MIME + extension
 *   - per-file byte / character / row / sheet caps
 *   - per-user file-count quota
 *
 * Every parsed fragment is labeled `user_provided_context` by default and
 * must NEVER be promoted to `ex_ante` / `ex_post` evidence simply because
 * the underlying text contains an old date. The composer (ELI-336) treats
 * these fragments as plain context, not as time-bound evidence.
 */

import { z } from "zod";

// ─── Categories ────────────────────────────────────────────────────────────

export const ATTACHMENT_CATEGORIES = [
  "image",
  "pdf",
  "docx",
  "xlsx",
  "csv",
] as const;
export type AttachmentCategory = (typeof ATTACHMENT_CATEGORIES)[number];

// ─── Status ─────────────────────────────────────────────────────────────────
//
//   ready        — parsed successfully
//   no_text      — parsed but no usable text (image-only PDF, empty XLSX)
//   unsupported  — file is not on the allowlist
//   oversized    — file exceeds a hard limit
//   rejected     — sanitisation / MIME mismatch
//   failed       — parser crashed on the input
//
export const ATTACHMENT_STATUSES = [
  "ready",
  "no_text",
  "unsupported",
  "oversized",
  "rejected",
  "failed",
] as const;
export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number];

// ─── Provenance ─────────────────────────────────────────────────────────────
//
// User uploads are ALWAYS `user_provided_context`. They are deliberately
// outside the ex_ante / ex_post split so a chunk of text dated 2020 does not
// silently become ex-ante evidence merely because the user attached it.
export const ATTACHMENT_SOURCE = "user_upload" as const;
export const ATTACHMENT_RELATION = "user_provided_context" as const;

// ─── Public metadata ───────────────────────────────────────────────────────
export interface AttachmentMetadata {
  id: string;
  ownerUserId: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  category: AttachmentCategory;
  status: AttachmentStatus;
  uploadedAt: string;
  retrievedAt: string;
  /** Parsed structured fragments — only present when status === 'ready' | 'no_text'. */
  fragments: AttachmentOrImageFragment[];
  /** True when parsed text was capped before being persisted. */
  parsedTruncated: boolean;
  /** Approximate total bytes of structured text after parsing. */
  parsedTextBytes: number;
  /** Non-fatal parser warnings (e.g. partial DOCX recovery). */
  parserWarnings: string[];
  /** SHA-256 of the raw upload bytes (hex). Useful for downstream dedup. */
  sha256: string;
  /** Provider capability snapshot at parse time — informs the composer. */
  providerVisionCapability: ProviderVisionCapability;
}

export type ProviderVisionCapability = "available" | "unavailable" | "unknown";

// ─── Fragments ─────────────────────────────────────────────────────────────

export interface AttachmentFragment {
  kind: "text";
  text: string;
  /** PDF page index (1-based) when available. */
  page?: number;
  /** XLSX sheet name when available. */
  sheet?: string;
  /** Inclusive [from, to] 1-based row range inside a sheet. */
  rowRange?: { from: number; to: number };
  /** Inclusive [from, to] A1-style cell range inside a sheet. */
  cellRange?: { from: string; to: string };
  /** Stable ordering key inside the attachment (e.g. "p:1", "sheet1:A1:E10"). */
  locator: string;

  // Provenance — every fragment carries these so the composer can render
  // them without re-querying the attachment row.
  filename: string;
  mime: string;
  extractionStatus: "success" | "no_text" | "partial" | "truncated";
  uploadedAt: string;
  retrievedAt: string;
  source: typeof ATTACHMENT_SOURCE;
  relationToDecision: typeof ATTACHMENT_RELATION;
}

export interface ImageAttachmentFragment {
  kind: "image";
  mime: string;
  sha256: string;
  byteLength: number;
  locator: "image";

  filename: string;
  uploadedAt: string;
  retrievedAt: string;
  source: typeof ATTACHMENT_SOURCE;
  relationToDecision: typeof ATTACHMENT_RELATION;
}

export type AttachmentOrImageFragment = AttachmentFragment | ImageAttachmentFragment;

// ─── Zod schemas ───────────────────────────────────────────────────────────

export const AttachmentFragmentSchema = z.object({
  kind: z.literal("text"),
  text: z.string(),
  page: z.number().int().positive().optional(),
  sheet: z.string().optional(),
  rowRange: z
    .object({ from: z.number().int().positive(), to: z.number().int().positive() })
    .optional(),
  cellRange: z
    .object({ from: z.string(), to: z.string() })
    .optional(),
  locator: z.string(),
  filename: z.string(),
  mime: z.string(),
  extractionStatus: z.enum(["success", "no_text", "partial", "truncated"]),
  uploadedAt: z.string().datetime({ offset: true }),
  retrievedAt: z.string().datetime({ offset: true }),
  source: z.literal("user_upload"),
  relationToDecision: z.literal("user_provided_context"),
});

export const ImageAttachmentFragmentSchema = z.object({
  kind: z.literal("image"),
  mime: z.string(),
  sha256: z.string(),
  byteLength: z.number().int().nonnegative(),
  locator: z.literal("image"),
  filename: z.string(),
  uploadedAt: z.string().datetime({ offset: true }),
  retrievedAt: z.string().datetime({ offset: true }),
  source: z.literal("user_upload"),
  relationToDecision: z.literal("user_provided_context"),
});

export const AttachmentMetadataSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  filename: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  category: z.enum(ATTACHMENT_CATEGORIES),
  status: z.enum(ATTACHMENT_STATUSES),
  uploadedAt: z.string().datetime({ offset: true }),
  retrievedAt: z.string().datetime({ offset: true }),
  fragments: z.array(z.union([AttachmentFragmentSchema, ImageAttachmentFragmentSchema])),
  parsedTruncated: z.boolean(),
  parsedTextBytes: z.number().int().nonnegative(),
  parserWarnings: z.array(z.string()),
  sha256: z.string(),
  providerVisionCapability: z.enum(["available", "unavailable", "unknown"]),
});