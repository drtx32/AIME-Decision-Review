/**
 * Plan derivation. Pure function — the agent's plan is computed from the
 * decision input without touching the LLM. The plan decides which intents to
 * query and which MCP servers to consult.
 */

import type { DecisionInput, McpServerKey } from "../types/index.ts";
import type { AdapterIntent } from "../mcp/adapters/types.ts";

export interface PlanStep {
  intent: AdapterIntent;
  /** Empty array = "use any configured server that supports this intent". */
  preferredServers: McpServerKey[];
}

const DEFAULT_PLAN: PlanStep[] = [
  { intent: "price", preferredServers: ["a-share", "stock"] },
  { intent: "financial", preferredServers: ["a-share", "stock"] },
  { intent: "news", preferredServers: ["news"] },
  { intent: "announcement", preferredServers: ["a-share", "stock"] },
  { intent: "index", preferredServers: ["a-share-index", "index"] },
  { intent: "macro", preferredServers: ["edb", "bond"] },
  { intent: "fund", preferredServers: ["fund"] },
  { intent: "futures", preferredServers: ["futures"] },
  { intent: "legal", preferredServers: ["law"] },
  { intent: "enterprise", preferredServers: ["enterprise"] },
];

/** Build the default plan for a decision input. Pure, deterministic. */
export function buildPlan(decision: DecisionInput): PlanStep[] {
  const plan: PlanStep[] = [...DEFAULT_PLAN];
  if (decision.market === "US" || decision.market === "HK") {
    // cross-asset / global peers more relevant for non-CN decisions
    plan.push({ intent: "price", preferredServers: ["global-stock"] });
  }
  return plan;
}