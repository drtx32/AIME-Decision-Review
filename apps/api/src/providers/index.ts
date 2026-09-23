/**
 * Thin LLM provider abstraction.
 *
 * v0.1 implements a single provider at a time (no multi-provider routing). The
 * abstraction exists so the MVP can run without real credentials via the
 * explicit mock provider, and a real OpenAI-compatible endpoint (MiniMax,
 * OpenAI, etc.) can be slotted in by changing LLM_PROVIDER.
 *
 * The provider returns structured JSON — never free-form chat — so the agent
 * state machine can validate every claim before it lands in the result.
 *
 * Resilience (ELI-326):
 *   - `getModelProvider` never throws at import/startup, even if LLM env is
 *     missing or invalid. When a real provider is requested but credentials
 *     are absent it returns a `MissingCredentialsProvider` whose `complete()`
 *     is wired to throw a typed `MODEL_NOT_CONFIGURED` — there is NO silent
 *     fallback to a mock-backed implementation, so no code path (route
 *     pre-flight, agent, extractor, follow-up) can ever receive a mock
 *     completion while the operator expects a real provider.
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
  modelName?: string;
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

export interface ProviderCapabilities {
  text: true;
  images: boolean;
}

export interface ModelProvider {
  readonly id: string;
  readonly modelName: string;
  readonly capabilities?: ProviderCapabilities;
  complete(req: LLMCompletionRequest): Promise<LLMCompletion>;
  /**
   * Legacy test-double compatibility only. Runtime providers must expose
   * availability(); production readiness never relies on this flag.
   */
  readonly configured?: boolean;
  /**
   * Source of truth for `/health` and the review pre-flight. Implementations
   * MUST surface the actual readiness without ever faking a `ready` state
   * when credentials are missing or the live call has not succeeded.
   */
  availability?: () => ProviderAvailability;
  probeImages?: () => Promise<{ available: boolean; reason?: string }>;
}

export type ProviderState = "ready" | "unconfigured" | "error";

export interface ProviderAvailability {
  state: ProviderState;
  providerId: string | null;
  model: string | null;
  /** Set when state === "error". Stable for diagnostics. */
  lastError: ProviderError | null;
  /**
   * When the operator wanted `requestedMode` but the runtime cannot honour
   * it (e.g. a real provider was requested but credentials are missing, or
   * the live call failed), this flag tells the operator that the requested
   * mode is not actually live. `degraded: true` means "unavailable / not
   * running with the requested provider"; it NEVER means "running on a
   * mock backing". Production code paths must observe `state` and treat
   * `degraded: true` as a controlled failure.
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
 * Construction never throws. A missing / invalid LLM configuration returns
 * a `MissingCredentialsProvider` — a thin ModelProvider whose `complete()`
 * is wired to throw typed `MODEL_NOT_CONFIGURED`. There is NO silent
 * fallback to a mock-backed implementation, so the route pre-flight,
 * `agent.run()`, and any future code path that talks directly to the
 * provider all observe the same controlled failure. `/health` still
 * reports `state: "unconfigured"` so the API stays a healthy process
 * while the operator fixes the env.
 *
 * No process-level singleton: each call builds a fresh provider for the
 * supplied cfg. This is required for test isolation — bun:test runs all
 * spec files in one process, so a cached singleton would let an earlier
 * test (e.g. `agent.test.ts` with `provider: "mock"`) leak its provider
 * into a later test (`resilience.test.ts` with `provider:
 * "openai-compatible"`), causing the no-LLM /health case to falsely
 * report `provider_configured: true`. Construction is cheap (the OpenAI
 * client is built lazily on first `complete()`), so the cost of
 * rebuilding is negligible compared to the isolation bug it fixes.
 */
export function getModelProvider(cfg: AppConfig): ModelProvider {
  const requested = cfg.llm.provider; // "mock" | "openai-compatible"
  if (requested === "mock") {
    return new LazyResilientProvider({
      id: "mock",
      modelName: cfg.llm.model,
      build: () => new MockModelProvider(cfg.llm.model),
    });
  }

  // Real provider requested. Check both credentials are present before we
  // commit to building an OpenAI client. When creds are missing we return
  // a dedicated MissingCredentialsProvider whose complete() throws
  // MODEL_NOT_CONFIGURED — never a mock-backed wrapper. This is the
  // canonical contract for ELI-326: production real-provider mode has no
  // executable silent mock fallback.
  if (!cfg.llm.baseUrl || !cfg.llm.apiKey) {
    return new MissingCredentialsProvider({
      id: "openai-compatible",
      modelName: cfg.llm.model,
    });
  }

  return new LazyResilientProvider({
    id: "openai-compatible",
    modelName: cfg.llm.model,
    build: () =>
      new OpenAICompatibleProvider({
        modelName: cfg.llm.model,
        baseUrl: cfg.llm.baseUrl as string,
        apiKey: cfg.llm.apiKey as string,
      }),
  });
}

/**
 * Real provider requested, but credentials are missing.
 *
 * `complete()` is wired to throw a typed `MODEL_NOT_CONFIGURED` error
 * directly — there is no inner provider, no mock backing, and no
 * network call. This guarantees that any code path which talks to the
 * provider (route pre-flight, agent, future extractor / follow-up
 * modules) observes the same controlled failure when the operator
 * forgot to supply `LLM_BASE_URL` / `LLM_API_KEY`. The previous
 * implementation smuggled a `MockModelProvider` behind a private-field
 * cast; that leaked a mock completion into any direct caller of
 * `complete()` while pretending to be unconfigured.
 *
 * `/health` and the route pre-flight continue to observe
 * `state: "unconfigured"` via `availability()` — the missing provider
 * is reported honestly without ever producing a real response.
 */
export class MissingCredentialsProvider implements ModelProvider {
  readonly id: string;
  readonly modelName: string;
  // One stable typed error for the lifetime of this provider instance —
  // shared by `complete()` rejections and `availability().lastError` so
  // operators observe a single, deterministic failure record across
  // `/health`, the route pre-flight, and any direct caller.
  private readonly notConfiguredError: ProviderError;

  constructor(opts: { id: string; modelName: string }) {
    this.id = opts.id;
    this.modelName = opts.modelName;
    this.notConfiguredError = makeProviderError("MODEL_NOT_CONFIGURED", {
      correlationId: randomUUID(),
      sanitizedMessage:
        "LLM_PROVIDER is set to a real provider but LLM_API_KEY or LLM_BASE_URL is missing.",
      providerId: this.id,
      providerStatus: "missing_credentials",
    });
  }

  complete(_req: LLMCompletionRequest): Promise<LLMCompletion> {
    // Throw synchronously so the rejection reason is observable in any
    // stack trace; the returned promise rejects with a typed ProviderError.
    return Promise.reject(this.notConfiguredError);
  }

  availability(): ProviderAvailability {
    return {
      state: "unconfigured",
      providerId: this.id,
      model: this.modelName,
      lastError: this.notConfiguredError,
      requestedMode: "openai-compatible",
      degraded: true,
    };
  }
}

/**
 * Test hook — kept for API stability; this module no longer caches the
 * provider across calls, so the function is a no-op. Existing callers
 * that invoke it continue to work without modification.
 */
export function _resetModelProviderForTest() {
  // No-op: see getModelProvider() comment above for rationale.
}

/**
 * Inspect the provider's availability for the supplied cfg.
 *
 * Both `LazyResilientProvider` and `MissingCredentialsProvider` implement
 * `availability()` directly on the `ModelProvider` interface, so no cast
 * is needed. The returned snapshot is the source of truth for `/health`
 * and the review-creation pre-flight.
 */
export function getProviderAvailability(cfg: AppConfig): ProviderAvailability {
  const provider = getModelProvider(cfg);
  return provider.availability!();
}
