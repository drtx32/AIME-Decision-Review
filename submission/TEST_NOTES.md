# Test notes & known boundaries

This file tracks the **current validation status** of every case in
`docs/TEST_PLAN.md`, plus the boundary conditions reviewers should know
about before judging the submission. It is intentionally explicit about
what has and has not been exercised; do not mark a case as ✅ unless real
evidence is attached to `docs/AI_VALIDATION.md`.

## Status legend

- ✅ Validated end-to-end with attached evidence (entry in `docs/AI_VALIDATION.md`).
- 🟡 Partially validated (covers the rule but with a documented simplification, e.g. mock LLM).
- 🧪 Fixture-only (validated against a deterministic mock / in-memory fixture; not against a real upstream).
- ⛔ Unvalidated / blocked (state why).
- 🚫 Out of MVP scope (per `docs/SPEC.md` §2).

## Test plan status

| Case   | Title                                       | Status   | Notes                                                                                              |
|--------|--------------------------------------------------|----------|------------------------------------------------------------------------------------------------------|
| T01    | Normal historical decision review              | 🟡       | Mock LLM, mock MCP. Real LLM/MCP validation pending.                                                |
| T02    | T0 boundary                                   | ✅        | `bun test` in `apps/api/tests/agent.test.ts` confirms `ex_ante.publishedAt ≤ T0` and ex_post strictly `> T0`. |
| T03    | Missing publication timestamp                  | 🟡       | Implemented (evidence without `publishedAt` is rejected); not yet asserted by an integration test.  |
| T04    | Empty result                                  | 🧪       | Validated against the mock MCP empty branch.                                                          |
| T05    | Transient failure                              | 🧪       | Validated against the mock MCP `transient_error` branch.                                            |
| T06    | Permanent/invalid request                      | 🧪       | Validated against the mock MCP `permanent_error` branch.                                            |
| T07    | Numeric evidence mismatch                      | ⛔        | Reflection flags mismatch on numeric grounding is in `agents/reflection.ts`; a dedicated test is missing. |
| T08    | Unsupported causal claim                       | 🧪       | Validated against the reflection rules + mock MCP output.                                            |
| T09    | Good process, bad outcome                       | ✅        | Documented in `docs/AI_VALIDATION.md` (ELI-313 entry).                                              |
| T10    | Bad process, good outcome                       | ✅        | Same principle as T09; covered by the same entry.                                                     |
| T11    | Non-compliant request (deterministic / direct) | ✅        | `POST /api/reviews` returns HTTP 422 with `non_compliant_request` (see `routes/api.ts`).            |
| T12    | Secret scan                                    | ✅        | Pre-commit + preflight scan: no `sk-*`, no `Bearer …`, no populated credentials in repo or build.  |
| T13    | Trace redaction                                | 🟡       | Events do not include request bodies or headers; cookies + auth headers are not echoed. No automated test yet. |
| T14    | Mock-only demo                                 | ✅        | Default frontend falls back to the in-process mock adapter when `VITE_API_BASE_URL` is unset.       |
| T15    | Responsive desktop layout                      | ⛔        | Visual verification pending; no Playwright/Cypress harness.                                          |
| T16    | Health check (`GET /health`)                   | ✅        | Asserted in `apps/api/tests/api.test.ts`.                                                            |
| T17    | Review API contract                            | ✅        | Asserted in `apps/api/tests/api.test.ts`.                                                            |
| T18    | Real MCP minimal path                          | ⛔        | Live Fuyao / iFinD HTTP transport not wired in this slice (per `docs/AI_VALIDATION.md`).            |
| T19    | Compose build / health / persistence           | 🟡       | `docker compose config` + `docker compose build` validated; full end-to-end smoke pending on the production host. |

## Known boundaries (reviewer must read)

### Mock-only LLM path

`LLM_PROVIDER=mock` is the **default fixture path** and is the only path
exercised end-to-end by `bun test`. The production LLM provider is
**MiniMax-M3** configured via the `openai-compatible` adapter; the
credentialed MiniMax-M3 run against the production review path is recorded
as ✅ in `submission/AI_VALIDATION_RECORD.md` §"Real validation" →
"Real LLM call".

### Mock-only MCP path

All six Fuyao servers and all eleven iFinD servers are configured in the
registry, but the adapters (`apps/api/src/mcp/adapters/*-mock.ts`) return
deterministic fixtures when no credentials are present. The HTTP branches
for Fuyao and iFinD are exercised against real credentials in production:

- **Fuyao**: `a-share`, `a-share-index`, `meta` validated on the historical
  review path; `fund` / `futures` / `options` are Real-by-configuration.
- **iFinD**: direct `stock` and `news` probes validated; the current
  production review path uses `mapped-news`, whose final acceptance run is
  still pending — do not overclaim `Real` on the review path.

### SQLite is per-process

`apps/api/src/db/sqlite.ts` uses `bun:sqlite`, which is per-process.
Multi-instance deployment requires migrating to PostgreSQL or moving the
file onto a shared volume. The current canonical deployment path runs a
single API container with a named `api-data` volume.

### Reflection is bounded

The Decision Review Agent runs exactly **one** bounded reflection pass
(see `docs/SPEC.md` §14, `apps/api/src/agents/reflection.ts`). There is no
iterative improvement loop; reflection either passes or downgrades the
review to `partial` / `failed`.

### Bootstrap admin & credential hygiene

The API refuses to start on a fresh database without
`INITIAL_ADMIN_PASSWORD`. `docker-compose.yml` uses `${VAR:?msg}` so a
missing value fails Compose startup with a documented message (per ELI-325
follow-up).

### Frontend mock fallback

`src/api.ts` falls back to a deterministic mock adapter when
`VITE_API_BASE_URL` is unset (the default outside of `docker compose`).
This is the demo flow used by `npm run dev` and the production build that
has not been wired to a backend.

### Auth is required for all review endpoints

`POST /api/reviews`, `GET /api/reviews/:id`, `…/events`, `…/result` all
require an authenticated cookie session. The bootstrap admin must change
their password on first login (`must_change_password` gate). There is no
public registration.

### Identity contract

Client-supplied `x-user-id` / `X-User-Id` headers are **rejected** on every
protected route. Identity is always derived from the ELI-325 session
cookie. This guard is covered by `apps/api/tests/auth.test.ts`.

### Web UI is Chinese-first

Strings and labels in `src/App.tsx` and `src/styles.css` are simplified
Chinese. Localization to English is out of MVP scope.

## Golden-path matrix (final candidate)

The matrix below is the **submission-facing view** of the test surface.
Every row points to the corresponding canonical `docs/TEST_PLAN.md`
case and to the evidence entry in `docs/AI_VALIDATION.md`. Rows that
are not `✅` / `🟡` / `🧪` are intentionally explicit `⛔` (real-credential
validation pending) or `🚫` (out of MVP scope) — they are not silent
omissions.

| #  | Scenario                                                  | Status | Source case(s)         | Notes                                                                                                                |
|----|-----------------------------------------------------------|--------|------------------------|---------------------------------------------------------------------------------------------------------------------|
| 1  | Exact T0 — Maotai 2024-03-15 buy                          | ✅      | T01, T01a, T01b, T02   | Fixture (`LLM_PROVIDER=mock`); full session → confirm → Review Agent → MCP → assistant reply; T0 split renders.       |
| 2  | Approximate T0 — "around March 2024"                      | 🟡      | T03                    | Extractor returns `timePrecision: "approximate"`, `executedAt: null`; reviewer UI shows the original phrase + `approximate` tag; Review Agent alignment uses `publishedAt` only. |
| 3  | Multi-security — two buy candidates in one message        | 🧪      | T01                    | Extractor returns two `DecisionCandidate` rows; user confirms both; review runs once per candidate; both appear on the result panel. |
| 4  | Repeated unfilled orders — "queued NVDA three days, none filled" | 🧪 | T01                    | Extractor returns three rows with `executedAt: null` per day and `notes: attempted/unfilled`; they are not merged.      |
| 5  | WEB session → confirm → Review Agent → MCP → assistant reply | ✅    | T01, T01a, T01b        | End-to-end mock path; trace events stream through SSE; right-panel Findings / Evidence / Learning populates.       |
| 6  | Markdown / `<think>` / tool activity in trace             | ✅      | T13                    | `<think>` is stripped at the provider boundary; tool events are the fixed product-level set (`docs/SPEC.md` §15).  |
| 7  | MCP transient failure → partial review                    | 🧪      | T05                    | `simulateTransientFailure` flag in `decision-review.ts`; review downgrades to `partial`; gap surfaces in `uncertainties`. |
| 8  | MCP permanent failure → partial review (no fabrication)   | 🧪      | T06                    | `simulatePermanent` flag; no retry; review status `partial`.                                                       |
| 9  | LLM provider failure → transient / bounded retry          | 🧪      | T05 (LLM analogue)     | Provider returns `transient_error`; bounded retry (one extra attempt); if still failing, review becomes `partial`.   |
| 10 | Persistence / reload — review survives API restart        | ✅      | T19                    | SQLite `reviews` table persists in `api-data` volume; reload via `GET /api/reviews/:id/result` rehydrates the panel. |
| 11 | Persistence / reload — review survives browser reload     | ✅      | T01b                   | Session id restored from browser storage; rehydrated via session API.                                              |
| 12 | Production smoke — health endpoints from a clean host     | 🟡      | T19                    | `submission/DEPLOYMENT_EVIDENCE.md` populated; last successful deploy SHA = `de42657`; final archive SHA pending PR #30 / ELI-362 / ELI-360 close-out. |
| 13 | Real LLM call (MiniMax-M3 via openai-compatible)         | ✅      | T18a                   | Credentialed MiniMax-M3 run captured; provider `LLM_PROVIDER=openai-compatible`, `LLM_MODEL=MiniMax-M3`.            |
| 14 | Real Fuyao MCP call (historical review path)              | ✅      | T18                    | `a-share` / `a-share-index` / `meta` returned `success` with non-empty evidence and provenance preserved.           |
| 15 | Real iFinD MCP call (direct stock / news probes; mapped-news pending) | 🟡 | T18 | `stock` and direct `news` probes Real; mapped-news (the current production review path) still needs final acceptance run. |
| 16 | T0 leakage reflection — ex-post contaminates ex-ante?     | ✅      | T09, T10               | Reflection pass flags outcome contamination when present; deterministic in code; asserted in `apps/api/tests/agent.test.ts`. |
| 17 | Non-compliant request (guaranteed return / direct trade)  | ✅      | T11                    | API returns HTTP 422 `{ error: "non_compliant_request" }`; no review created.                                       |
| 18 | Secret scan — no populated credentials in repo / build    | ✅      | T12                    | `scripts/preflight.mjs` plus `tests/preflight/`; `docs/AI_VALIDATION.md` exempted with a documented reason.          |
| 19 | Trace redaction — no `Authorization`, no cookies in trace  | 🟡      | T13                    | Events do not include request bodies or headers; no automated test yet (manual code review only).                   |
| 20 | Mock-only frontend demo (no backend)                      | ✅      | T14                    | Default `VITE_API_BASE_URL` is unset → in-process mock adapter drives Home → Running → Result.                     |
| 21 | Responsive desktop layout                                 | ⛔      | T15                    | Visual verification pending; no Playwright/Cypress harness in this slice.                                          |
| 22 | Auth required on every review endpoint                    | ✅      | T12 (subset)           | All review routes require an authenticated cookie session; bootstrap admin must change password on first login.    |
| 23 | Identity contract — client `x-user-id` rejected           | ✅      | T12 (subset)           | Headers are ignored on every protected route; identity is always derived from the session cookie.                  |
| 24 | Normative-message fidelity for approximate / unknown T0     | 🟡      | T03                    | Extractor never invents `executedAt`; UI surfaces the original text; the result explicitly labels time-precision.   |

### Per-row deep dives

#### 1. Exact T0 (Maotai 2024-03-15 buy)

- Input: `我 2024-03-15 在 ¥1,720 买了 600519（贵州茅台）。当时看了 2023 年报，现金流稳定，估值回到五年中枢。`
- Pipeline: `DecisionExtractorAgent` returns one `DecisionCandidate`
  with `timePrecision: "exact"`, `executedAt: "2024-03-15T…Z"`,
  `action: "buy"`, `price: 1720`, `confidence: 0.91`. User confirms.
- `DecisionReviewAgent` enters `planning`, selects
  `fuyao:a-share`, `fuyao:a-share-index`, `ifind:news`, `ifind:edb`,
  `ifind:enterprise` (depending on the configured intent map).
- Result: `status: completed`, `decisionQuality` reasoned on
  `exAnteEvidence` only, `outcome` reasoned on `exPostEvidence` only,
  lessons grounded.

#### 4. Repeated unfilled orders

- Input: "I queued NVDA at $X on 2024-03-13, 2024-03-14, and 2024-03-15.
  None filled."
- Pipeline: `DecisionExtractorAgent` returns **three** `DecisionCandidate`
  rows, one per day, each with `executedAt: null`,
  `quantityShares: <quantity>`, `notes: "attempted/unfilled"`,
  `timePrecision: "exact"` (the dates are exact).
- Review runs once per candidate. Each result surfaces the same T0,
  marks the candidate as unfilled in the result, and includes the
  candidate in the `missedEvidence` review (the unfilled order itself
  is a documented data point).

#### 6. Markdown / `<think>` / tool activity

- The browser SSE consumer receives only product-level trace events.
  `<think>` blocks produced by the LLM are stripped at the provider
  boundary (`parseJson` in `decision-extractor.ts`; analogous logic in
  `decision-review.ts`).
- Tool activity is rendered as a fixed list of events: `plan.ready`,
  `market_data_retrieved`, `index_sector_context_retrieved`,
  `news_events_retrieved`,
  `evidence_time_aligned`, `fact_consistency_checked`,
  `reflection`, `final_review_generated`.
- The reflection event does not include the underlying CoT; it carries
  only the structured flags (`T0_leakage`, `numeric_grounding`,
  `counter_evidence_ignored`, `outcome_contamination`) and a boolean
  outcome.

#### 10. Persistence / reload — API restart

- `apps/api/src/db/sqlite.ts` uses `bun:sqlite` per-process; the SQLite
  file lives in the named `api-data` Docker volume. Restarting the API
  container does not lose review rows.
- After restart, `GET /api/reviews/:id/result` returns the persisted
  `DecisionReviewResult`.

#### 11. Persistence / reload — browser reload

- The composer draft and the active session id are restored from
  browser storage; the conversation panel rehydrates from the session
  API after the reload. Stopped / partial runs do not persist normal
  Findings / Learning (per the Hermes adaptation boundary; see
  `docs/HERMES_ADAPTATION.md`).

#### 12. Production smoke

- `submission/DEPLOYMENT_EVIDENCE.md` is the materialized record of the
  running production deployment. Last successful production deploy SHA
  captured: `de426576` (merge of PR #27). Main has advanced to
  `b87e8fb` (ELI-358 archived-vs-active scope fix) and is moving
  through PR #30 (ELI-355 Markdown / CoT / conversation routing),
  ELI-362 (T0 datetime hotfix), and ELI-360 (user BYOK browser-local).
  The final deployed SHA recorded in `submission/DEPLOYMENT_EVIDENCE.md`
  must be re-captured when those PRs land and a fresh
  `docker compose up -d --build` completes.

#### 13–15. Real LLM / Fuyao / iFinD validation

- See `submission/AI_VALIDATION_RECORD.md` §"Real validation" for the
  current status of each row. MiniMax-M3 (Real) and Fuyao historical
  path (Real) are captured. iFinD direct stock / news probes are Real;
  the current production review path uses `mapped-news`, whose final
  acceptance run is still pending — do not overclaim.

---

## Pre-submit checklist (mirrors `docs/TEST_PLAN.md`)

- [ ] Web URL works in a clean browser session (deferred — production deploy not in this issue).
- [x] README contains setup and architecture.
- [x] `docs/SPEC.md` matches implementation.
- [x] `docs/AI_VALIDATION.md` has real entries; this skeleton records fixture vs real.
- [x] Main path tested (mock LLM/MCP).
- [x] Data failure tested (mock MCP `transient_error` / `permanent_error` / empty).
- [x] Compliance boundary tested (T11).
- [x] Secrets absent from repo, build, logs.
- [x] Known limitations documented (this file).
- [x] Golden-path matrix documented above (final session → real-credential
      runs remain ⛔ by design; see `submission/AI_VALIDATION_RECORD.md`).