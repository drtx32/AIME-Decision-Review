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
 * Resilience (ELI-326):
 *   - `getModelProvider` never throws at import/startup, even if LLM env is
 *     missing or invalid. The real-provider client is constructed lazily on
 *     first use; missing LLM_BASE_URL / LLM_API_KEY simply degrades to mock.
 *   - `LazyResilientProvider.complete(...)` runs the call with a timeout and
 *     bounded retry (only on retryable errors), surfaces every failure as a
 *     typed ProviderError, never lets a raw SDK exception escape.
 *   - `availability()` is the source of truth for /health and the review
 *     pre-flight: ready / unconfigured / error.
 */

import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.ts";
import { MockModelProvider } from "./mock-provider.ts";
import { OpenAICompatibleProvider } from "./openai-compatible.ts";
import {
  classifyProviderError,
  makeProviderError,
  type ProviderError,
} from "./errors.ts";

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

export interface ModelProvider {
  readonly id: string;
  readonly modelName: string;
  complete(req: LLMCompletionRequest): Promise<LLMCompletion>;
}

export type ProviderState = "ready" | "unconfigured" | "error";

export interface ProviderAvailability {
  state: ProviderState;
  providerId: string | null;
  model: string | null;
  /** Set when state === "error". Stable for diagnostics. */
  lastError: ProviderError | null;
  /**
   * When the provider wanted "openai-compatible" but lacked credentials, we
   * degraded to mock. This flag tells the operator that the requested mode
   * is not actually live without crashing the API.
   */
  requestedMode: "openai-compatible" | "mock";
  degraded: boolean;
}

interface InternalProviderOptions {
  /** Bounded total budget for one complete() call, including retries. ms. */
  requestTimeoutMs?: number;
  /** Max retry attempts on retryable errors. 0 = no retry. */
  maxRetries?: number;
  /** Initial backoff before first retry. ms. */
  retryBaseMs?: number;
}

const DEFAULT_OPTS: Required<InternalProviderOptions> = {
  requestTimeoutMs: 20_000,
  maxRetries: 1,
  retryBaseMs: 250,
};

/**
 * Lazy resilient provider — wraps a base ModelProvider with:
 *   - bounded timeout via AbortController
 *   - bounded retry on retryable errors
 *   - sanitized error mapping
 *   - lazy construction of the OpenAI client (no startup crash)
 *
 * Construction never throws. The first complete() call that needs a real
 * provider either succeeds or surfaces a typed ProviderError.
 */
export class LazyResilientProvider implements ModelProvider {
  readonly id: string;
  readonly modelName: string;
  private readonly build: () => ModelProvider;
  private inner: ModelProvider | null = null;
  private lastError: ProviderError | null = null;
  private readonly opts: Required<InternalProviderOptions>;

  constructor(opts: {
    id: string;
    modelName: string;
    build: () => ModelProvider;
    providerOptions?: InternalProviderOptions;
  }) {
    this.id = opts.id;
    this.modelName = opts.modelName;
    this.build = opts.build;
    this.opts = { ...DEFAULT_OPTS, ...(opts.providerOptions ?? {}) };
  }

  /** Try to construct the inner provider. Returns null on failure. */
  private ensureInner(): ModelProvider | null {
    if (this.inner) return this.inner;
    try {
      this.inner = this.build();
      this.lastError = null;
      return this.inner;
    } catch (e) {
      // Construction should never throw (we guard the OpenAI client behind
      // null checks), but if a dependency-injected package
      // throws on construction, we surface it as a typed error instead of
      // letting it crash the request.
      const corr = randomUUID();
      this.lastError = makeProviderError("MODEL_UNAVAILABLE", {
        correlationId: corr,
        sanitizedMessage: "Failed to construct LLM provider.",
        providerId: this.id,
        providerStatus: "construction_failed",
      });
      return null;
    }
  }

  async complete(req: LLMCompletionRequest): Promise<LLMCompletion> {
    const inner = this.ensureInner();
    if (!inner) {
      // Construction failed; surface the stored typed error.
      throw this.lastError ?? makeProviderError("MODEL_UNAVAILABLE", {
        correlationId: randomUUID(),
        sanitizedMessage: "LLM provider unavailable.",
        providerId: this.id,
        providerStatus: "construction_failed",
      });
    }

    const attempts = this.opts.maxRetries + 1;
    let lastError: ProviderError | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const correlationId = randomUUID();
      // Two parallel aborts: a wall-clock timeout AND the inner provider's
      // own response. The OpenAI SDK does not take an AbortSignal here, so
      // we race the call against a timer-driven reject.
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () =>
            reject(
              Object.assign(new Error("provider request timed out"), {
                name: "TimeoutError",
              })
            ),
          this.opts.requestTimeoutMs
        );
      });
      try {
        const completion = await Promise.race([
          inner.complete(req),
          timeoutPromise,
        ]);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.lastError = null;
        return completion;
      } catch (e) {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        lastError = classifyProviderError(e, {
          correlationId,
          providerId: this.id,
        });
        // Track the most recent provider-side error for /health.
        this.lastError = lastError;
        if (!lastError.retryable || attempt + 1 >= attempts) {
          throw lastError;
        }
        // Bounded exponential backoff: retryBase * 2^attempt.
        const backoff = this.opts.retryBaseMs * 2 ** attempt;
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    // Should be unreachable; the loop either returns or throws.
    throw lastError ?? makeProviderError("MODEL_UNAVAILABLE", {
      correlationId: randomUUID(),
      sanitizedMessage: "LLM provider did not produce a response.",
      providerId: this.id,
      providerStatus: "no_response",
    });
  }

  availability(): ProviderAvailability {
    if (this.id === "mock") {
      return {
        state: "ready",
        providerId: "mock",
        model: this.modelName,
        lastError: null,
        requestedMode: "mock",
        degraded: false,
      };
    }
    // Real provider requested. Differentiate:
    //   - MODEL_NOT_CONFIGURED → state "unconfigured" (operator must fix
    //     LLM_BASE_URL / LLM_API_KEY). Distinct from "error" so the
    //     /health response is honest and the route can return 503 with
    //     MODEL_NOT_CONFIGURED instead of MODEL_UNAVAILABLE.
    //   - any other lastError code → state "error" (call attempted, failed).
    if (this.lastError) {
      const state: ProviderState =
        this.lastError.code === "MODEL_NOT_CONFIGURED" ? "unconfigured" : "error";
      return {
        state,
        providerId: this.id,
        model: this.modelName,
        lastError: this.lastError,
        requestedMode: "openai-compatible",
        degraded: true,
      };
    }
    return {
      state: "ready",
      providerId: this.id,
      model: this.modelName,
      lastError: null,
      requestedMode: "openai-compatible",
      degraded: false,
    };
  }
}

/**
 * Return the right provider for the runtime config.
 *
 * Construction never throws. A missing / invalid LLM configuration simply
 * returns a `mock`-backed LazyResilientProvider flagged as
 * `requestedMode: "openai-compatible"` with `state: "unconfigured"`, so
 * /health can show "provider_configured: false" without crashing the API.
 */
export function getModelProvider(cfg: AppConfig): ModelProvider {
  if (cached) return cached;
  const requested = cfg.llm.provider; // "mock" | "openai-compatible"
  if (requested === "mock") {
    cached = new LazyResilientProvider({
      id: "mock",
      modelName: cfg.llm.model,
      build: () => new MockModelProvider(cfg.llm.model),
    });
    return cached;
  }

  // Real provider requested. Check both credentials are present before we
  // commit to building an OpenAI client.
  if (!cfg.llm.baseUrl || !cfg.llm.apiKey) {
    // Mark as unconfigured; degrade to mock so the dev / demo server stays
    // up. The availability snapshot tells the operator what's happening.
    cached = new LazyResilientProvider({
      id: "openai-compatible",
      modelName: cfg.llm.model,
      build: () => new MockModelProvider(cfg.llm.model),
    });
    // Force availability to unconfigured by storing a typed error.
    // We do this without calling .complete() so /health sees the right
    // state without making a network call.
    (cached as unknown as { lastError: ProviderError }).lastError =
      makeProviderError("MODEL_NOT_CONFIGURED", {
        correlationId: randomUUID(),
        sanitizedMessage:
          "LLM_PROVIDER is set to a real provider but LLM_API_KEY or LLM_BASE_URL is missing.",
        providerId: "openai-compatible",
        providerStatus: "missing_credentials",
      });
    return cached;
  }

  cached = new LazyResilientProvider({
    id: "openai-compatible",
    modelName: cfg.llm.model,
    build: () =>
      new OpenAICompatibleProvider({
        modelName: cfg.llm.model,
        baseUrl: cfg.llm.baseUrl as string,
        apiKey: cfg.llm.apiKey as string,
      }),
  });
  return cached;
}

let cached: LazyResilientProvider | null = null;

/** Test hook — reset the cached provider between specs. */
export function _resetModelProviderForTest() {
  cached = null;
}

/** Inspect the cached provider's availability (or the mock default). */
export function getProviderAvailability(cfg: AppConfig): ProviderAvailability {
  const provider = getModelProvider(cfg) as LazyResilientProvider;
  return provider.availability();
}