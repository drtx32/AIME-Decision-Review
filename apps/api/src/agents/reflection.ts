/**
 * Bounded reflection — single self-check pass.
 *
 * The MVP does not iterate. The checks map 1:1 to docs/SPEC.md §14.
 *   - Did ex-post evidence leak into ex-ante evaluation?
 *   - Are important numeric claims grounded?
 *   - Did the review turn correlation into causality?
 *   - Was counter-evidence ignored?
 *   - Did final outcome contaminate decision-quality evaluation?
 *
 * Each check returns a flag (or null). The reflection result feeds back into
 * the final DecisionReviewResult so the UI can surface uncertainty honestly.
 */

import type { DecisionReviewResult, Evidence } from "../types/index.ts";

export type ReflectionFlagCode =
  | "ex_post_leak"
  | "numeric_ungrounded"
  | "correlation_to_causality"
  | "ignored_counter_evidence"
  | "outcome_contamination";

export interface ReflectionFlag {
  code: ReflectionFlagCode;
  message: string;
  severity: "low" | "medium" | "high";
}

export interface ReflectionContext {
  result: DecisionReviewResult;
  rawEvidence: Evidence[];
}

export function reflect(ctx: ReflectionContext): ReflectionFlag[] {
  const flags: ReflectionFlag[] = [];
  const { result, rawEvidence } = ctx;

  // 1. Did ex-post evidence leak into ex-ante evaluation?
  // Heuristic: any citation pointing to an ex_post item must NOT appear in
  // decisionQuality.reasoning or processFactors. If we find a citation there,
  // flag a leak.
  const exPostIds = new Set(result.exPostEvidence.map((e) => e.id));
  const exPostCitations = result.citations.filter((c) => exPostIds.has(c.evidenceId));
  if (exPostCitations.length > 0) {
    flags.push({
      code: "ex_post_leak",
      message: `${exPostCitations.length} citation(s) point to ex_post evidence; they must not support the original decision quality.`,
      severity: "high",
    });
  }

  // 2. Are important numeric claims grounded?
  const numericClaims = extractNumericClaims(result.decisionQuality.reasoning);
  if (numericClaims.length > 0 && result.attribution.length === 0) {
    flags.push({
      code: "numeric_ungrounded",
      message: `Decision-quality reasoning contains ${numericClaims.length} numeric claim(s) but no grounded attribution.`,
      severity: "medium",
    });
  }

  // 3. Did correlation become causality?
  const causalityRegex = /(caused|causing|because of|due to|driven by)/i;
  const attributionWithCausality = result.attribution.filter((a) =>
    causalityRegex.test(a.claim)
  );
  if (attributionWithCausality.length > 0) {
    const unsupportedCausality = attributionWithCausality.filter(
      (a) => a.status !== "supported"
    );
    if (unsupportedCausality.length > 0) {
      flags.push({
        code: "correlation_to_causality",
        message: `${unsupportedCausality.length} attribution claim(s) imply causality but lack supporting evidence.`,
        severity: "medium",
      });
    }
  }

  // 4. Was counter-evidence ignored?
  if (rawEvidence.length > 0 && result.missedEvidence.length === 0) {
    flags.push({
      code: "ignored_counter_evidence",
      message: "No missed-evidence items recorded; verify counter-evidence was considered.",
      severity: "low",
    });
  }

  // 5. Did final outcome contaminate decision-quality evaluation?
  const outcomeTerms = ["profit", "loss", "gain", "P&L", "made money", "lost money"];
  const contaminationMatch = outcomeTerms.find((t) =>
    result.decisionQuality.reasoning.toLowerCase().includes(t.toLowerCase())
  );
  if (contaminationMatch) {
    flags.push({
      code: "outcome_contamination",
      message: `Decision-quality reasoning references outcome (${contaminationMatch}); outcome must not determine quality.`,
      severity: "high",
    });
  }

  return flags;
}

function extractNumericClaims(text: string): string[] {
  // Match simple integers, decimals, and percentages.
  const matches = text.match(/\d+(\.\d+)?%?/g) ?? [];
  return matches.filter((m) => m.length > 0);
}