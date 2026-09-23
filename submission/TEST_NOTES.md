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

`LLM_PROVIDER=mock` is the **default** and the only path exercised end-to-end
by `bun test`. The `openai-compatible` provider is plumbed but a real
`LLM_API_KEY` call has not been recorded in `docs/AI_VALIDATION.md`.

### Mock-only MCP path

All six Fuyao servers and all eleven iFinD servers are configured in the
registry, but the adapters (`apps/api/src/mcp/adapters/*-mock.ts`) return
deterministic fixtures. The HTTP branches for Fuyao and iFinD return
`permanent_error` when credentials are configured, so the review API
degrades to a documented `partial` status with no fabricated data.

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