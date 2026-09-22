import { z } from "zod";

/**
 * Core domain types for AIME Decision Review.
 *
 * Mirrors docs/SPEC.md §8–§10. Keep these schemas and types in lock-step.
 */

// ─── Decision input ────────────────────────────────────────────────────────
export const DecisionInputSchema = z.object({
  symbol: z.string().min(1),
  market: z.enum(["CN", "HK", "US"]).optional(),
  action: z.enum(["buy", "sell"]),
  executedAt: z.string().datetime({ offset: true }),
  timePrecision: z.enum(["exact", "approximate", "unknown"]).optional(),
  price: z.number().positive().optional(),
  quantity: z.number().positive().optional(),
  userReason: z.string().optional(),
  notes: z.string().optional(),
});

export type DecisionInput = z.infer<typeof DecisionInputSchema>;

// ─── Evidence ──────────────────────────────────────────────────────────────
export const EvidenceTypeSchema = z.enum([
  "price",
  "financial",
  "news",
  "announcement",
  "industry",
  "macro",
  "market",
  "fund",
  "futures",
  "options",
  "legal",
  "enterprise",
]);

export const RelationToDecisionSchema = z.enum(["ex_ante", "ex_post"]);

export const EvidenceSchema = z.object({
  id: z.string(),
  type: EvidenceTypeSchema,
  title: z.string(),
  content: z.string(),
  source: z.string(),
  sourceUrl: z.string().url().optional(),
  publishedAt: z.string().datetime({ offset: true }),
  retrievedAt: z.string().datetime({ offset: true }),
  relationToDecision: RelationToDecisionSchema,
  confidence: z.number().min(0).max(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type Evidence = z.infer<typeof EvidenceSchema>;

// ─── Tool error semantics ───────────────────────────────────────────────────
export const ToolStatusSchema = z.enum([
  "success",
  "empty",
  "transient_error",
  "permanent_error",
]);

export type ToolStatus = z.infer<typeof ToolStatusSchema>;

export const ToolResultSchema = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({
    status: ToolStatusSchema,
    data: payload.optional(),
    error: z
      .object({
        message: z.string(),
        code: z.string().optional(),
        retryable: z.boolean().optional(),
      })
      .optional(),
    retrievedAt: z.string().datetime({ offset: true }),
    durationMs: z.number().nonnegative().optional(),
  });

export interface ToolResult<T = unknown> {
  status: ToolStatus;
  data?: T;
  error?: { message: string; code?: string; retryable?: boolean };
  retrievedAt: string;
  durationMs?: number;
}

// ─── Review run lifecycle ──────────────────────────────────────────────────
export const ReviewStatusSchema = z.enum([
  "created",
  "planning",
  "retrieving",
  "analyzing",
  "reflecting",
  "completed",
  "partial",
  "failed",
  "waiting_for_approval",
]);

export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

// ─── Decision review result ────────────────────────────────────────────────
export const BiasFlagSchema = z.object({
  label: z.string(),
  description: z.string(),
  severity: z.enum(["low", "medium", "high"]).default("low"),
});
export type BiasFlag = z.infer<typeof BiasFlagSchema>;

export const AttributionItemSchema = z.object({
  claim: z.string(),
  status: z.enum(["supported", "uncertain", "unsupported"]),
  evidenceIds: z.array(z.string()),
});
export type AttributionItem = z.infer<typeof AttributionItemSchema>;

export const CitationSchema = z.object({
  evidenceId: z.string(),
  claim: z.string(),
});
export type Citation = z.infer<typeof CitationSchema>;

export const DecisionReviewResultSchema = z.object({
  decision: z.object({
    symbol: z.string(),
    action: DecisionInputSchema.shape.action,
    executedAt: z.string().datetime({ offset: true }),
    T0: z.string().datetime({ offset: true }),
    timePrecision: z.enum(["exact", "approximate", "unknown"]).optional(),
    userReason: z.string().optional(),
  }),
  exAnteEvidence: z.array(EvidenceSchema),
  exPostEvidence: z.array(EvidenceSchema),
  decisionQuality: z.object({
    rating: z.enum(["poor", "fair", "good", "strong"]).or(z.string()),
    reasoning: z.string(),
    processFactors: z.array(z.string()).default([]),
  }),
  outcome: z.object({
    summary: z.string(),
    pnlRealized: z.boolean().default(false),
    note: z.string(),
  }),
  attribution: z.array(AttributionItemSchema),
  biases: z.array(BiasFlagSchema),
  missedEvidence: z.array(z.string()),
  lessons: z.array(z.string()),
  nextChecklist: z.array(z.string()),
  uncertainties: z.array(z.string()),
  citations: z.array(CitationSchema),
  toolStatuses: z.array(
    z.object({
      tool: z.string(),
      server: z.string(),
      status: ToolStatusSchema,
      message: z.string().optional(),
    })
  ),
});

export type DecisionReviewResult = z.infer<typeof DecisionReviewResultSchema>;

// ─── Trace events ──────────────────────────────────────────────────────────
export const TraceEventKindSchema = z.enum([
  "review_created",
  "market_data_retrieved",
  "index_sector_context_retrieved",
  "news_events_retrieved",
  "evidence_time_aligned",
  "fact_consistency_checked",
  "final_review_generated",
  "tool_status",
  "reflection",
  "error",
]);

export type TraceEventKind = z.infer<typeof TraceEventKindSchema>;

export interface TraceEvent {
  id: string;
  reviewId: string;
  kind: TraceEventKind;
  message: string;
  at: string;
  metadata?: Record<string, unknown>;
}

// ─── MCP server keys ───────────────────────────────────────────────────────
export const FUYAO_SERVER_KEYS = [
  "meta",
  "a-share",
  "a-share-index",
  "fund",
  "futures",
  "options",
] as const;
export type FuyaoServerKey = (typeof FUYAO_SERVER_KEYS)[number];

export const IFIND_SERVER_KEYS = [
  "ds",
  "enterprise",
  "law",
  "stock",
  "fund",
  "edb",
  "news",
  "bond",
  "global-stock",
  "index",
  "futures",
] as const;
export type IFindServerKey = (typeof IFIND_SERVER_KEYS)[number];

export type McpServerKey = FuyaoServerKey | IFindServerKey;
