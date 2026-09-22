/**
 * MockModelProvider — used when no real LLM credentials are configured.
 *
 * It does NOT fabricate market evidence. The agent harness in
 * src/agents/decision-review.ts reads structured intent from the user input and
 * uses deterministic mock evidence from the MCP mock layer instead of asking
 * the LLM for facts. This provider exists so the LLM-only structured-judgment
 * step (rating, attribution reasoning, lesson phrasing) still has a typed
 * surface during the mock vertical slice.
 */

import type { LLMCompletion, LLMCompletionRequest, ModelProvider, ProviderAvailability } from "./index.ts";

export class MockModelProvider implements ModelProvider {
  readonly id = "mock";
  readonly modelName: string;

  constructor(modelName: string) {
    this.modelName = modelName;
  }

  async complete(req: LLMCompletionRequest): Promise<LLMCompletion> {
    // The mock emits a minimal JSON stub that the agent harness can parse or
    // ignore. Real reasoning lives in the deterministic mock layer.
    const structured = {
      mock: true,
      echoedPromptChars: req.user.length,
      schemaHint: req.schemaHint ?? null,
      verdict: "defer-to-mock-evidence-layer",
    };
    return {
      text: JSON.stringify(structured),
      structured,
      usage: { input: req.user.length, output: 64 },
    };
  }

  availability(): ProviderAvailability {
    return {
      state: "ready",
      providerId: this.id,
      model: this.modelName,
      lastError: null,
      requestedMode: "mock",
      degraded: false,
    };
  }
}