/**
 * Settings / usage / model-capability contract types.
 *
 * ELI-360 — the AIME backend no longer accepts, stores, logs, echoes,
 * or fingerprints a user-supplied API key. The `ModelSettingsPayload`
 * type that used to carry `hasApiKey / apiKeyFingerprint` is gone.
 * Browser-local BYOK lives entirely in the frontend (IndexedDB).
 */

export type SettingsProvider = "openai-compatible" | "mock";

/**
 * Public shape of GET /api/usage.
 *
 * `allowance` may be `null` when the operator has not configured a
 * limit — we never fabricate a provider quota we cannot verify. The
 * `remaining.known` boolean distinguishes "no events yet so we don't
 * know" from "configured allowance minus consumed". `resetAt` is the
 * ISO timestamp at which the period rolls over; `period` itself carries
 * the start/end of the current window so the UI can show "X% of period
 * remaining".
 */
export interface UsagePayload {
  period: {
    start: string;
    end: string;
    resetAt: string;
  };
  allowance: {
    tokens: number | null;
    source: "configured" | "unknown";
  };
  consumed: {
    tokens: number;
    lastUpdatedAt: string | null;
  };
  remaining: {
    tokens: number | null;
    known: boolean;
  };
  /** Most recent usage events — bounded to keep responses compact. */
  recent: UsageEventSummary[];
}

export interface UsageEventSummary {
  reviewId: string | null;
  kind: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  at: string;
}

/**
 * Public shape of GET /api/models/capabilities. The frontend uses this
 * to populate the model picker in the Settings UI and to decide whether
 * to enable image-attachment affordances — vision metadata is only marked
 * `verified: true` when an actual capability check has confirmed it.
 */
export interface ModelCapabilitiesPayload {
  providers: ModelProviderCapabilities[];
  notes: string;
}

export interface ModelProviderCapabilities {
  id: SettingsProvider;
  displayName: string;
  /** True if this provider can be configured at runtime. After ELI-360
   *  this is informational only — configuration happens in the browser,
   *  not via this server. */
  configurable: boolean;
  models: ModelCapabilityRow[];
}

export interface ModelCapabilityRow {
  id: string;
  displayName: string;
  vision: boolean;
  /**
   * Where the vision flag came from:
   *   - "verified" — confirmed against the provider's published capability matrix.
   *   - "static"   — assumed false because no verification has been run.
   *   - "unknown"  — we could not verify; consumers should NOT enable vision UI.
   */
  visionSource: "verified" | "static" | "unknown";
  notes?: string;
}