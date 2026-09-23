/**
 * Normalized chart-data contract.
 *
 * Direct API responses from Fuyao / iFinD are translated into one of the
 * shapes below before they leave the server. The frontend renders all
 * charts from this contract so it can stay provider-agnostic, and so any
 * new provider can plug in without re-shaping the UI.
 *
 * The contract intentionally carries every provenance field the SPEC
 * demands (trading timestamp, event publishedAt, retrievedAt, source,
 * timezone, units, adjustment mode). Anything we cannot prove must be
 * surfaced as `unavailable` rather than silently filled in.
 */

import { z } from "zod";

export const ChartTypeSchema = z.enum([
  "kline",
  "timeline",
  "compare",
  "valuation",
  "financial",
]);
export type ChartType = z.infer<typeof ChartTypeSchema>;

export const ChartPeriodSchema = z.enum(["day", "week", "month"]);
export type ChartPeriod = z.infer<typeof ChartPeriodSchema>;

export const AdjustmentModeSchema = z.enum([
  "none",
  "qfq", // 前复权 — China A-share forward-adjusted
  "hfq", // 后复权 — China A-share backward-adjusted
]);
export type AdjustmentMode = z.infer<typeof AdjustmentModeSchema>;

export const ChartRequestSchema = z.object({
  symbol: z.string().min(1),
  market: z.enum(["CN", "HK", "US"]).optional(),
  type: ChartTypeSchema,
  period: ChartPeriodSchema.optional(),
  start: z.string().datetime({ offset: true }).optional(),
  end: z.string().datetime({ offset: true }).optional(),
  /** Compare-line baseline: another symbol or a benchmark like 000300.SH. */
  compareSymbol: z.string().min(1).optional(),
  adjustment: AdjustmentModeSchema.optional(),
});
export type ChartRequest = z.infer<typeof ChartRequestSchema>;

/**
 * One OHLCV candle. `volume` is in the same currency/share unit as the
 * upstream feed. Timestamps are normalized to ISO with offset; the
 * frontend never re-parses loose date strings.
 */
export interface Candle {
  /** Trading timestamp (Asia/Shanghai for A-share). */
  t: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount?: number;
}

export interface LinePoint {
  /** Trading timestamp. */
  t: string;
  /** Price level in the upstream unit. */
  value: number;
}

export interface TimelineMarker {
  /** Event publication timestamp. */
  t: string;
  /** Friendly label shown on the chart. */
  label: string;
  /**
   * `relationToDecision` is derived against the review's T0:
   *   ex_ante  — published at or before T0
   *   ex_post  — published strictly after T0
   * The chart never lets a marker justify the original decision when it
   * is ex_post.
   */
  relationToDecision: "ex_ante" | "ex_post";
  /** Optional provenance detail. */
  source?: string;
}

export interface ChartSeries {
  /** Provider that actually returned this series. */
  source: "fuyao" | "ifind" | "mixed" | "fallback";
  symbol: string;
  market: "CN" | "HK" | "US";
  timezone: string;
  unit: string;
  adjustment?: AdjustmentMode;
  retrievedAt: string;
  candles?: Candle[];
  /** Plain numeric series (compare-line, valuation, financial). */
  line?: LinePoint[];
  /** Baseline series for compare charts (aligned timestamps). */
  baseline?: LinePoint[];
  /** Decision / event / news markers aligned on the same time axis. */
  markers?: TimelineMarker[];
}

/**
 * Degraded-mode envelope. `status: "unavailable"` means the upstream was
 * reachable but the field/symbol/permission is not supported; the
 * frontend MUST render an explicit unavailable card, never an empty
 * "successful" chart.
 */
export const ChartStatusSchema = z.enum([
  "ok",
  "empty",
  "unavailable", // provider returned no permission / unsupported field
  "transient_error", // 5xx, timeout, rate-limit — retryable
  "permanent_error", // 401/403/404, schema mismatch — non-retryable
]);
export type ChartStatus = z.infer<typeof ChartStatusSchema>;

export interface ChartResponse {
  status: ChartStatus;
  type: ChartType;
  series?: ChartSeries;
  error?: { code: string; message: string; retryable: boolean };
  retrievedAt: string;
  /** Diagnostic copy shown to the user when status != ok. */
  message?: string;
}

export const ChartResponseSchema = z.object({
  status: ChartStatusSchema,
  type: ChartTypeSchema,
  series: z
    .object({
      source: z.enum(["fuyao", "ifind", "mixed", "fallback"]),
      symbol: z.string(),
      market: z.enum(["CN", "HK", "US"]),
      timezone: z.string(),
      unit: z.string(),
      adjustment: AdjustmentModeSchema.optional(),
      retrievedAt: z.string(),
      candles: z
        .array(
          z.object({
            t: z.string(),
            open: z.number(),
            high: z.number(),
            low: z.number(),
            close: z.number(),
            volume: z.number(),
            amount: z.number().optional(),
          })
        )
        .optional(),
      line: z
        .array(z.object({ t: z.string(), value: z.number() }))
        .optional(),
      baseline: z
        .array(z.object({ t: z.string(), value: z.number() }))
        .optional(),
      markers: z
        .array(
          z.object({
            t: z.string(),
            label: z.string(),
            relationToDecision: z.enum(["ex_ante", "ex_post"]),
            source: z.string().optional(),
          })
        )
        .optional(),
    })
    .optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    })
    .optional(),
  retrievedAt: z.string(),
  message: z.string().optional(),
});

/**
 * A-share default timezone. We normalize every A-share trading timestamp
 * to Asia/Shanghai so the chart axis, decision timestamps, and event
 * markers line up on the same wall clock.
 */
export const A_SHARE_TIMEZONE = "Asia/Shanghai";

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}