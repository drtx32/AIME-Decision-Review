import type { Evidence, ToolResult, ToolStatus } from "../../types/index.ts";
import type { FuyaoServerKey, IFindServerKey, McpServerKey } from "../../types/index.ts";

export type AdapterIntent =
  | "price"
  | "news"
  | "financial"
  | "industry"
  | "macro"
  | "announcement"
  | "legal"
  | "enterprise"
  | "fund"
  | "futures"
  | "options"
  | "index";

export interface AdapterRequest {
  intent: AdapterIntent;
  symbol: string;
  market?: "CN" | "HK" | "US";
  T0: string;
  /** How many evidence items at most the adapter may return. */
  limit?: number;
  /** Deterministic seed for the mock layer; ignored by real adapters. */
  seed?: string;
}

export interface AdapterCredentials {
  /** Endpoint base URL; null disables real network calls. */
  baseUrl?: string | null;
  /** API key (Fuyao). */
  apiKey?: string | null;
  /** Authorization header (iFinD). */
  authorization?: string | null;
}

export interface EvidenceAdapter {
  readonly serverKey: McpServerKey;
  readonly provider: "fuyao" | "ifind";
  /** Decide whether this adapter can answer the requested intent at all. */
  canHandle(intent: AdapterIntent): boolean;
  /** Return structured evidence for the request. */
  fetch(req: AdapterRequest): Promise<ToolResult<Evidence[]>>;
}

export function wrapSuccess(
  data: Evidence[],
  retrievedAt: string,
  durationMs?: number
): ToolResult<Evidence[]> {
  return { status: "success", data, retrievedAt, durationMs };
}

export function wrapEmpty(retrievedAt: string, durationMs?: number): ToolResult<Evidence[]> {
  return { status: "empty", data: [], retrievedAt, durationMs };
}

export function wrapTransientError(
  code: string,
  message: string,
  retrievedAt: string,
  durationMs?: number
): ToolResult<Evidence[]> {
  return {
    status: "transient_error",
    retrievedAt,
    durationMs,
    error: { code, message, retryable: true },
  };
}

export function wrapPermanentError(
  code: string,
  message: string,
  retrievedAt: string,
  durationMs?: number
): ToolResult<Evidence[]> {
  return {
    status: "permanent_error",
    retrievedAt,
    durationMs,
    error: { code, message, retryable: false },
  };
}

/** @deprecated use the typed helpers above; kept for callers that already
 *  pass a ToolResult through. */
export function wrapResult<T>(
  status: ToolStatus,
  data: T | undefined,
  retrievedAt: string,
  options: { error?: ToolResult<T>["error"]; durationMs?: number } = {}
): ToolResult<T> {
  return {
    status,
    data,
    error: options.error,
    retrievedAt,
    durationMs: options.durationMs,
  };
}

/** All adapter-returned evidence must align around T0. */
export function alignEvidence(
  evidence: Evidence[],
  T0: string
): { exAnte: Evidence[]; exPost: Evidence[]; rejected: Evidence[] } {
  const t0Ms = Date.parse(T0);
  if (Number.isNaN(t0Ms)) {
    throw new Error(`alignEvidence: invalid T0 ${T0}`);
  }
  const exAnte: Evidence[] = [];
  const exPost: Evidence[] = [];
  const rejected: Evidence[] = [];
  for (const e of evidence) {
    const pubMs = Date.parse(e.publishedAt);
    if (Number.isNaN(pubMs)) {
      rejected.push(e);
      continue;
    }
    if (pubMs <= t0Ms) exAnte.push(e);
    else exPost.push(e);
  }
  return { exAnte, exPost, rejected };
}

export type { FuyaoServerKey, IFindServerKey, McpServerKey };