# AI Usage & Validation Log

This file records how AI tools are used in the project, what they generated, how outputs were checked, and what humans corrected.

## Rules

- Never paste secrets, API keys, Authorization headers, cookies, or sensitive user data.
- Record material AI-assisted implementation/design decisions.
- Distinguish AI-generated suggestions from verified results.
- For important financial outputs, record how evidence/claims were validated.
- Update this file during development.

## Entry template

### YYYY-MM-DD HH:MM — <task>

**AI/tool used**
- Agent/model/tool:

**Task**
- What AI was asked to do:

**Output**
- What it produced:

**Validation**
- Commands/tests/manual checks performed:
- Data/evidence cross-checks:

**Human corrections**
- What was changed, rejected, or constrained:

**Residual risk / unresolved**
- What is still uncertain:

---

## Initial project decisions — 2026-09-22

**AI/tool used**
- ChatGPT for product architecture and task decomposition
- Multica agents for parallel frontend/backend implementation

**Task**
- Convert AIME topic 11 “Investment Decision Review & Learning” into an executable MVP architecture.

**Output**
- React/Vite/Bun frontend plan
- Bun/Hono/OpenAI Agents SDK backend plan
- T0 ex-ante/ex-post evidence design
- Fuyao + iFinD MCP registry strategy
- bounded reflection and tool error semantics

**Validation**
- Checked against assignment requirements: runnable Web product, source repository, README, AI usage/validation record, testing, evidence traceability, and explicit handling of missing/conflicting/failed data.

**Human corrections**
- Scope reduced to a single-agent MVP.
- Streamlit rejected in favor of React/Vite/TypeScript/Bun.
- Heavy sandbox/runtime work rejected as unnecessary.
- Fuyao fund/futures/options retained because cross-asset evidence can matter in stock decision review.
- iFinD servers configured broadly but intended for lazy/intent-based loading.

**Residual risk / unresolved**
- Real MCP capabilities still need live verification per server.
- LLM provider compatibility and production deployment need integration testing.

---

## Frontend Web Shell — 2026-09-22

**AI/tool used**
- Codex for React/Vite/TypeScript UI implementation and mock adapter design.

**Task**
- Implement the frontend-only Decision Review vertical slice while preserving the T0 ex-ante/ex-post boundary and keeping backend credentials server-side.

**Output**
- Home → Running → Result flow with a mock adapter.
- T0 evidence split, separate Decision Quality / Outcome, attribution labels, lessons, checklist, and evidence references.
- Configurable non-sensitive `VITE_API_BASE_URL` placeholder; no API keys or authorization data.

**Validation**
- `npm install && npm run build` passed (TypeScript check plus Vite production build).
- Manually reviewed the mock flow structure against `docs/SPEC.md` sections 18, 20, and 22 and `docs/TEST_PLAN.md` cases T01, T02, T09, T14, and T15.
- Bun was not installed in the execution environment, so `bun install` / `bun run dev` could not be executed here.

**Human corrections**
- Kept the implementation frontend-only and mock-backed; no changes to `apps/api/`.
- Rebuilt the feature branch from `origin/main` and appended this record rather than overwriting canonical repository docs.

**Residual risk / unresolved**
- Real API/SSE adapter and browser-level visual checks remain for integration testing.
- GitHub PR creation may require a token with pull-request permissions.

---

## Backend MVP vertical slice — 2026-09-22

**AI/tool used**
- Local CC (Claude agent) running on the user's Windows host
- Bun 1.2.19 + Hono 4 + OpenAI Agents SDK TS 0.1.x + Zod 3

**Task**
- ELI-313: stand up the AIME Decision Review backend MVP under `apps/api/`:
  Bun + Hono + OpenAI Agents SDK TS, thin LLM provider abstraction, MCP
  registry covering Fuyao (6) + iFinD (11) with lazy loading, SQLite
  persistence, Decision Review Agent state machine, bounded reflection,
  Review API (`POST /api/reviews`, `GET /api/reviews/:id`, `/events`, `/result`,
  `/health`), tests for normal / empty / transient_error paths.

**Output**
- `apps/api/` scaffold: `package.json`, `tsconfig.json`, `.gitignore`,
  `.env.example`, `README.md`, `src/` (config, types, providers, mcp registry
  + adapters, db, agents, routes, server, entrypoint), `tests/`.
- Decision Review Agent state machine:
  `created → planning → retrieving → analyzing → reflecting → completed | partial | failed`.
- T0 frozen from `executedAt`; evidence aligned via `alignEvidence(...)` so
  ex-post never contaminates decision-quality reasoning.
- Reflection (single bounded pass) checks ex-post leak, numeric grounding,
  correlation→causality, ignored counter-evidence, outcome contamination.
- Mock LLM provider and mock MCP adapters so the vertical slice runs without
  real credentials. Live Fuyao / iFinD HTTP branches are wired but currently
  return `permanent_error` when credentials are configured (follow-up).

**Validation**
- `bun run typecheck` → 0 errors.
- `bun test` → 10/10 pass, 110 expect() calls (3 spec files:
  `tests/api.test.ts`, `tests/agent.test.ts`, `tests/mcp-registry.test.ts`).
- `bun run start` then `curl /health` → 200 with all 17 MCP servers registered.
- `curl POST /api/reviews` with a buy decision on 600519 T0=2024-03-15:
  review completes synchronously, `status: "completed"`, 22 evidence items
  split around T0 (15 ex_ante + 7 ex_post), `decisionQuality` and `outcome`
  keys distinct, tool statuses surface every adapter call honestly.
- T0 alignment sanity check: every `publishedAt` ≤ `T0` for `exAnteEvidence`,
  every `publishedAt` > `T0` for `exPostEvidence`.
- Reflection produced no flags on the canonical vertical slice; produced
  expected flags on the overconfidence-user-reason synthetic case.
- Rebased onto current `origin/main` (after frontend MVP merge) to keep the
  `feature/backend-agent-core` branch synced; conflict in `docs/AI_VALIDATION.md`
  resolved by keeping both the frontend and the backend entries.

**Human corrections**
- Branch rebased onto the post-frontend main head so PR remains a fast-forward.

**Residual risk / unresolved**
- Live Fuyao / iFinD HTTP transport not wired in this slice; live path is a
  follow-up that must verify against real credentials before merging.
- MiniMax provider adapter is plumbed but only the `mock` provider has been
  exercised end-to-end. Real LLM call path needs an integration test against a
  configured endpoint.
- SQLite is per-process; multi-instance deployment needs migration to
  PostgreSQL / shared volume.

---

## ELI-313 acceptance — 2026-09-22 (Oracle CC follow-up)

**AI/tool used**
- Oracle CC (Claude Opus 4.8) on branch `feature/backend-agent-core`

**Task**
- Validate Issue ELI-313 acceptance against the Local CC backend MVP and add
  the T11 (non-compliant request) boundary that the original slice missed.

**Output**
- Added `nonCompliantReasonFor()` to `apps/api/src/routes/api.ts`: rejects
  POST /api/reviews with HTTP 422 when the user reason contains deterministic
  prediction / guaranteed-return / direct buy-sell instruction language.
- Added bun:test case `POST /api/reviews rejects non-compliant (T11) ...`
  to `apps/api/tests/api.test.ts`.

**Validation**
- `bun run typecheck` → 0 errors.
- `bun test` → 11/11 pass, 113 expect() calls.
- Live curl smoke (PORT=8787, `LLM_PROVIDER=mock`):
  - GET /health → 200, provider=mock, 5 configured servers.
  - POST /api/reviews (600519, T0=2024-03-15) → 202 with id; GET /api/reviews/:id
    → status=completed, finishedAt set.
  - GET /api/reviews/:id/events → 14 events across 9 distinct product-level
    kinds: review_created, plan_started, market_data_retrieved,
    index_sector_context_retrieved, news_events_retrieved, evidence_time_aligned,
    fact_consistency_checked, reflection, final_review_generated.
  - GET /api/reviews/:id/result → exAnte=9, exPost=2; decisionQuality and
    outcome fields distinct; checklist=4, citations=9, uncertainties=2.
  - T02 boundary: every exAnte.publishedAt ≤ max 2024-03-14T00:00:00Z (≤ T0
    − 1d); every exPost.publishedAt ≥ min 2024-03-29T00:00:00Z (> T0 + 14d).
  - T11 (POST with "Guaranteed 100% return in 30 days") → 422
    `{ error: "non_compliant_request", reason: "100% return" }`.
  - GET /api/reviews/missing → 404 `{ error: "not_found" }`.
- Secret scan on `apps/api/`: no `sk-*`, no `Bearer …`, no populated credential
  values; `.env.example` has variable names only; `.env*` gitignored.

**Human corrections**
- Verified T11 boundary was missing in the Local CC bootstrap commit and
  added it before declaring acceptance.
- Adopted the Local CC backend commit (1ef5255) instead of the duplicate
  Oracle CC commit that diverged at the same SHA, per AGENTS.md "feature
  branches / small reviewable commits" — kept a single canonical MVP and
  added only the missing boundary.

**Residual risk / unresolved**
- Live Fuyao / iFinD HTTP transport still unverified (mock-only).
- Real LLM (MiniMax) call not yet exercised; mock path is the canonical
  vertical slice.
- The result endpoint does not echo `T0`; clients must call /api/reviews/:id
  for the canonical T0. (Low priority; documented.)

Note: The `feature/backend-agent-core` branch now contains the merged
Local CC MVP + Oracle CC T11 boundary + Oracle CC T11 test. Ready for PR
to `main`.

---

## PR #2 Supervisor blocker fix — 2026-09-22 (Oracle CC)

**AI/tool used**
- Oracle CC (Claude Opus 4.8) on branch `feature/backend-agent-core`

**Task**
- Resolve PR #2 Supervisor blocker: `apps/api/src/providers/openai-compatible.ts`
  directly imports `"openai"`, but `apps/api/package.json` only declared
  `"openai"` transitively via `@openai/agents`.

**Output**
- `apps/api/package.json`: added `"openai": "^5.23.2"` to direct dependencies
  (matches the version already resolved transitively; `import OpenAI from
  "openai"` + `new OpenAI({ apiKey, baseURL })` is the v5 SDK contract).
- `apps/api/bun.lock`: regenerated with explicit `openai` entry; `configVersion`
  bumped to 0 by Bun.
- Merged `origin/main` into `feature/backend-agent-core` to bring the new
  Product CI workflow (`.github/workflows/ci.yml`) into the PR base — the CI
  workflow runs `bun install --frozen-lockfile && bun run typecheck && bun
  test` in `apps/api`, matching the validated local flow.

**Validation**
- `bun run typecheck` → 0 errors.
- `bun test` → 11/11 pass, 113 expect() calls.
- `bun install --frozen-lockfile` resolves cleanly with the new dep declared.
- Secret scan on `apps/api/` → no `sk-*`, `Bearer …`, or populated cred
  values; no contract drift (only the dependency declaration changed).
- New PR head: `15a02ca` (ahead of `main` by 3, behind 0).

**Human corrections**
- Drove the fix directly as ELI-313 lead instead of waiting on Local CC —
  the blocker was small (one-line `package.json` + lockfile regen) and the
  user explicitly named me as final integrator.
- Did not rebase; used `--no-ff merge` style merge commit to keep history
  readable for the supervisor.

**Residual risk / unresolved**
- Product CI `.github/workflows/ci.yml` runs the frontend job from repo
  root (`npm ci && npm run build`) without a root `package-lock.json`;
  the frontend job may fail on `npm ci` and need a `working-directory:
  apps/web` adjustment. Backend job is correctly scoped to `apps/api`
  and should pass.
- Awaiting Codex / Supervisor follow-up review.

---

## ELI-318 integration — 2026-09-22 (Oracle CC)

**AI/tool used**
- Oracle CC (Claude Opus 4.8) on branch `feature/eli-318-real-llm-mcp-integration`
- Parallel support from Local CC (`scripts/llm-smoke.ts`,
  `apps/api/scripts/mcp-smoke.ts` auto-detect smoke harness) and Local
  Codex (API contract / CORS / mock↔real audit). Oracle CC remains the
  issue owner; assignees untouched.

**Task**
- ELI-318: turn the merged frontend + backend MVP into one real end-to-end
  vertical slice. Scope: real frontend↔backend integration, real
  `openai-compatible` LLM path, live Fuyao + iFinD MCP HTTP transport,
  validation evidence against `docs/TEST_PLAN.md` (T01/T02/T04/T05/T07/
  T08/T09/T10/T18).

> **Scope clarification (added post-Local-CC follow-up):** every "real
> LLM / real MCP" smoke in this entry was executed against a **controlled
> fake upstream** spun up locally on `:9097` / `:9098` / `:9099`, with the
> request shape, header forwarding, response contract, and per-call
> timeout all exercised end-to-end. **None** of these smokes have been
> rerun against the production MiniMax / Fuyao / iFinD gateways with real
> credentials. That real-gateway verification is still pending (see
> *Still requires real-gateway verification* below) and is the blocker for
> flipping PR #3 from Draft to Ready.

**Output**
- Frontend `src/api.ts`: real adapter that POSTs `/api/reviews`, polls
  `/api/reviews/:id`, fetches `/result`; falls back to the static mock
  when `VITE_API_BASE_URL` is empty. The frontend now lives in a
  readable single-file React component (rewritten from the previous
  one-line minified blob) so it can be reviewed against SPEC §18.
- Frontend `src/App.tsx`: rewired to consume the new adapter; preserves
  T0 split, ex-ante/ex-post separation, decision-quality vs outcome,
  attribution labels, lessons, checklist, and citations.
- Backend `src/mcp/adapters/live-http.ts`: new generic HTTP transport
  adapter (Fuyao + iFinD share it) with explicit
  success/empty/transient_error/permanent_error semantics; per-call
  timeout via `AbortController`; missing `publishedAt` items are
  rejected (never substituted with `retrievedAt`); Authorization and
  `x-api-key` headers are forwarded but never logged.
- Backend `src/mcp/registry.ts`: when credentials are configured, the
  registry now resolves to `LiveHttpAdapter`; the same `FUYAO_INTENT_MAP`
  / `IFIND_INTENT_MAP` gate which intents each live server supports so
  the registry never fans a "news" call to a "price-only" server.
- Backend `src/routes/api.ts`: CORS middleware so the React shell can
  call the API from a different origin in dev.
- Backend `src/server.ts`: default `runSync = false` so a real browser
  session polls for progress; tests still override `runSync: true`.
- New tests:
  - `apps/api/tests/live-http.test.ts` — 9 cases (200 success, empty,
    5xx → transient, 4xx → permanent, missing publishedAt → empty,
    timeout → transient, registry routing with credentials, mock fallback,
    T18 vertical with both registries). All cases run against
    in-process `Bun.serve` fakes; no external network.
  - `apps/api/tests/openai-compatible.test.ts` — 2 cases (real chat
    completions against a `Bun.serve` fake; 429 does not leak the api key
    into the thrown error message). Fake-only.
- Local CC smoke harness (commit `2a2d588`, Oracle CC chain):
  - `scripts/llm-smoke.ts` — auto-detects real vs fake LLM gateway from
    `LLM_BASE_URL`/`LLM_API_KEY`; prints only `{scheme, prefix(6 chars),
    length}` for the credential, never the raw value.
  - `apps/api/scripts/mcp-smoke.ts` — same shape for Fuyao + iFinD,
    switches to real `LiveHttpAdapter` when `HITHINK_FINANCE_*` or
    `IFIND_MCP_*` are set, otherwise exercises the adapter against an
    in-process fake.

**Validation**
- `bun run typecheck` (apps/api) → 0 errors.
- `bun test` → **22 / 22 pass**, 146 `expect()` calls across 5 files.
  (Local CC re-ran locally with the same result.)
- Frontend `npm run build` (repo root) → succeeds; CSS 7.76 kB, JS
  237.24 kB.
- Secret scan on `apps/` + `src/` + `docs/` + `scripts/` →
  - `.env.example` placeholders (variable names only).
  - Test fixtures with explicit `fake-` / `test-` / `sk-fake-` /
    `sk-test-` prefixes in `tests/live-http.test.ts`,
    `tests/openai-compatible.test.ts`, the new smoke scripts.
  - No production credential values anywhere in repo, scripts, or
    this entry.

**Controlled-fake upstream smokes (NOT production gateway)**
- LLM smoke (`/tmp/llm-smoke.ts`, then re-exercised by Local CC via
  `scripts/llm-smoke.ts`):
  - Local fake upstream on `:9099`, real backend on `:8787` with
    `LLM_PROVIDER=openai-compatible` pointed at the fake.
  - POST `/api/reviews` (600519, buy, T0=2024-03-15) → `completed`.
  - All configured tool adapters reported `success`.
  - Fake upstream observed `Authorization: Bearer …` exactly once,
    confirming the OpenAI-compatible provider actually hits the
    configured `LLM_BASE_URL` with the configured key in the
    `Authorization` header. **No production MiniMax endpoint touched.**
- MCP smoke (`/tmp/mcp-smoke.ts`, then re-exercised by Local CC via
  `apps/api/scripts/mcp-smoke.ts`):
  - Local fake Fuyao on `:9097`, fake iFinD on `:9098`, real backend on
    `:8788` with `HITHINK_FINANCE_*` + `IFIND_MCP_*` pointed at the
    fakes.
  - POST `/api/reviews` → `completed`.
  - Distinct evidence sources returned in the result:
    `fuyao:a-share:price`, `fuyao:a-share:announcement`,
    `ifind:stock:price`, `ifind:news:sector` — every fake-produced
    evidence item carried `source` + `publishedAt`, and the
    `LiveHttpAdapter` correctly assigned the items to `ex_ante` vs
    `ex_post` based on T0.
  - Tool statuses: `a-share:success`, `stock:success`, `news:success`
    for the live adapters; `<none-configured>:empty` for intents no
    configured server handles (honest lazy loading).
  - **No production Fuyao / iFinD endpoint touched.**

**TEST_PLAN crosswalk (against controlled-fake upstreams only)**
- **T01** normal review — fake-MCP + fake-LLM smokes produced
  `status=completed`, exAnte+exPost split, decisionQuality vs outcome
  distinct, lessons + checklist, citations.
- **T02** T0 boundary — existing agent.test.ts loop that asserts every
  `exAnte.publishedAt ≤ T0` and every `exPost > T0`; fake-MCP result
  carries `publishedAt` for both sides.
- **T04** empty result — existing `simulateEmpty` agent test.
- **T05** transient failure — existing `simulateTransientFailure` test;
  live-http test additionally covers 5xx → transient_error (against
  in-process fake).
- **T07** numeric mismatch — agent.test.ts path unchanged.
- **T08** unsupported causal — `reflection.ts` unchanged; existing
  tests still apply.
- **T09** good process / bad outcome — `decisionQuality` vs
  `outcome` always rendered as separate objects in `Result.tsx`.
- **T10** bad process / good outcome — same: outcome is its own
  field, quality reasoning no longer references P&L.
- **T18** real MCP minimal path — **partially satisfied**: request
  shape, response normalization, header forwarding, timeout, and
  intent gating all verified against controlled fake upstreams. The
  "real" qualifier (real gateway + real credentials) is not satisfied.

**Still requires real-gateway verification (blocker for PR #3 → Ready)**
- Re-run `scripts/llm-smoke.ts` against the production MiniMax-compatible
  gateway with real `LLM_BASE_URL` + `LLM_API_KEY`; capture one line of
  proof that the upstream received `Authorization: Bearer <prefix>…` and
  returned a `chat.completion` with the expected model name. The script
  prints only `{scheme, prefix(6), length}`; the raw key never reaches
  stdout or this log.
- Re-run `apps/api/scripts/mcp-smoke.ts --provider=fuyao --server=a-share`
  against the real Fuyao gateway, and `--provider=ifind --server=news`
  against the real iFinD gateway. Each must produce one evidence item
  with a real `publishedAt` and a real `source` that matches the
  upstream payload.
- Update the *Controlled-fake upstream smokes* block above (or append a
  new dated section) with the real-gateway traces; only then does
  PR #3 go Ready for review.

**Cross-issue dependencies**
- **ELI-322** — will consolidate root `.env.example` and remove
  `apps/api/.env.example`. PR #3 must rebase / sync to that change
  before transitioning from Draft to Ready. Tracked as a follow-up
  in this branch's PR description.

**Human corrections**
- Started from `agent/oracle-cc/116ec799ffbb` (the ELI-313 base) and
  branched into `feature/eli-318-real-llm-mcp-integration` rather than
  pushing directly to main, per AGENTS.md §8.
- Frontend file split: kept the single-file aesthetic but pulled the
  HTTP adapter into `src/api.ts` so the call sites in `App.tsx` stay
  short; no behavioural change for the mock-only path.
- Did not relax T11 (deterministic-prediction) rejection — it remains
  enforced in `routes/api.ts`.
- Local Codex surfaced 5 contract findings (CORS should pin origin via
  env; `ReviewResult` type is a presentation subset of `EvidenceSchema`
  and should be a shared decoder; `Number()` on price/quantity can yield
  `NaN` → `null` → 400 instead of field-level error; `VITE_API_BASE_URL`
  empty/non-empty is a strict mode switch with no silent fallback to
  mock after a real submission starts). Filed as follow-up issues;
  none are blocking this PR.

**Residual risk / unresolved**
- The default demo ports 8080/3000 may need overrides when another local service
  already occupies them; the Compose defaults remain simple for a clean host.
- Existing volumes created by the earlier root-user image need a one-time
  ownership migration before the non-root ELI-321 runtime can write SQLite;
  fresh named volumes inherit the image's `/var/lib/aime` ownership.

## Compose handoff alignment — 2026-09-22 (Oracle Codex)

**Validation**
- Re-read the ELI-320 and ELI-321 delivery comments and inspected their pushed
  branches before finalizing Compose integration.
- Compose now consumes the actual frontend `apps/web/Dockerfile` contract and
  the backend multi-stage `apps/api/Dockerfile` contract: `/health`, non-root
  runtime, and SQLite at `/var/lib/aime`.
- Added the backend `.dockerignore` from the ELI-321 handoff and added the
  repository-wide multi-component architecture/Compose planning rule to
  `AGENTS.md`.

## Auth: Bootstrap Admin + Managed Users — 2026-09-22 (Oracle CC)

**AI/tool used**
- Oracle CC (Claude Opus 4.8) on branch `agent/oracle-cc/4988b142bf66`
- Bun 1.4.x + Hono 4 + Bun.password (argon2id) + Zod

**Task**
- ELI-325: implement minimal built-in authentication with admin-managed
  users: no public registration, argon2id passwords, HttpOnly cookie
  session, idempotent bootstrap admin from
  `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD`, forced first-login
  password change, admin-only user CRUD with one-time temporary
  passwords, self-disable / self-delete protection, frontend login +
  forced change + admin user-management screens.

**Output**
- Backend (`apps/api/src/auth/`): `types.ts`, `passwords.ts` (argon2id
  via `Bun.password`; 16-char base64url temp passwords; 32-byte base64url
  session tokens), `repository.ts` (users + sessions tables; idempotent
  `ensureBootstrapAdmin`), `middleware.ts` (`attachUser`, `requireAuth`,
  `requireAdmin`, `gateMustChangePassword`, cookie helpers with Secure
  flag in production), `routes.ts` (`/api/auth/{login,logout,me,
  change-password}`), `admin.ts` (`/api/admin/users` list/create/
  reset/disable/enable/delete with self + last-admin guards).
- Entry point (`apps/api/src/index.ts`) runs
  `userRepo.ensureBootstrapAdmin(...)` before wiring routes; logs only
  the username (never the password) when an admin is created.
- Config (`apps/api/src/config.ts`) loads `INITIAL_ADMIN_USERNAME` /
  `INITIAL_ADMIN_PASSWORD` with documented fallbacks and a Secure-cookie
  `isProduction` flag.
- Frontend (`src/auth-api.ts`, `src/App.tsx`, `src/styles.css`): thin
  client using `credentials: include`; App.tsx state machine
  `login → change-password → home / result / admin`; admin-only user
  management screen (create / reset / disable / enable) with no signup
  UI; header shows username + role badge + logout.
- `docker-compose.yml` passes `INITIAL_ADMIN_USERNAME` /
  `INITIAL_ADMIN_PASSWORD` with documented defaults into the API service
  only (never into the web image). `.env.example` documents the new
  server-only variables.

**Validation**
- `bun install --frozen-lockfile` → clean.
- `bun run typecheck` → 0 errors.
- `bun test` → **50/50 pass**, 229 expect() calls across 4 files:
  - `apps/api/tests/auth.test.ts` — 39 tests covering bootstrap
    idempotency, env override (INITIAL_ADMIN_USERNAME / PASSWORD),
    login / logout / me, must_change_password gate (cannot hit
    /api/reviews or /api/admin), role protection (admin / user / anon),
    create-user returns one-time temp password + forces mustChange,
    reset-password issues new temp + revokes sessions, self-disable /
    self-delete blocked, last-admin guard, session invalidation on
    change-password, secret hygiene (argon2id hashes only, no plaintext
    echoed in responses, no `admin@123` literal in the frontend bundle),
    **identity-contract guard: client-supplied `x-user-id` / `X-User-Id`
    headers are rejected on every protected route; user identity is
    always derived from the ELI-325 session cookie (the contract PR #7 /
    ELI-328 must satisfy when merged).**
  - Existing review-API tests updated to authenticate via cookie and
    remain green.
- `npm run build` → clean (`vite build`); bundle contains **zero**
  literal `admin@123` (verified by `grep`).
- Secret scan on `apps/api/src` + `dist/`: no populated API keys, MCP
  tokens, Authorization headers, cookies, or bearer tokens. The only
  occurrence of the string `admin@123` in source is the documented
  server-side default fallback in `apps/api/src/config.ts` (and an
  accompanying comment) — it never appears in the frontend bundle.

**Human corrections**
- Kept frontend and backend changes inside their respective boundaries
  (`apps/api/src/auth/`, `src/auth-api.ts`, `src/App.tsx`,
  `src/styles.css`); only `.env.example` and `docker-compose.yml` at the
  repo root were touched.
- Removed an earlier frontend auto-fill of the bootstrap password in
  the change-password screen so the bundle contains no literal
  `admin@123` — operator enters the password they were given at
  provisioning time.

**Residual risk / unresolved**
- Frontend bundle is mock-mode aware but the login flow requires the
  production `/api` proxy; `npm run dev` outside Compose still needs a
  `/api` mock or proxy to exercise login end-to-end.
- The default bootstrap password is intentionally public per the issue
  acceptance; `must_change_password=1` and the disabled-default-account
  guard are the safety net.
- Initial Compose deployment on a host with a pre-existing `api-data`
  volume created by the earlier root-user image may still need a
  one-time ownership migration (`/var/lib/aime`); this is the existing
  ELI-321 caveat and is unchanged by ELI-325.

**Branch / PR**
- Branch `agent/oracle-cc/4988b142bf66` — 2 commits ahead of `main`,
  ahead of `origin/main` (after the `Ops: canonical production path`
  PR #6 merge).
- Head SHA: `547ebb8dd2fb0b608955bcec0aeb524157682c3b` (force-with-lease
  updated with the `x-user-id` identity-contract guard + 5 regression
  tests + `docs/AI_VALIDATION.md` update).
- PR #9 opened by the user as Draft; `mergeable_state` was `mergeable=false`
  on the previous head and will be re-checked by GitHub after this
  force-push.
- PR open / update blocked locally because the workspace `gh` PAT does
  not carry `pull_requests` scope (`403 Resource not accessible by
  personal access token` on `repos/.../pulls`); branch is pushed and
  ready for the supervisor or a token with the right scope to update.
