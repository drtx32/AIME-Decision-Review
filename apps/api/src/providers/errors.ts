/**
 * Stable, machine-readable provider error contract.
 *
 * The application boundary (HTTP route → frontend) only sees these codes —
 * raw provider errors and OpenAI SDK errors are caught, classified, and
 * sanitized before they ever leave this module.
 *
 * SECURITY: `sanitizedMessage` MUST NOT include the API key, Authorization
 * header, or full request body. It may include provider name, status code,
 * error class name (e.g. "401 Unauthorized"), and the underlying provider
 * error class. Anyone reading the field should still need no secret to
 * understand it.
 */

export type ProviderErrorCode =
  /** LLM_PROVIDER unset, or set to a non-mock provider with missing key/URL. */
  | "MODEL_NOT_CONFIGURED"
  /** Provider is configured but the call could not be made (network/5xx/timeout/connect). */
  | "MODEL_UNAVAILABLE"
  /** Provider rejected the credentials (401/403). Configuration is wrong. */
  | "MODEL_AUTH_FAILED"
  /** Provider rate-limited the caller (429). Retry later. */
  | "MODEL_RATE_LIMITED"
  /** Provider call timed out before producing a usable response. */
  | "MODEL_TIMEOUT";

export type ProviderErrorKind = "configuration" | "transient" | "auth" | "rate_limit" | "timeout";

export interface ProviderError {
  code: ProviderErrorCode;
  kind: ProviderErrorKind;
  /** Stable for tracing. Never contains the request body or any secret. */
  correlationId: string;
  /** Safe-for-logs summary. Never contains secrets or full Authorization headers. */
  sanitizedMessage: string;
  /** HTTP status the API will surface for this error class. */
  httpStatus: 401 | 403 | 429 | 502 | 503 | 504;
  /** Whether the caller may retry without changing configuration. */
  retryable: boolean;
  /** Provider class for diagnostics — e.g. "openai-compatible", "mock". */
  providerId: string | null;
  /** Sanitized provider-side status / class (e.g. "401", "ETIMEDOUT"). No bodies. */
  providerStatus: string | null;
}

const HTTP_STATUS_FOR: Record<ProviderErrorCode, ProviderError["httpStatus"]> = {
  MODEL_NOT_CONFIGURED: 503,
  MODEL_UNAVAILABLE: 503,
  MODEL_AUTH_FAILED: 502,
  MODEL_RATE_LIMITED: 503,
  MODEL_TIMEOUT: 504,
};

const RETRYABLE: Record<ProviderErrorCode, boolean> = {
  MODEL_NOT_CONFIGURED: false, // operator must fix; not a transient fault.
  MODEL_UNAVAILABLE: true,
  MODEL_AUTH_FAILED: false,
  MODEL_RATE_LIMITED: true,
  MODEL_TIMEOUT: true,
};

/** Build a ProviderError from a classified code. */
export function makeProviderError(
  code: ProviderErrorCode,
  opts: {
    correlationId: string;
    sanitizedMessage: string;
    providerId: string | null;
    providerStatus: string | null;
  }
): ProviderError {
  return {
    code,
    kind: kindFor(code),
    correlationId: opts.correlationId,
    sanitizedMessage: opts.sanitizedMessage,
    httpStatus: HTTP_STATUS_FOR[code],
    retryable: RETRYABLE[code],
    providerId: opts.providerId,
    providerStatus: opts.providerStatus,
  };
}

function kindFor(code: ProviderErrorCode): ProviderErrorKind {
  switch (code) {
    case "MODEL_NOT_CONFIGURED":
      return "configuration";
    case "MODEL_AUTH_FAILED":
      return "auth";
    case "MODEL_RATE_LIMITED":
      return "rate_limit";
    case "MODEL_TIMEOUT":
      return "timeout";
    case "MODEL_UNAVAILABLE":
      return "transient";
  }
}

/** Classify a raw OpenAI / fetch error into a stable ProviderError. */
export function classifyProviderError(
  e: unknown,
  ctx: { correlationId: string; providerId: string | null }
): ProviderError {
  const status = extractStatus(e);
  const cls = extractErrorClass(e);

  if (status === 401 || status === 403) {
    return makeProviderError("MODEL_AUTH_FAILED", {
      correlationId: ctx.correlationId,
      sanitizedMessage: "LLM provider rejected the configured credentials.",
      providerId: ctx.providerId,
      providerStatus: String(status),
    });
  }
  if (status === 429) {
    return makeProviderError("MODEL_RATE_LIMITED", {
      correlationId: ctx.correlationId,
      sanitizedMessage: "LLM provider rate-limited the request.",
      providerId: ctx.providerId,
      providerStatus: String(status),
    });
  }
  if (status !== null && status >= 500) {
    return makeProviderError("MODEL_UNAVAILABLE", {
      correlationId: ctx.correlationId,
      sanitizedMessage: `LLM provider returned ${status}.`,
      providerId: ctx.providerId,
      providerStatus: String(status),
    });
  }
  if (cls === "AbortError" || cls === "TimeoutError") {
    return makeProviderError("MODEL_TIMEOUT", {
      correlationId: ctx.correlationId,
      sanitizedMessage: "LLM provider did not respond in time.",
      providerId: ctx.providerId,
      providerStatus: cls,
    });
  }
  // Network/connect errors fall through to here.
  return makeProviderError("MODEL_UNAVAILABLE", {
    correlationId: ctx.correlationId,
    sanitizedMessage: `LLM provider request failed (${cls ?? "unknown"}).`,
    providerId: ctx.providerId,
    providerStatus: cls,
  });
}

function extractStatus(e: unknown): number | null {
  if (!e || typeof e !== "object") return null;
  const anyE = e as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  for (const candidate of [anyE.status, anyE.statusCode, anyE.response?.status]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return null;
}

function extractErrorClass(e: unknown): string | null {
  if (!e || typeof e !== "object") return null;
  const anyE = e as { name?: unknown; code?: unknown };
  if (typeof anyE.name === "string" && anyE.name.length > 0) return anyE.name;
  if (typeof anyE.code === "string" && anyE.code.length > 0) return anyE.code;
  return null;
}