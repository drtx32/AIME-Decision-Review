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

## Root Compose orchestration — 2026-09-22 (Oracle Codex)

**AI/tool used**
- Oracle Codex for container and deployment integration.

**Task**
- Add the authoritative root Docker Compose path after the frontend/backend
  MVPs, unify environment documentation, and keep backend credentials server-only.

**Output**
- Separate Nginx web and Bun API images, API health-gated startup, named
  persistent SQLite volume, root-only `.env.example`, and browser `/api` proxy.
- Frontend production builds use the non-sensitive `VITE_API_BASE_URL` and call
  the backend review API when configured; mock mode remains the default outside
  Compose.

**Validation**
- `npm run build` passed for the root frontend.
- `docker compose config` validated the service, healthcheck, dependency, and
  volume configuration; `docker compose build` built both images successfully.
- With host ports overridden to avoid unrelated local services, Compose smoke
  checks passed: API `/health` returned 200, web `/` returned 200, and a POST
  through the web `/api` proxy completed with 9 ex-ante and 2 ex-post evidence
  items.
- Secret scan checked that no populated key, token, or Authorization value was
  added.

**Human corrections**
- Kept all runtime variable names in the root template and removed the obsolete
  `apps/api/.env.example` to prevent split configuration sources.

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
    echoed in responses, no bootstrap-credential literal in the frontend bundle),
    **identity-contract guard: client-supplied `x-user-id` / `X-User-Id`
    headers are rejected on every protected route; user identity is
    always derived from the ELI-325 session cookie (the contract PR #7 /
    ELI-328 must satisfy when merged).**
  - Existing review-API tests updated to authenticate via cookie and
    remain green.
- `npm run build` → clean (`vite build`); bundle contains **zero**
  bootstrap-credential literal (verified by `grep`).
- Secret scan on `apps/api/src` + `dist/`: no populated API keys, MCP
  tokens, Authorization headers, cookies, or bearer tokens. No
  bootstrap-credential literal anywhere in source.

**Human corrections**
- Kept frontend and backend changes inside their respective boundaries
  (`apps/api/src/auth/`, `src/auth-api.ts`, `src/App.tsx`,
  `src/styles.css`); only `.env.example` and `docker-compose.yml` at the
  repo root were touched.
- Removed an earlier frontend auto-fill of the bootstrap password in
  the change-password screen so the bundle contains no bootstrap-credential
  literal — operator enters the password they were given at
  provisioning time.

**Residual risk / unresolved**
- Frontend bundle is mock-mode aware but the login flow requires the
  production `/api` proxy; `npm run dev` outside Compose still needs a
  `/api` mock or proxy to exercise login end-to-end.
- `INITIAL_ADMIN_PASSWORD` is required from the deployment secret store
  on every fresh database; there is intentionally no in-repo fallback.
  The bootstrap admin is created with `must_change_password=1`, which
  remains the safety net against a leaked initial value. See the
  ELI-325 credential-cleanup entry below for the full contract change.
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

## ELI-325 credential cleanup — 2026-09-22 (Oracle CC)

**AI/tool used**
- Oracle CC (Claude Opus 4.8) on branch `agent/oracle-cc/4988b142bf66`

**Task**
- ELI-325 follow-up: remove the in-repo credential fallback. PR #9
  landed `INITIAL_ADMIN_PASSWORD` with a hardcoded default in
  `apps/api/src/config.ts` and a shell default of the same value in
  `docker-compose.yml`. Per AGENTS.md §7 ("Never commit... secret
  values... Use only server environment variables / GitHub Secrets"),
  this violated the project rule — a misconfigured deployment should
  fail fast, not silently run with a public password.

**Output**
- `apps/api/src/config.ts`:
  - `initialAdmin.password` now typed `string | null` (was `string`).
  - `loadConfig` no longer returns a fallback; missing env → `null`.
- `apps/api/src/index.ts`:
  - On startup, if the DB has no admin AND `INITIAL_ADMIN_PASSWORD`
    is empty/missing, log a clear error and `process.exit(1)` before
    binding the HTTP listener.
- `docker-compose.yml`:
  - `INITIAL_ADMIN_PASSWORD` now uses shell `${VAR:?msg}` so a missing
    value fails Compose startup with the documented message — verified
    by `docker compose config`.
- `.env.example`:
  - Removed the default-mention paragraph from the comment block;
    added an explicit "password has no default — it MUST be supplied"
    notice.
- `apps/api/tests/helpers.ts`:
  - Exposes a `TEST_PASSWORD` module-level constant (a self-documenting
    non-credential-shaped placeholder) used by all tests that need to
    log in as a seeded admin/user. The plaintext-vs-hash separation
    tests assert `row.passwordHash !== TEST_PASSWORD` and that
    `TEST_PASSWORD` never appears in any response body.

**Validation**
- `bun run typecheck` → 0 errors.
- `bun test` → 54/54 pass, 253 expect() calls (was 52/249; +2 new
  `loadConfig` tests that pin the fail-fast contract).
- `npm run build` → clean (`vite build`).
- Secret scan on production paths:
  - `apps/api/src/`, `src/`, `docker-compose.yml`, `.env.example` →
    zero bootstrap-credential literal.
  - No `sk-*`, `Bearer …`, or `Authorization: Bearer` patterns in
    source.
- `docker compose config` against an environment without
  `INITIAL_ADMIN_PASSWORD` correctly errors out:
  `required variable INITIAL_ADMIN_PASSWORD is missing a value`
  with the documented message.

**Residual risk / unresolved**
- The test file imports `TEST_PASSWORD` from `tests/helpers.ts`; the
  plaintext-vs-hash separation tests still pin the invariant that the
  placeholder never appears in stored hashes or any response body,
  preserving the signal that any real credential-shaped string would
  leak the same way.

## ELI-326 resilient provider — 2026-09-22 (Oracle CC)

**AI/tool used**
- Oracle CC (Claude Opus 4.8) on branch `feature/eli-326-provider-resilience-v2`
  (rebased on `06deda6` / PR #6 — `Ops: canonical production path`).
- Bun 1.4.2 test runner; Docker Compose v5.3.1 on the Oracle host.

**Task**
- ELI-326: make the production API resilient when no real LLM provider is
  configured or the configured provider is unavailable. Missing/invalid LLM
  configuration must never crash the API process or take down the frontend.
  Concrete behaviors required:
  1. Boot is healthy even when `LLM_PROVIDER` / `LLM_BASE_URL` / `LLM_API_KEY`
     / `LLM_MODEL` are missing.
  2. `/health` returns 200 with `provider_configured` + `provider_status`
     (`"unconfigured" | "ready" | "error"`) and never leaks secrets.
  3. `POST /api/reviews` returns HTTP 503 with stable code
     `MODEL_NOT_CONFIGURED` (or `MODEL_UNAVAILABLE` on runtime failure) and a
     canonical Chinese admin-contact message — never a silent fallback to mock
     in production.
  4. 401/403 → `MODEL_AUTH_FAILED`; 429 → `MODEL_RATE_LIMITED`; 5xx /
     timeout / DNS-connect errors → `MODEL_UNAVAILABLE` / `MODEL_TIMEOUT`.
     A failed call must not terminate the Bun process.
  5. Docker healthcheck must represent process/service health, not "LLM is
     configured". Missing model config must NOT mark the container
     unhealthy / restart-loop.
  6. Frontend must render the admin-contact banner on the stable codes; no
     stack traces or generic network-crash UI.
- Constraints: feature branch + PR; never direct-push `main`; keep
  frontend/backend separated; do not change the public port model
  (`13608 → web:80`, api stays Compose-internal on `3000`).

**Output**
- New `apps/api/src/providers/errors.ts` (163 LOC) — typed provider error
  contract. Five stable codes (`MODEL_NOT_CONFIGURED`, `MODEL_UNAVAILABLE`,
  `MODEL_AUTH_FAILED`, `MODEL_RATE_LIMITED`, `MODEL_TIMEOUT`) with
  HTTP-status mapping (503 / 502 / 504), `retryable` flag, `correlationId`,
  and `sanitizedMessage` that explicitly never includes the api key, the
  Authorization header, or full request bodies. `classifyProviderError`
  maps raw OpenAI SDK / fetch errors into the typed contract.
- Rewrote `apps/api/src/providers/index.ts` (+248/-18) — new
  `LazyResilientProvider` wraps the underlying provider with:
  - never-throws construction (the OpenAI client is built lazily on first
    `complete()` call),
  - bounded `AbortController`-style timeout (default 20s) racing the inner
    call,
  - one bounded retry on retryable errors only (5xx / 429 / timeout),
  - typed-error mapping on every failure,
  - `availability()` snapshot used by `/health` and the route pre-flight.
  - When `LLM_PROVIDER` is explicitly set to a real provider but creds are
    missing, the factory still returns a wrapper but seeds its `lastError`
    with `MODEL_NOT_CONFIGURED` so `/health` reports honest `state:
    "unconfigured"` without ever making a network call.
- `apps/api/src/routes/api.ts` (+108/-11):
  - `/health` now returns 200 unconditionally with `provider_configured`,
    `provider_status`, `provider_id`, `provider_model`, `requested_mode`,
    `degraded`, sanitized `last_error` (no api key, no Authorization
    header, no raw provider error body).
  - `POST /api/reviews` pre-flight: when `provider_status === "unconfigured"`
    it returns HTTP 503 + stable `MODEL_NOT_CONFIGURED` + canonical Chinese
    message **before** any DB write or run is created. When the live call
    fails with `MODEL_AUTH_FAILED` it returns the appropriate mapped HTTP
    status (502).
  - Background run path wraps `agent.run()` so a failed provider call is
    captured as a typed `ProviderError`, persisted as
    `${code}: ${sanitizedMessage} (correlationId=...)` on the run row, and
    `updateStatus(... "failed")`. Bun process never dies.
- `apps/api/tests/resilience.test.ts` (399 LOC, new) — covers every
  behavior in the task list above plus secret-redaction and
  retry-budget invariants. 30 tests total across the API suite
  (10 pre-existing + 20 new).
- Frontend (`src/api.ts` + `src/App.tsx` + `src/styles.css`, +184/-3):
  - `src/api.ts` now exposes a typed `ProviderUnavailableError` that is
    thrown when any of the five stable codes is detected in a non-OK
    response. `fetchProviderStatus()` reads the new readiness fields from
    `/api/health`.
  - `src/App.tsx` renders the admin banner
    (`当前未配置可用的大模型服务，请联系管理员。`) when `/api/health`
    reports the provider as `unconfigured`, and on any submit-time
    `ProviderUnavailableError`. Other non-OK responses keep the generic
    `网络异常，请稍后重试。` path — no stack traces, no provider
    internals.
  - `src/styles.css` adds `.providerbanner` / `.providerbanner-unconfigured`
    / `.providerbanner-error` styles; no other UI changes.
- The implementation was built on top of a previously-cached
  Oracle CC commit (`c797e51`) that contained the same code. That commit
  lived in a different worktree (different agent run-id). I rebased it
  onto current `main` (`06deda6`, post-PR #6) as a single new commit
  `605740f` so the PR diff is clean against `main`.

**Validation**
- `cd apps/api && bun install --frozen-lockfile` → 104 packages, 0
  errors.
- `cd apps/api && bun run typecheck` → 0 errors.
- `cd apps/api && bun test` →
  `30 pass, 0 fail, 172 expect() calls` (covers all 6 spec items in the
  ELI-326 description: boot-without-LLM, controlled 503, 401/429/5xx/timeout
  mapping, /health 200 after failure, secret redaction, retry budget).
- `cd apps/web && npm ci && npm run build` → TypeScript `tsc -b` passes,
  Vite production build succeeds (1.88 MB modules → 235 KB JS / 8 KB CSS).
- Secret scan on the diff (`grep -rE 'sk-[A-Za-z0-9_-]{8,}|Bearer
  [A-Za-z0-9_-]{8,}|Authorization:\s*[^[:space:]]' apps/ src/`) → 0 matches.
  `routes/api.ts` `sanitizeProviderErrorMessage` redaction covered by an
  explicit test that synthesizes a raw error message whose body contains
  the literal substrings `Bearer ` and a `REDACTION-PROBE-NOT-A-REAL-KEY`
  placeholder (clearly non-secret fixture strings), and asserts the mapped
  `sanitizedMessage` does not contain either substring.
- `git diff --check` → 0 whitespace / line-ending errors on the patch.
- Oracle host reproduction (instance `10.0.0.37`, project
  `aime-decision-review`, host port `13608`):
  - Rebuilt the API container with `LLM_PROVIDER=openai-compatible` and
    empty `LLM_BASE_URL` / `LLM_API_KEY` (production break path).
  - `docker inspect ... .State.Health.Status` × 6 intervals × 5s = all
    `healthy`, `Restarts=0`.
  - `GET /api/health` → `200 OK`, body includes
    `provider_configured:false, provider_status:"unconfigured",
    provider_id:"openai-compatible", provider_model:"missing-model",
    requested_mode:"openai-compatible", degraded:true`,
    `last_error.code:"MODEL_NOT_CONFIGURED", kind:"configuration",
    retryable:false, correlationId:"5825b3f5-…-594d511907e2",
    providerStatus:"missing_credentials"` — and no api key, no
    Authorization header, no provider-internal body.
  - `POST /api/reviews` →
    `503 Service Unavailable`, body
    `{error:"MODEL_NOT_CONFIGURED", code:"MODEL_NOT_CONFIGURED",
     retryable:false, provider_status:"unconfigured",
     provider_id:"openai-compatible", requested_mode:"openai-compatible",
     correlationId:"5825b3f5-…-594d511907e2",
     message:"当前未配置可用的大模型服务，请联系管理员配置模型供应商/API Key 后重试。"}`.
  - `GET /api/health` after the 503 → still `200 OK`; container still
    `healthy`; process still alive.
  - Frontend production bundle `dist/assets/index-*.js` contains both
    `当前未配置可用的大模型服务，请联系管理员。` and the
    `.providerbanner` class names — no stack traces, no provider internals
    exposed to the UI.
  - SQLite volume `aime-decision-review_api-data` is preserved across both
    the unconfigured and the restored-env restarts (221 KB on disk after
    the original 202 POST against mock-mode).
  - After validation, restored the normal `.env` (empty `LLM_PROVIDER`
    → mock fallback is the documented deliberate demo path; spec text
    says "If an existing mock/demo mode is intentionally enabled, that
    is separate."). Container is back to `provider_status:"ready"`,
    `provider_id:"mock"`, `last_error:null`.

**Human corrections**
- Followed the supervisor's note to append the implementation evidence to
  `docs/AI_VALIDATION.md` before PR handoff; the prior turn's
  implementation note was in the issue comment only and did not satisfy
  AGENTS.md §9.
- Re-confirmed the ELI-326 strict-503 contract only fires when the
  operator *explicitly* set `LLM_PROVIDER=openai-compatible` (or any
  non-mock value) without also providing `LLM_BASE_URL` +
  `LLM_API_KEY`. When `LLM_PROVIDER` is unset / empty, the spec's mock
  fallback path remains the deliberate demo mode, matching the
  controlled-fake boundary documented in ELI-318's commit `19e8ab04`.
- Did not duplicate ELI-328's no-model UI logic — the admin banner is
  a single source of truth in `src/api.ts`
  (`PROVIDER_UNAVAILABLE_CODES` set + `ProviderUnavailableError` class)
  shared by both the boot-time `useEffect` probe and the submit-time
  `go()` handler.

**Residual risk / unresolved**
- The `gh` CLI token in this workspace only has read scope
  (`repos/drtx32/AIME-Decision-Review` `pulls` listing returns
  `403 Resource not accessible by personal access token`). PR creation
  must be done via the GitHub web URL
  `https://github.com/drtx32/AIME-Decision-Review/pull/new/feature/eli-326-provider-resilience-v2`
  using the body in the attached `pr-description.md` from the previous
  turn.
- Public host URL `https://10jqka-aime.tong-xiao.top` is served by a
  separate proxy layer outside this Compose stack; the contract is
  verified end-to-end via the local 13608 host port. Re-verifying the
  public URL after PR merge is the operator's responsibility.
- Branch name suffix `-v2` is a workaround — a prior
  `feature/eli-326-provider-resilience` ref is locked by a different
  worktree (`eli-326-3f14f3250780`) from an earlier Oracle CC run-id.
  After that worktree is cleaned up, this branch can be renamed to the
  canonical name with `git branch -m` on either side.
