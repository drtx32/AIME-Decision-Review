/**
 * Thin LLM provider abstraction.
 *
 * v0.1 implements a single provider at a time (no multi-provider routing). The
 * abstraction exists so that the MVP can run without real credentials via the
 * mock provider, and a real OpenAI-compatible endpoint (MiniMax, OpenAI,
 * etc.) can be slotted in by changing LLM_PROVIDER.
 *
 * The provider returns structured JSON — never free-form chat — so the agent
 * state machine can validate every claim before it lands in the result.
 *
 * `capabilities` exposes what the configured endpoint has actually been
 * probed to support — most importantly whether image inputs work. The
 * attachment pipeline records this snapshot at upload time so the composer
 * (ELI-336) can later decide whether to invoke the multimodal path without
 * re-querying the provider.
 */

import type { AppConfig } from "../config.ts";
import { MockModelProvider } from "./mock-provider.ts";
import { OpenAICompatibleProvider } from "./openai-compatible.ts";

export interface LLMCompletionRequest {
  system: string;
  user: string;
  /** Optional structured output schema hint passed to the model. */
  schemaHint?: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMCompletion {
  text: string;
  /** Provider may optionally return structured fields. */
  structured?: Record<string, unknown>;
  /** Total tokens if reported by the provider. */
  usage?: { input: number; output: number };
}

/**
 * Provider capability flags. Set at construction time; `images` is the result
 * of a real probe (small multimodal payload → /chat/completions) — never a
 * model-name string match.
 */
export interface ProviderCapabilities {
  text: true;
  images: boolean;
}

export interface ModelProvider {
  readonly id: string;
  readonly modelName: string;
  readonly capabilities: ProviderCapabilities;
  complete(req: LLMCompletionRequest): Promise<LLMCompletion>;
  /**
   * Probe a multimodal payload against the live endpoint. Used internally
   * by `OpenAICompatibleProvider` to populate `capabilities.images`. The
   * mock provider implements it as a synchronous "unknown".
   */
  probeImages?(): Promise<{ available: boolean; reason?: string }>;
}

let cached: ModelProvider | null = null;

export function getModelProvider(cfg: AppConfig): ModelProvider {
  if (cached) return cached;
  if (cfg.llm.provider === "mock") {
    cached = new MockModelProvider(cfg.llm.model);
    return cached;
  }
  if (!cfg.llm.baseUrl || !cfg.llm.apiKey) {
    // Real provider requested but credentials missing — degrade to mock rather
    // than throw, so the dev server stays up.
    cached = new MockModelProvider(cfg.llm.model);
    return cached;
  }
  cached = new OpenAICompatibleProvider({
    modelName: cfg.llm.model,
    baseUrl: cfg.llm.baseUrl,
    apiKey: cfg.llm.apiKey,
  });
  return cached;
}

/** Test hook — reset the cached provider between specs. */
export function _resetModelProviderForTest() {
  cached = null;
}