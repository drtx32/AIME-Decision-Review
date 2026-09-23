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
  - `INITIAL_ADMIN_PASSWORD` is passed through as empty/unset when absent,
    so `docker compose config` remains usable for an existing SQLite volume;
    the API still refuses a truly fresh database without the password.
  - Both `api` and `web` use `restart: unless-stopped`.
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
  `INITIAL_ADMIN_PASSWORD` succeeds and renders an empty API value; fresh-DB
  refusal is enforced by `apps/api/src/index.ts`, not Compose interpolation.

**Residual risk / unresolved**
- The test file imports `TEST_PASSWORD` from `tests/helpers.ts`; the
  plaintext-vs-hash separation tests still pin the invariant that the
  placeholder never appears in stored hashes or any response body,
  preserving the signal that any real credential-shaped string would
  leak the same way.

## ELI-319 restart outage follow-up — 2026-09-23

**Observed incident and causal fix**
- At 2026-09-23 00:57–00:58 UTC, both AIME containers were exited while Docker
  and host Nginx remained active; both containers had restart policy `no`.
  Local `127.0.0.1:13608` refused and the public health paths returned 502.
- Recovery was non-destructive: supplying the deployment environment gate
  restored the existing Compose stack; the SQLite named volume and data stayed
  intact. No volume removal or destructive Docker command was used.
- `api` and `web` now use `restart: unless-stopped`. Compose passes an absent
  `INITIAL_ADMIN_PASSWORD` as empty; API startup rejects only a fresh database
  with no admin, while an existing admin database restarts without changing
  credentials.

**Regression evidence**
- Fresh DB + missing bootstrap password: API emits a clear
  `INITIAL_ADMIN_PASSWORD is required for a fresh database` error and refuses
  startup; repository tests cover the empty credential rejection.
- Existing DB + missing password: idempotent bootstrap returns `created=false`
  and preserves the existing password hash; a dedicated auth regression covers
  this restart contract.
- Compose restart smoke: after non-destructive recovery, API health and web
  `/health` plus `/api/health` returned 200 through the web-only `13608:80`
  exposure. This is operational evidence, not credentialed LLM/MCP validation.

Broader final submission smoke, including real LLM/Fuyao/iFinD credentials,
remains pending.

## ELI-319 verification rerun — 2026-09-23

- Rebased the existing submission branch onto `main@38818eb` and retained the
  PR #7 identity/integration work; no duplicate architecture or agent changes.
- `bun test` in the API source mount: **55/55 pass**, 256 `expect()` calls,
  including fresh-DB empty-password refusal and existing-admin restart with an
  empty password preserving the stored hash.
- `npm run build`, `git diff --check`, `docker compose config` with
  `INITIAL_ADMIN_PASSWORD` unset, and `docker compose build` passed. The
  rendered Compose config shows an empty API password and `restart:
  unless-stopped` on both services.
- After a non-destructive `docker compose up -d --build` and an explicit
  `docker compose restart api web`, API health, web `/health`, and web
  `/api/health` each returned 200. `docker compose ps` showed API healthy,
  web-only host exposure on `13608`, and API only on internal `3000/tcp`.
- Populated key/bearer scan found no populated patterns. No real LLM/Fuyao/iFinD
  credentialed calls were made; broader final submission smoke remains pending.

## PR #7 candidate evidence reconciliation — 2026-09-23

This section records evidence from ELI-333/ELI-318 without treating an
unmerged candidate as current `main`.

**ELI-333 backend correctness evidence (`09c157c`)**
- On the then-current candidate, the exact single-decision timestamp path
  completed with 20 ex-ante, 2 ex-post, and 20 citations; T0
  `2024-03-15T10:24:00+08:00` was normalized to UTC.
- The required Chinese three-trade narrative returned `400 invalid_input` on
  the older single-trade API: it did not yet extract three decisions, resolve
  names, or preserve approximate time precision. This is a blocker, not a pass.
- The audit also found deterministic/template findings and no real external
  credentials in that run. The real multi-decision path must be re-run against
  the latest PR #7 candidate before final submission.

**ELI-318 credentialed transport evidence (PR #7 candidate `5e5aa30`)**
- Sanitized Oracle-host evidence recorded a real OpenAI-compatible/MiniMax
  completion (`api.minimaxi.com`, model name withheld from secrets, HTTP 200),
  Fuyao `a-share` MCP `initialize → initialized → tools/list → tools/call`
  success, and iFinD stock/news endpoint and tool-call successes.
- The evidence preserved `source`, `publishedAt`, `retrievedAt`, and
  `relationToDecision`; a current-time item was classified ex-post rather than
  substituting `retrievedAt` for `publishedAt`.
- It also recorded honest HTTP 400/403 and timeout classifications. No secret
  values were recorded.
- Candidate follow-up commit `32efaa7` added per-server tool maps and Fuyao
  historical `start`/`end`/`interval`/`adjust` schema arguments, with 123 API
  tests and 35 MCP-focused tests reported passing. These changes remain PR #7
  candidate work until merged/reconciled.

**Submission boundary**
- Latest requested audit target is PR #7 head `04a7173f5b6d019e7ceddc531ebf9bd09b831bc5`; this branch does not claim that target's final audit is complete.
- PR #7 remains Draft/pending supervisor reconciliation. ELI-333's
  multi-decision, temporal-adversarial, learning-persistence, and current-head
  rerun evidence is therefore pending. Real provider evidence above is
  candidate evidence, not a claim that the public deployment or this PR's
  `main` base has switched to it.
