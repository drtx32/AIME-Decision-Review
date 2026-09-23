# AI usage & validation record — submission view

This file is a **submission-facing summary** that complements the canonical
`docs/AI_VALIDATION.md`. The canonical log records every AI-assisted
implementation, validation, and correction in chronological order; this
file groups those entries by **fixture vs real validation** so a reviewer
can quickly see what was actually exercised end-to-end against a real LLM
or real MCP, and what is still pending a credentialed run.

## Reading guide

- **Fixture** = exercised end-to-end with the in-process `mock` LLM
  provider + `*-mock.ts` MCP adapters. Deterministic, repeatable.
- **Real** = exercised end-to-end against a real `openai-compatible`
  provider with credentials, **and/or** against a live Fuyao / iFinD HTTP
  endpoint with credentials.
- **Partial** = some pieces are real and some are fixture; record both.
- **Unvalidated** = code path exists but no evidence has been recorded yet.

Every entry below must have an exact pointer back to the matching entry in
`docs/AI_VALIDATION.md` (date + section anchor). If a reviewer cannot find
the source entry, the entry here is invalid.

---

## System architecture for validation

This section pins down **where each LLM call, agent decision, and MCP
fetch happens** in the running system. Every claim in this record refers
back to one of these locations.

### Where the LLM runs

The LLM is invoked in two narrow, separate places. Both are behind the
server-side provider abstraction in `apps/api/src/providers/`:

| Location | Purpose | Default provider | Live provider | Notes |
|---|---|---|---|---|
| `apps/api/src/agents/decision-extractor.ts` | Structured extraction of one or more `DecisionCandidate` rows from a natural-language message. | `mock` | `openai-compatible` (with `LLM_API_KEY`) | **Extraction only.** Never calls MCP, never produces a `DecisionReviewResult`, never judges the decision. |
| `apps/api/src/agents/decision-review.ts` (structured-judgment layer only) | Rating, attribution status, lesson phrasing inside the bounded review lifecycle. | `mock` | `openai-compatible` | Evidence retrieval, T0 alignment, and reflection all run in our code; the LLM is consulted only for the judgment layer. OpenAI Agents SDK integration is opt-in via `runWithOpenAIAgents`. |

No other code path calls the LLM. The reflection pass
(`apps/api/src/agents/reflection.ts`) is pure code — no LLM call.

### Where `DecisionReviewAgent` runs

`DecisionReviewAgent` (single class in
`apps/api/src/agents/decision-review.ts`) is the only review state
machine. Its lifecycle, per `docs/SPEC.md` §7:

```text
created → planning → retrieving → analyzing → reflecting → completed
                                                       └──→ partial
                                                       └──→ failed
```

- **`planning`** — builds the evidence plan (see
  `apps/api/src/agents/types.ts` `buildPlan`); selects intent-driven
  MCP servers.
- **`retrieving`** — resolves adapters via the MCP registry; calls
  `fetch(intent)` on each; classifies each call as `success` / `empty` /
  `transient_error` / `permanent_error`. Never translates a failure
  into "no data".
- **`analyzing`** — T0-aligns evidence; runs the structured-judgment
  layer (LLM); produces `DecisionReviewResult`.
- **`reflecting`** — one bounded self-check
  (`apps/api/src/agents/reflection.ts`). Either passes or downgrades
  the review to `partial` / `failed`. No infinite loop.

`DecisionExtractorAgent` (`apps/api/src/agents/decision-extractor.ts`)
runs **before** `DecisionReviewAgent` and produces
`DecisionCandidate[]`. The two never overlap.

### Where Fuyao / iFinD are called

MCP servers are configured in `apps/api/src/mcp/registry.ts` and
resolved on demand. Adapters live in `apps/api/src/mcp/adapters/`:

| Adapter | When active | Failure classification |
|---|---|---|
| `MockFuyaoAdapter` (`fuyao-mock.ts`) | No `HITHINK_FINANCE_API_KEY` configured, or explicit fixture mode. | `success` / `empty` / `transient_error` / `permanent_error` — each branch is deterministic. |
| `MockIFindAdapter` (`ifind-mock.ts`) | No `IFIND_MCP_AUTHORIZATION` configured, or explicit fixture mode. | Same four outcomes. |
| `LiveMcpAdapter` (`live-mcp.ts`) | Credentials configured **and** operator-supplied `HITHINK_FINANCE_TOOL_MAP` / `IFIND_MCP_TOOL_MAP` present. | Same four outcomes; surfaces JSON-RPC errors as `transient_error` (network) or `permanent_error` (auth / schema). |

Fuyao / iFinD calls never produce fake data: a credentialed live call
that fails returns `permanent_error` (HTTP 401/403) or
`transient_error` (HTTP 5xx, timeout), and the agent downgrades the
review to `partial` accordingly.

### T0 leakage controls

T0 leakage is prevented at the architecture layer, not the prompt layer:

1. **`DecisionExtractorAgent`** returns `timePrecision: "exact" |
   "approximate" | "unknown"`. When the input contains only an
   approximate time phrase ("around March 2024"), `executedAt` is `null`
   and only `executedAtText` carries the original phrase. **The
   extractor never fabricates a precise minute from an approximate one.**
2. **`DecisionReviewAgent` alignment** uses `evidence.publishedAt`,
   **never** `evidence.retrievedAt`. The threshold is strict: `exAnte`
   means `publishedAt ≤ T0` (less a documented small tolerance for
   end-of-day boundaries); `exPost` means `publishedAt > T0`. The
   class enforces this in `alignEvidence`.
4. **Structured result** has separate fields for `decisionQuality` and
   `outcome`. `decisionQuality` is reasoned only on `exAnteEvidence`;
   `outcome` is reasoned only on `exPostEvidence`. Downstream UI cannot
   mix the two without explicit user action.
5. **Reflection pass** explicitly checks: "Did ex-post evidence leak
   into ex-ante evaluation?". A positive reflection flag downgrades the
   review to `partial`.
6. **No trusted source produces an explicit evidence gap.** Missing
   `publishedAt` on an evidence row is rejected at the alignment stage;
   the row is not silently treated as ex-ante (per `docs/SPEC.md` §9
   and `docs/TEST_PLAN.md` T03).

### Fail / degrade semantics

The system fails safely, never silently:

- **Empty result** (T04) — adapter returns `empty`; UI surfaces
  "source returned no result"; review status remains `partial` or
  `completed` with explicit gaps.
- **Transient failure** (T05) — adapter returns `transient_error`;
  bounded retry (one extra attempt); if still failing, review becomes
  `partial`.
- **Permanent failure** (T06) — adapter returns `permanent_error`;
  no retry; review becomes `partial` with the failing tool recorded.
- **Schema mismatch** — adapter returns `permanent_error`; evidence
  row rejected; not silently classified.
- **Provider outage** — same as transient failure at the provider
  boundary; the LLM call itself is treated as `transient_error` and
  bounded-retry applies.
- **Non-compliant request** (T11) — API returns HTTP 422
  `{ error: "non_compliant_request", reason: "…" }`; no review is
  created.

A `partial` review includes an explicit `uncertainties` list naming
every gap and the surface (LLM / Fuyao / iFinD / etc.) it came from.

### Hidden CoT policy

- **`<think>` blocks** produced by the LLM are stripped at the provider
  boundary (see `parseJson` in `decision-extractor.ts` and the
  analogous logic in `decision-review.ts`). They never reach the SSE
  consumer.
- **Product trace events** are the only thing streamed to the browser.
  The list is fixed at the architecture layer; the LLM cannot invent
  arbitrary new event types. See `docs/SPEC.md` §15.
- **`structuredReason: undefined`** fields in `DecisionReviewResult` are
  not exposed to the user; reasoning appears only as the explicitly
  designed `decisionQuality`, `outcome`, `attribution`, `biases`,
  `lessons`, `nextChecklist`, `uncertainties`, and `citations` fields.
- **`maxOutputTokens`** is bounded (1024 for the review layer, 4096 for
  extraction) to keep responses deterministic and avoid runaway
  generations.

### Fixture vs real credentialed validation

Every claim in this record is labelled either `Fixture` or `Real`:

- **Fixture** — exercised end-to-end with `LLM_PROVIDER=mock` and the
  `MockFuyaoAdapter` / `MockIFindAdapter`. Deterministic, repeatable.
  This is the current validation state for every `✅` entry.
- **Real** — exercised end-to-end against the live LLM (or Fuyao /
  iFinD) endpoint with credentials. **No entry is currently `Real` in
  this submission**; the section below names the code paths and the
  evidence that will unlock a `Real` label.

A `Real` label requires:

- a curl-style transcript (with `Authorization:`, `LLM_API_KEY`,
  `HITHINK_FINANCE_API_KEY`, `IFIND_MCP_AUTHORIZATION` redacted to
  `Bearer <redacted>` / `<redacted>` / `<redacted>`);
- an exact tested SHA;
- a single canonical `docs/AI_VALIDATION.md` entry pointing to the
  transcript;
- a screen capture or `docker compose ps` snapshot when relevant.

Without all four, the entry stays `⛔ Unvalidated`.

---

## Fixture validation — assembled, traceable

### Vertical slice (T01, T16, T17)

- **Date**: 2026-09-22.
- **Source entry**: `docs/AI_VALIDATION.md` → "Backend MVP vertical slice — 2026-09-22 (Local CC)" and "ELI-313 acceptance — 2026-09-22 (Oracle CC follow-up)".
- **What was exercised**: `POST /api/reviews` with `600519`, `T0=2024-03-15`,
  `LLM_PROVIDER=mock`. Review completes synchronously; status `completed`;
  evidence split into `exAnteEvidence` / `exPostEvidence`; `decisionQuality`
  and `outcome` are separate objects; tool statuses surface every adapter
  call honestly.
- **Evidence**: `bun test` 50/50 pass (auth + agent + mcp + api); curl
  `GET /health`, `POST /api/reviews`, `GET /api/reviews/:id/events`,
  `GET /api/reviews/:id/result` all green.
- **Status**: ✅ Fixture.

### T0 boundary (T02)

- **Date**: 2026-09-22.
- **Source entry**: `docs/AI_VALIDATION.md` → "ELI-313 acceptance — 2026-09-22" → "T02 boundary".
- **What was exercised**: Every `exAnte.publishedAt ≤ max 2024-03-14T00:00:00Z`
  (≤ T0 − 1d); every `exPost.publishedAt ≥ min 2024-03-29T00:00:00Z`
  (> T0 + 14d). Asserted in `apps/api/tests/agent.test.ts`.
- **Status**: ✅ Fixture.

### Non-compliant request boundary (T11)

- **Date**: 2026-09-22.
- **Source entry**: `docs/AI_VALIDATION.md` → "ELI-313 acceptance — 2026-09-22" → "T11".
- **What was exercised**: `POST /api/reviews` with `"Guaranteed 100% return in
  30 days"` returns HTTP 422 `{ error: "non_compliant_request",
  reason: "100% return" }`. Asserted in `apps/api/tests/api.test.ts`.
- **Status**: ✅ Fixture.

### Outcome-bias reasoning (T09 / T10)

- **Date**: 2026-09-22.
- **Source entry**: `docs/AI_VALIDATION.md` → "ELI-313 acceptance — 2026-09-22".
- **What was exercised**: The mock path demonstrates the schema separates
   `decisionQuality` and `outcome`, and the reflection pass flags
   outcome contamination when present.
- **Status**: ✅ Fixture (deterministic mock; no real P&L involved).

### Frontend mock-only flow (T14)

- **Date**: 2026-09-22.
- **Source entry**: `docs/AI_VALIDATION.md` → "Frontend Web Shell — 2026-09-22".
- **What was exercised**: `npm run build` passes; the in-process mock
  adapter drives Home → Running → Result without a backend.
- **Status**: ✅ Fixture.

### Compose build & smoke (subset of T19)

- **Date**: 2026-09-22.
- **Source entry**: `docs/AI_VALIDATION.md` → "Root Compose orchestration — 2026-09-22 (Oracle Codex)".
- **What was exercised**: `docker compose config` validates the service
  graph; `docker compose build` builds both images; API `/health` and
  web `/` return 200; a POST through the web `/api` proxy completes with
  ex_ante/ex_post evidence.
- **Status**: ✅ Fixture (LLM_PROVIDER=mock inside the container).

### Auth + secret hygiene (T12, T13 subset)

- **Date**: 2026-09-22.
- **Source entry**: `docs/AI_VALIDATION.md` → "Auth: Bootstrap Admin + Managed Users — 2026-09-22 (Oracle CC)" and "ELI-325 credential cleanup — 2026-09-22 (Oracle CC)".
- **What was exercised**: 50/50 (then 54/54) bun:test cases; secret
  scan of `apps/api/src`, `src/`, `docker-compose.yml`, `.env.example`
  finds zero populated credential literals; `docker compose config`
  errors out correctly when `INITIAL_ADMIN_PASSWORD` is missing.
- **Status**: ✅ Fixture (no real credential ever loaded; no client-side
  secret ever rendered).

### Submission skeleton preflight (NEW — this issue)

- **Date**: 2026-09-23.
- **Source entry**: `docs/AI_VALIDATION.md` → "ELI-340 submission skeleton — 2026-09-23 (Local CC)" (will be added by the PR).
- **What was exercised**: `scripts/preflight.mjs` rejects missing
  artefacts, scans for forbidden paths, scans file contents for
  credential patterns, records git SHA + dirty state. Tested by
  `tests/preflight/preflight.test.ts`.
- **Status**: ✅ Fixture.

---

## Real validation — UNRESOLVED

Every entry below is **explicitly NOT claimed** until a human records
evidence. Do not infer or fabricate.

### Real LLM call (openai-compatible / MiniMax)

- **Source code path**: `apps/api/src/providers/openai-compatible.ts`.
- **Status**: ⛔ Unvalidated. The provider is plumbed; no
  credentialed run has been recorded in `docs/AI_VALIDATION.md`.
- **Required evidence**: a `POST /api/reviews` against
  `LLM_PROVIDER=openai-compatible` + `LLM_BASE_URL` + `LLM_API_KEY` +
  `LLM_MODEL` with curl output (secrets redacted) and a screenshot of
  the Result screen.
- **Owner**: not assigned in this issue.

### Real Fuyao MCP call

- **Source code path**: `apps/api/src/mcp/adapters/fuyao-mock.ts`
  (HTTP branch).
- **Status**: ⛔ Unvalidated. Server list configured; the branch returns
  `permanent_error` until a credentialed call is recorded.
- **Required evidence**: a server-by-server check (one of the six Fuyao
  capabilities, e.g. `a-share`) returning `success` with non-empty
  evidence and source/timestamp provenance preserved.

### Real iFinD MCP call

- **Source code path**: `apps/api/src/mcp/adapters/ifind-mock.ts`
  (HTTP branch).
- **Status**: ⛔ Unvalidated.
- **Required evidence**: a server-by-server check (one of the eleven
  iFinD capabilities, e.g. `stock`) returning `success` with non-empty
  evidence and source/timestamp provenance preserved.

### Real production deployment

- **Source code path**: `docker-compose.yml` + `docs/DEPLOYMENT.md`.
- **Status**: ⛔ Unvalidated in this issue (explicitly out of scope per
  the issue description).
- **Required evidence**: `submission/DEPLOYMENT_EVIDENCE.md` populated
  from `submission/DEPLOYMENT_EVIDENCE.template.md` with curl output,
  container image tags, git SHA, timestamp, and row count snapshot.

---

## Submission reviewer checklist

Before judging the submission, confirm:

1. Every ✅ entry above has a pointer into `docs/AI_VALIDATION.md` and that
   entry actually exists.
2. No ✅ entry hides a fixture-only validation under a "real" label.
3. Every ⛔ entry is **explicit** and not silently downgraded.
4. The submission ZIP excludes all files listed in `submission/MANIFEST.md`
   §2.1 and contains none of the patterns in §2.2.
5. `submission/DEPLOYMENT_EVIDENCE.md` (if present) has no empty lines.