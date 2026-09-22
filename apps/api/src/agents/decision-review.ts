/**
 * Decision Review Agent — single-agent state machine.
 *
 * Lifecycle (per docs/SPEC.md §7):
 *   created → planning → retrieving → analyzing → reflecting → completed | partial | failed
 *
 * The agent is intentionally deterministic in the mock vertical slice: the LLM
 * provider is consulted only for the structured-judgment layer (rating,
 * attribution status, lesson phrasing). Evidence retrieval, T0 alignment, and
 * reflection all run in our code so the hard rules in §6 are not delegated.
 *
 * Test hooks:
 *   - `simulateTransientFailure`: forces every adapter fetch to surface as
 *     transient_error so we can exercise the partial/uncertain path.
 *   - `simulateEmpty`: forces every adapter fetch to surface as empty.
 *   - `simulatePermanent`: forces every adapter fetch to surface as
 *     permanent_error (typically combined with credentials → permanent).
 *
 * OpenAI Agents SDK integration is wired through `runWithOpenAIAgents`, which
 * is currently opt-in and only exercised by a manual integration test (no
 * credentials required for the MVP). The default `runDecisionReview` does not
 * call the SDK at all so the vertical slice stays runnable without secrets.
 */

import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.ts";
import type { ReviewRepository } from "../db/sqlite.ts";
import type {
  AttributionItem,
  BiasFlag,
  Citation,
  DecisionInput,
  DecisionReviewResult,
  Evidence,
  ReviewStatus,
  ToolResult,
  ToolStatus,
  TraceEvent,
} from "../types/index.ts";
import { type McpRegistry } from "../mcp/registry.ts";
import { alignEvidence, type AdapterIntent } from "../mcp/adapters/types.ts";
import { buildPlan, type PlanStep } from "./types.ts";
import { reflect, type ReflectionFlag } from "./reflection.ts";
import type { ModelProvider } from "../providers/index.ts";

export interface RunDecisionOptions {
  simulateTransientFailure?: boolean;
  simulateEmpty?: boolean;
  simulatePermanent?: boolean;
}

export interface AgentRunOutcome {
  result: DecisionReviewResult;
  reflectionFlags: ReflectionFlag[];
}

export class DecisionReviewAgent {
  constructor(
    private readonly deps: {
      repo: ReviewRepository;
      registry: McpRegistry;
      provider: ModelProvider;
      config: AppConfig;
    }
  ) {}

  async run(
    reviewId: string,
    decision: DecisionInput,
    options: RunDecisionOptions = {}
  ): Promise<AgentRunOutcome> {
    const repo = this.deps.repo;
    const T0 = freezeT0(decision.executedAt);
    const plan = buildPlan(decision);

    const emit = (kind: TraceEvent["kind"], message: string, metadata?: Record<string, unknown>) => {
      const event: TraceEvent = {
        id: randomUUID(),
        reviewId,
        kind,
        message,
        at: new Date().toISOString(),
        metadata,
      };
      repo.insertEvent(event);
    };

    // ── planning ───────────────────────────────────────────────────────────
    repo.updateStatus(reviewId, "planning");
    emit("review_created", "Decision Review Agent started.", { T0 });
    emit("evidence_time_aligned", "T0 frozen from executedAt.", { T0 });

    // ── retrieving ─────────────────────────────────────────────────────────
    repo.updateStatus(reviewId, "retrieving");
    const { evidence, toolStatuses } = await this.retrieve(
      reviewId,
      decision,
      T0,
      plan,
      options,
      emit
    );

    repo.insertEvidence(reviewId, evidence);

    // ── analyzing ──────────────────────────────────────────────────────────
    repo.updateStatus(reviewId, "analyzing");
    const { exAnte, exPost, rejected } = alignEvidence(evidence, T0);
    if (rejected.length > 0) {
      emit(
        "error",
        `${rejected.length} evidence item(s) lacked a parseable publishedAt and were excluded from time-bound reasoning.`,
        { rejectedIds: rejected.map((e: Evidence) => e.id) }
      );
    }
    emit("evidence_time_aligned", "Evidence split around T0.", {
      exAnte: exAnte.length,
      exPost: exPost.length,
      rejected: rejected.length,
    });

    // ── reflecting ─────────────────────────────────────────────────────────
    repo.updateStatus(reviewId, "reflecting");
    const draft = await this.compose(reviewId, decision, T0, exAnte, exPost, toolStatuses, emit);
    const flags = reflect({ result: draft, rawEvidence: evidence });
    if (flags.length > 0) {
      emit("reflection", `Reflection produced ${flags.length} flag(s).`, {
        codes: flags.map((f) => f.code),
      });
    } else {
      emit("reflection", "Reflection pass produced no flags.");
    }

    // Apply reflection: if outcome_contamination or ex_post_leak flags are
    // raised, drop the affected citations from the supported attribution set
    // and downgrade the relevant items to uncertain.
    const finalResult = applyReflection(draft, flags);
    finalResult.uncertainties = Array.from(
      new Set([
        ...finalResult.uncertainties,
        ...flags.map((f) => f.message),
      ])
    );

    // Decide terminal status.
    const hasPermanent = toolStatuses.some((s) => s.status === "permanent_error");
    const allEmpty = toolStatuses.every((s) => s.status === "empty");
    const hasTransient = toolStatuses.some((s) => s.status === "transient_error");
    let terminal: ReviewStatus = "completed";
    if (hasPermanent) terminal = "failed";
    else if (allEmpty || hasTransient) terminal = "partial";

    repo.updateStatus(reviewId, terminal, { finishedAt: new Date().toISOString() });
    repo.saveResult(reviewId, finalResult);
    emit("final_review_generated", "Final review generated.", {
      status: terminal,
      flags: flags.length,
    });

    return { result: finalResult, reflectionFlags: flags };
  }

  private async retrieve(
    reviewId: string,
    decision: DecisionInput,
    T0: string,
    plan: PlanStep[],
    options: RunDecisionOptions,
    emit: (kind: TraceEvent["kind"], message: string, metadata?: Record<string, unknown>) => void
  ): Promise<{ evidence: Evidence[]; toolStatuses: ToolStatusRow[] }> {
    const evidence: Evidence[] = [];
    const toolStatuses: ToolStatusRow[] = [];

    for (const step of plan) {
      const adapters = this.deps.registry.resolveFor(step.intent);
      if (adapters.length === 0) {
        toolStatuses.push({
          tool: step.intent,
          server: "<none-configured>",
          status: "empty",
          message: `No adapter configured for intent ${step.intent}`,
        });
        continue;
      }
      for (const adapter of adapters) {
        const result = await this.fetchWithOverrides(adapter, {
          intent: step.intent,
          symbol: decision.symbol,
          market: decision.market,
          T0,
          seed: reviewId,
        }, options);

        toolStatuses.push({
          tool: step.intent,
          server: String(adapter.serverKey),
          status: result.status,
          message: result.error?.message,
        });

        if (result.status === "success" && result.data) {
          evidence.push(...result.data);
          emit(
            kindForIntent(step.intent),
            `Retrieved ${result.data.length} evidence item(s) from ${adapter.provider}:${adapter.serverKey}.`,
            { status: result.status, count: result.data.length }
          );
        } else if (result.status === "empty") {
          emit(
            "tool_status",
            `${adapter.provider}:${adapter.serverKey} returned empty for intent ${step.intent}.`
          );
        } else {
          emit(
            "tool_status",
            `${adapter.provider}:${adapter.serverKey} returned ${result.status} for intent ${step.intent}.`,
            result.error ? { message: result.error.message, code: result.error.code } : undefined
          );
        }
      }
    }
    return { evidence, toolStatuses };
  }

  private async fetchWithOverrides(
    adapter: { fetch: (req: any) => Promise<ToolResult<Evidence[]>>; serverKey: string },
    req: { intent: AdapterIntent; symbol: string; market?: "CN" | "HK" | "US"; T0: string; seed?: string },
    options: RunDecisionOptions
  ): Promise<ToolResult<Evidence[]>> {
    if (options.simulateTransientFailure) {
      return {
        status: "transient_error",
        error: { message: "Simulated transient failure", code: "SIM_TRANSIENT", retryable: true },
        retrievedAt: new Date().toISOString(),
      };
    }
    if (options.simulateEmpty) {
      return { status: "empty", data: [], retrievedAt: new Date().toISOString() };
    }
    if (options.simulatePermanent) {
      return {
        status: "permanent_error",
        error: { message: "Simulated permanent failure", code: "SIM_PERMANENT", retryable: false },
        retrievedAt: new Date().toISOString(),
      };
    }
    return adapter.fetch(req);
  }

  private async compose(
    reviewId: string,
    decision: DecisionInput,
    T0: string,
    exAnte: Evidence[],
    exPost: Evidence[],
    toolStatuses: ToolStatusRow[],
    emit: (kind: TraceEvent["kind"], message: string, metadata?: Record<string, unknown>) => void
  ): Promise<DecisionReviewResult> {
    // ── structured judgment layer ───────────────────────────────────────────
    // We use the LLM provider only for narrative phrasing. The hard facts
    // (evidence list, T0 alignment, citations) are computed deterministically.
    const prompt = buildJudgmentPrompt(decision, T0, exAnte, exPost);
    const llm = await this.deps.provider.complete({
      system: "You produce a structured investment decision review. Always return JSON.",
      user: prompt,
      schemaHint: "DecisionReviewResult",
      temperature: 0.1,
    });
    const judgment = parseStructuredJudgment(llm.text);

    // Always derive the deterministic parts from our own code so the LLM
    // cannot fabricate evidence IDs or break T0.
    const citations: Citation[] = exAnte.map((e) => ({
      evidenceId: e.id,
      claim: truncate(e.content, 80),
    }));

    const attribution: AttributionItem[] = exAnte.slice(0, 5).map((e) => ({
      claim: `Pre-T0 evidence supported: ${truncate(e.title, 80)}`,
      status: "supported" as const,
      evidenceIds: [e.id],
    }));

    const biases: BiasFlag[] = (judgment?.bias_signals ?? []).filter((item: any) => item && typeof item.label === "string").map((item: any) => ({ label: item.label, description: String(item.description ?? item.label), severity: ["low", "medium", "high"].includes(item.severity) ? item.severity : "medium" }));
    if (decision.userReason && /sure|certain|definitely/i.test(decision.userReason)) {
      biases.push({
        label: "overconfidence-language",
        description: "User-stated reason contains assertive language that may signal overconfidence.",
        severity: "medium",
      });
    }

    const missedEvidence: string[] = [];
    if (exAnte.length === 0) {
      missedEvidence.push("No ex-ante evidence was retrievable; process evaluation is severely limited.");
    }

    const lessons: string[] = Array.isArray(judgment?.lessons) ? judgment.lessons.filter((item: unknown): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 5) : [];
    if (exAnte.length > 0 && exPost.length === 0) {
      lessons.push(
        "Outcome window evidence could not be retrieved. Re-run later for outcome analysis."
      );
    } else if (exAnte.length > 0 && exPost.length > 0) {
      lessons.push(
        `Distinguish thesis-quality (${exAnte.length} pre-T0 facts) from outcome-quality (${exPost.length} post-T0 facts).`
      );
    }

    const nextChecklist: string[] = [
      "Re-read the pre-T0 evidence before judging decision quality.",
      "Compare user reason against retrieved ex-ante facts, item by item.",
      "Hold final outcome / P&L out of decision-quality evaluation.",
      "Note counter-evidence that was visible at T0 but not used.",
    ];

    const uncertainties = [];
    if (toolStatuses.some((s) => s.status === "transient_error")) {
      uncertainties.push("Some MCP sources returned transient errors; their evidence may be incomplete.");
    }
    if (toolStatuses.every((s) => s.status === "empty")) {
      uncertainties.push("All MCP sources returned empty for this request.");
    }

    emit("fact_consistency_checked", "Structured judgment assembled.", {
      exAnte: exAnte.length,
      exPost: exPost.length,
      llmChars: llm.text.length,
    });

    return {
      decision: {
        symbol: decision.symbol,
        action: decision.action,
        executedAt: decision.executedAt,
        T0,
        userReason: decision.userReason,
      },
      exAnteEvidence: exAnte,
      exPostEvidence: exPost,
      decisionQuality: {
        rating: exAnte.length > 0 ? "fair" : "poor",
        reasoning: judgment?.verdict || judgment?.ex_ante_summary || `Decision reviewed against ${exAnte.length} ex-ante evidence item(s); ${biases.length} bias signal(s) flagged.`,
        processFactors: [
          `${exAnte.length} pre-T0 evidence item(s) reviewed.`,
          `${decision.userReason ? "User reason recorded" : "No user reason recorded"}; rating based on unknown rubric.`,
        ],
      },
      outcome: {
        summary: `Outcome window contains ${exPost.length} evidence item(s).`,
        pnlRealized: false,
        note: "Outcome is described separately from decision quality.",
      },
      attribution,
      biases,
      missedEvidence,
      lessons,
      nextChecklist,
      uncertainties,
      citations,
      toolStatuses: toolStatuses.map((s) => ({
        tool: s.tool,
        server: s.server,
        status: s.status,
        message: s.message,
      })),
    };
  }
}

interface ToolStatusRow {
  tool: string;
  server: string;
  status: ToolStatus;
  message?: string;
}

function freezeT0(raw: string): string {
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid T0 (executedAt): ${raw}`);
  }
  return new Date(ms).toISOString();
}

function truncate(text: string, n: number): string {
  if (text.length <= n) return text;
  return `${text.slice(0, n - 1)}…`;
}

function parseStructuredJudgment(text: string): { verdict?: string; ex_ante_summary?: string; lessons?: unknown[]; bias_signals?: unknown[] } | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function buildJudgmentPrompt(
  decision: DecisionInput,
  T0: string,
  exAnte: Evidence[],
  exPost: Evidence[]
): string {
  return [
    `Decision symbol=${decision.symbol} action=${decision.action} T0=${T0}`,
    `User reason: ${decision.userReason ?? "(none)"}`,
    `Ex-ante evidence count: ${exAnte.length}`,
    `Ex-post evidence count: ${exPost.length}`,
    "Return JSON with verdict, ex_ante_summary, ex_post_summary, bias_signals.",
  ].join("\n");
}

function kindForIntent(intent: AdapterIntent): TraceEvent["kind"] {
  switch (intent) {
    case "price":
      return "market_data_retrieved";
    case "index":
    case "industry":
      return "index_sector_context_retrieved";
    case "news":
    case "announcement":
      return "news_events_retrieved";
    default:
      return "tool_status";
  }
}

function applyReflection(
  result: DecisionReviewResult,
  flags: ReflectionFlag[]
): DecisionReviewResult {
  const next: DecisionReviewResult = JSON.parse(JSON.stringify(result));
  const flagCodes = new Set(flags.map((f) => f.code));

  if (flagCodes.has("ex_post_leak") || flagCodes.has("outcome_contamination")) {
    next.attribution = next.attribution.map((a) =>
      a.status === "supported" ? { ...a, status: "uncertain" } : a
    );
  }
  if (flagCodes.has("correlation_to_causality")) {
    next.attribution = next.attribution.map((a) =>
      /(caused|causing|because of|due to|driven by)/i.test(a.claim) && a.status === "supported"
        ? { ...a, status: "uncertain" }
        : a
    );
  }
  if (flagCodes.has("numeric_ungrounded")) {
    next.decisionQuality = {
      ...next.decisionQuality,
      reasoning: `${next.decisionQuality.reasoning} (Numeric claims were not separately grounded; treat as uncertain.)`,
    };
  }
  return next;
}
