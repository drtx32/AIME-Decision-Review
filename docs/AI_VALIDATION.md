# AI Usage & Validation Log

## Canonical documentation reconciliation — 2026-09-23

This file records validation evidence; it is not a substitute for the product
contract in `docs/SPEC.md`. The canonical contract now requires a
conversation-first desktop workspace with a stable bottom composer, centered
Settings overlay, controlled attachments, default-deny trusted web evidence,
direct Fuyao/iFinD structured chart data with native ECharts, and strict
ex-ante/ex-post correctness. Browser and direct-API regression cases are listed
in `docs/TEST_PLAN.md`.

The existing entries below are historical evidence and retain their original
environment, mode, and SHA. Controlled fake upstreams are not credentialed
Fuyao/iFinD/LLM validation. Any real-provider claim must include the exact
tested/deployed SHA and sanitized endpoint/tool, schema, timestamp, permission,
quota, and error evidence. Missing evidence remains a known limitation rather
than a successful validation result.

This file records how AI tools are used in the project, what they generated, how outputs were checked, and what humans corrected.

## ELI-318 MCP routing hardening — 2026-09-23

**AI/tool used**
- Oracle Codex with Bun 1.4.2, local TypeScript tests, and repository-only inspection.

**Task**
- Remediate the production MCP failure boundaries reported by the current smoke: cross-server guessed-tool dispatch, stale tool maps, and secondary-source failures incorrectly terminating a review.

**Output**
- Review plans now pass their preferred server allow-list into registry resolution, so a mapped tool is not dispatched to unrelated registries.
- Live MCP calls now require the configured tool to be present in that server's authenticated `tools/list`; absent tools return an explicit `permanent_error` without a `tools/call` request.
- A review with at least one successful source and a secondary permanent failure is `partial`, preserving both evidence and failure status. A run with no successful source remains `failed`.
- Compose now passes server-specific tool maps and endpoint suffix maps to the API container. No values were added to the repository.

**Validation**
- `apps/api`: `bun run typecheck` passed; `bun test` passed (211 tests, 903 expectations).
- Added regression coverage for preferred-server routing and no-call-on-unadvertised-tool behavior.
- Frontend: `npm run build` passed; Vite emitted only existing configuration/chunk-size warnings.
- `git diff --check` passed.
- Repository/runtime environment inspection found all credential variables unset; no credentialed production probe was attempted and no real-provider/MCP success is claimed here.
- Read-only public health check at `https://10jqka-aime.tong-xiao.top/api/health` returned `provider=mock`, `provider_configured=false`, `provider_status=unconfigured`, `requested_mode=mock`, `degraded=true`, and configured server keys `meta`, `a-share`, `stock`, `news`, `index` at `2026-09-23T07:30:34Z`. This confirms the current public host is not an accepted real-provider/MCP Golden Path.

**Human corrections**
- Kept the fix limited to routing, tool discovery safety, failure semantics, and deployment variable plumbing; did not guess or commit provider tool names.

**Residual risk / unresolved**
- The canonical host still requires an operator with access to the production secret store to run authenticated `initialize → tools/list` for each enabled server, select verified submission-path tools, and execute the current Golden Path. This local run cannot attest to current production connectivity.

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

## ELI-333 rerun on PR #7 final candidate — 2026-09-22

**AI/tool used**
- Oracle Codex with Bun 1.4.2, direct Hono API requests, a structured test provider, and MCP HTTP contract fixtures.

**Task**
- Re-run the exact required Chinese multi-trade narrative against PR #7 head `5d5ffec98ab5e3a824fc0c9c9afc1c4bf754e1b8`, including approximate T0 confirmation, findings grounding, temporal invariants, learning persistence, and follow-up.

**Output**
- Before the fix, extraction was correct (exactly 3 decisions: 金牛化工 SELL, 中粮糖业 BUY, 中粮糖业 SELL; 16.57; 2手→200 shares; lunch-break order placement in notes), but `/confirm` blocked all approximate decisions and PATCH could not clear `needsConfirmation`.
- Minimal fix: known approximate T0 can proceed after explicit confirmation; unknown/null T0 and unresolved confirmation questions still block. The result retains `timePrecision: approximate` and adds an explicit uncertainty.
- Structured model rating/checklist/attribution are consumed when valid; attribution evidence IDs are restricted to ex-ante IDs. Fallback claims now include actual evidence content rather than generic `Pre-T0 evidence supported...` text.
- Fuyao price-snapshot envelopes may use upstream `data.timestamp` as the snapshot item's `publishedAt` for temporal placement; `retrievedAt` remains separately recorded. News/announcement envelopes must still provide item-level publication time and never borrow envelope or retrieval time. Timestamp-less items become `empty`.

**Validation**
- `bun run typecheck` passed.
- Full API suite: 63 tests passed after updating the session contract for approximate confirmation; the new approximate-T0 persistence test and MCP snapshot timestamp test passed.
- Direct API golden path: initial confirm `422`; after explicit approximate confirmations, session `completed`, 3 results, symbols `金牛化工/中粮糖业/中粮糖业`, all 3 results retained `timePrecision=approximate`, all ex-ante/ex-post evidence respected T0 and `retrievedAt >= publishedAt`, and findings were non-template/evidence-grounded.
- All 3 results contained 3 lessons each; 5 deduplicated learning memories had aggregate strength 9, showing all lesson occurrences were persisted/reinforced rather than only the first result. Follow-up returned 201 and was grounded on the current session.
- No LLM/MCP credentials were available on the Oracle host, so real MiniMax/Fuyao/iFinD calls were not run. The live adapter contract keeps iFinD 404/permanent errors visible and does not fabricate success; no secrets were printed.

**Human corrections**
- No new architecture or PR was created. Changes are limited to the existing PR #7 candidate worktree.

**Residual risk / unresolved**
- The real provider and real upstream payload semantics still require credentialed host verification before submission. Price snapshot observation timestamps are usable for placing that snapshot around T0; they are not treated as news/event publication timestamps.

## ELI-355 conversation routing, capability status & CoT hygiene — 2026-09-23

**AI/tool used**
- Local OC on Windows with the Multica runtime; Bun 1.2.19 / bun test; TypeScript `tsc --noEmit`; Vite/Vitest 5 for the frontend; implementation in React + TypeScript + Vite (root).

**Task**
- First-turn conversation routing: a trade narrative sent through `POST /api/sessions/:id/messages` on a session without structured decisions must enter extraction → confirmation state, never a generic follow-up chat reply.
- Capability questions ("MCP/Fuyao/iFinD 能不能用") must be answered from backend runtime status, not the generic LLM, must not demand a structured-data template, must not expose credentials/URLs/tool names, and must work on an empty session.
- Raw provider chain-of-thought must never be persisted to or served from conversation content.
- After a confirmed review, worklog ActivityEvents (tool_completed/tool_updated/reasoning_summary) must coexist with the persisted assistant review summary, and follow-ups must be grounded in stored results without invoking MCP.
- Frontend markdown rendering must use a standard sanitized renderer (react-markdown + remark-gfm with raw-HTML stripping and safe-link guard).

**Output**
- `routes/api.ts` `/messages` now: detects capability questions first (token × intent, e.g. "MCP" + "能用"), answers from `buildRuntimeStatus`/`formatRuntimeStatusMessage` (`capability-status.ts`) without a provider-availability gate and without invoking the LLM; persists the user question; otherwise gates on provider readiness, persists the user message as `extracting`, and routes decision-free sessions into `DecisionExtractorAgent`, then to follow-up only once decisions exist.
- Provider state is config-honest: `configured-unverified` (creds + tool map + servers; "已配置…本轮未进行实际连接验证"), `degraded` (creds without tool map; will not call remote sources), `not-configured`. Manager note: config-based, not live-verified — real credentialed Fuyao/iFinD validation on a review host is still required before submission (unchanged known limitation).
- `chain-of-thought.ts` strips `<thinking>`/```think fences from provider text before persistence; verified end-to-end that the secret never appears in stored/returned conversation content.
- Frontend `MarkdownText.tsx` renders assistant/status messages with react-markdown + remark-gfm, `skipHtml` plus a raw-HTML pre-pass (dangerous elements removed whole, other tags stripped, `<` escaped), and drops `javascript:`/`vbscript:`/`data:` links; user messages remain plain `<p>`. Label changed from "AIME REVIEW AGENT" to "AIME".
- Root `package.json` gained react-markdown ^10.1.0, remark-gfm ^4.0.1, vitest ^5.0.1 and `"test": "vitest run"`; CI frontend job runs `npm test`.

**Validation**
- Backend `bun run typecheck` passed; `bun test`: 216 pass / 0 fail across 15 files (was 209/14; +7 new ELI-355 regressions).
- New `tests/eli-355-session-routing.test.ts`: first-turn extraction→accepted→draft; capability answer without LLM calls and without echoing `FUYAO_KEY_XYZZY`/`IFIND_AUTH_XYZZY`/secret base URLs; CoT never persisted; confirmed review persists assistant summary AND tool activities while follow-up is MCP-free (fetch counter unchanged).
- Frontend `npm test`: 5 pass (MarkdownText sanitization suite); `npm run build` (tsc -b && vite build) succeeded.
- No secrets printed or committed; secrets/URLs asserted absent from capability output and activity JSON.

**Human corrections**
- None outstanding; prior-pr discipline: changes are limited to routing, chain-of-thought, capability status, frontend rendering, root package.json/test deps, CI, docs.

**Residual risk / unresolved**
- Provider capability is config-derived (`configured-unverified`), not proven by a live call on a credentialed host.
- `docs/TEST_PLAN.md` unchanged: the new behavior is expressed as backend/frontend regression tests rather than a new manual case requirement.

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

---

## ELI-341 Settings / Usage / Model API contract — 2026-09-23 (Local CC)

**AI/tool used**
- Local CC (Claude agent) on branch `agent/local-cc/7df9d7e6cccf`
- Bun 1.2.19 + Hono 4 + Zod 3 + Node `crypto` (AES-256-GCM)

**Task**
- ELI-341: audit and complete the backend contracts needed by the
  Settings experience without changing the React shell and without
  deploying. Required endpoints:
  - authenticated `/api/auth/me` (already present from ELI-325);
  - self-service `/api/auth/change-password` (already present);
  - admin-only `/api/admin/users` CRUD (already present);
  - `/api/settings/model` GET/PUT — user-supplied provider/model/apiKey,
    encrypted at rest;
  - `/api/usage` GET — configured allowance / consumed / remaining,
    period metadata; never fabricate a provider quota;
  - `/api/models/capabilities` GET — provider/model capability matrix
    with vision only flagged `verified` when checked against the
    published capability list.
- Authorization tests proving normal users cannot invoke admin
  mutations; password/session tests; secret-redaction tests covering
  the new endpoints.

**Output (backend only — `apps/api/` and minimal `tests/` wiring)**
- New `apps/api/src/settings/` module:
  - `types.ts` — `ModelSettingsPayload`, `UsagePayload`,
    `UsageEventSummary`, `ModelCapabilitiesPayload`,
    `ModelProviderCapabilities`, `ModelCapabilityRow`. The Settings
    payload never carries a plaintext secret — only
    `hasApiKey: boolean` and a short non-reversible
    `apiKeyFingerprint`.
  - `crypto.ts` — AES-256-GCM secret encryption. Key resolution order:
    `AIME_SECRET_ENC_KEY` (32-byte base64) → derived from
    `INITIAL_ADMIN_PASSWORD` via scrypt with a public salt. Plaintext
    is never logged, never persisted, never returned over the wire.
  - `repository.ts` — `user_model_settings`, `usage_events`,
    `usage_periods` SQLite tables. `apiKeyCiphertext` is the only
    place the secret lives, and it is only readable by server code.
    The repo preserves the existing ciphertext when PUT omits
    `apiKey` so the Settings UI can rotate model/baseUrl without
    forcing re-entry.
  - `capabilities.ts` — static registry covering `openai-compatible`
    (GPT-4o / GPT-4o-mini / GPT-4 Turbo / GPT-3.5 Turbo / o1 /
    o1-mini / Claude 3.5 Sonnet / Claude 3 Opus) and `mock`. Vision
    is only `verified` for entries I have checked against the
    provider's published capability matrix; everything else is
    `static`/`unknown` so the UI never assumes an unverified
    capability.
  - `routes.ts` — three Hono sub-apps. `PUT /api/settings/model`
    rejects `mock` with a baseUrl/apiKey, rejects invalid baseUrl
    (non-http URL), enforces ≥ 1 char model, and returns
    `503 secret_store_unavailable` when an apiKey is supplied but no
    secret-encryption handle can be derived. `GET /api/usage` never
    fabricates an allowance — `allowance.source = "unknown"` and
    `remaining.known = false` until an operator configures a period.
    `GET /api/models/capabilities` returns the static matrix.
- `apps/api/src/routes/api.ts` mounts the three new sub-apps under
  `/api/settings`, `/api/usage`, `/api/models/capabilities`. The
  identity-contract guard (`rejectClientUserIdHeader`) already
  applies — settings routes cannot be spoofed via `x-user-id`.
- `apps/api/src/server.ts` constructs `SettingsRepository` alongside
  the existing repos.
- `apps/api/tests/helpers.ts` exposes `settingsRepo` so the new specs
  can inspect the persisted row directly.
- `apps/api/tests/settings.test.ts` — 30 new tests covering:
  - 401 unauth, 403 must_change_password on every new endpoint;
  - admin route remains admin-only when hit with a normal user
    cookie (the ELI-341 authorization bar);
  - secret redaction: GET never echoes plaintext or ciphertext,
    PUT stores ciphertext only, persisted SQLite row contains
    ciphertext (not the plaintext), `503 secret_store_unavailable`
    when the key handle is missing;
  - rotation: omitting `apiKey` on PUT preserves the existing
    ciphertext; empty-string `apiKey` clears it; `mock` rejects
    baseUrl/apiKey; invalid baseUrl → 400;
  - default payload when no row exists; documented
    `{provider: "mock", model: "mvp-mock-model"}` shape;
  - AES-GCM round-trip, fresh IV per encryption, tampering detected,
    fingerprint format pinned, key resolution to `null` when no
    source is configured;
  - usage: rolling 30-day default + `unknown` allowance semantics;
    configured period flows through; consumed is bounded by
    `[period.start, period.end]` (no future-fabrication);
    `null` allowanceTokens stays `unknown`; recent events surface
    in descending order; `at <= period.end` is enforced at the SQL
    layer (no client-side filter);
  - capabilities: providers returned, vision `verified` only on
    checked entries, `mock.configurable = false`, every entry has
    a `visionSource`;
  - x-user-id header is rejected on the new surface; disabled
    accounts are auto-logged-out of settings + usage.

**Validation**
- `bun run typecheck` → 0 errors.
- `bun test` → 84/84 pass, 380 expect() calls across 5 files (was
  54/253; +30 new tests / +127 expect() calls). The 54 existing
  tests continue to pass — no regression in the ELI-313/ELI-325
  contracts.
- Live smoke against `bun src/index.ts` on port 18735:
  - bootstrap admin → login → change-password → cookie path
    opens `/api/settings/model`, `/api/usage`,
    `/api/models/capabilities`;
  - `PUT /api/settings/model` with `apiKey: "sk-smoke-test-DO-NOT-LEAK-9876543210"`
    returns `{hasApiKey: true, apiKeyFingerprint: "7a91…79a5"}` and
    no plaintext;
  - subsequent `GET` does not contain `smoke-test-DO-NOT-LEAK`
    anywhere in the response (leak count: 0);
  - `x-user-id: usr_forged` header on `/api/settings/model` returns
    `400 x_user_id_header_not_allowed`;
  - `/api/admin/users` still 200 with the admin cookie (admin
    surface unchanged).
- Secret scan on `apps/api/src`:
  - 0 matches for `sk-*`, `Bearer …`, `Authorization: Bearer …`,
    `anthropic|claude-key|sk-ant`, hardcoded `AIME_SECRET_ENC_KEY`,
    or stored plaintext test secrets in source.

**Human corrections**
- Tightened `capabilities.ts` so vision is `verified` only on the
  providers whose capability matrix I have actually read. Any
  unverified entry stays `static: false` so the Settings UI never
  silently enables image attachments against a model we have not
  validated.
- Aligned `consumed.tokens` with the period end at the SQL layer
  (`WHERE at >= ? AND at <= ?`) rather than relying on the client to
  filter. Recorded events that fall outside the current period remain
  in the audit trail but are not summed into the live counter.
- Capabilities route is gated on `mustChangePassword` so the
  Settings UI cannot be exercised by a user who has not yet
  completed the first-login password change. Documented inline.
- Settings PUT that omits `apiKey` preserves the existing ciphertext
  so the UI can rotate model/baseUrl without forcing the user to
  re-enter the key. Empty-string `apiKey` is the explicit clear.

**Residual risk / unresolved**
- Live recording of usage events is plumbed (the
  `SettingsRepository.recordUsage` API and the per-period sum
  query) but not yet called from the Decision Review Agent. The
  agent's existing LLM call already returns `usage: { input, output }`
  through `providers/index.ts`; wiring that into
  `recordUsage(reviewId=..., kind="llm.completion", ...)` per
  `compose(...)` is a one-line follow-up in
  `apps/api/src/agents/decision-review.ts`. Tracked for ELI-342 or
  whichever issue owns the next LLM-integration slice.
- The `mock` provider has no vision capability and is marked
  non-configurable; image attachment against it stays disabled
  through ELI-337 by virtue of this contract.

**Branch / PR**
- Branch: `agent/local-cc/7df9d7e6cccf` (already in place from
  workspace bootstrap; the ELI-341 changes are the first commit on
  this branch).
- Head SHA to be recorded after `git commit` below.
- Backend-only diff. No changes under `src/` (frontend shell),
  `apps/web/`, `docker-compose.yml`, or `.env.example`. No Docker
  deployment is performed from this branch.

## ELI-340 submission skeleton — 2026-09-23

The integrated submission skeleton adds a tracked-artifact manifest, deployment
evidence template, license inventory, test notes, validation record, and a
deterministic preflight/packaging path. It records fixture validation separately
from credentialed provider validation and generates build metadata without
committing runtime secrets or build output.

## ELI-358 conversation library UX — 2026-09-23

**AI/tool used**
- Local CC with Bun 1.2.19 and TypeScript 5.9.3.

**Task**
- Replace the hardcoded `新建复盘` titles and `进行中` sidebar badges
  with deterministic auto-titling, real per-session lifecycle status,
  full-content search, and user-scoped rename / archive / soft-delete
  actions, without redesigning the existing chat shell or sidebar.

**Output**
- `apps/api/src/db/sqlite.ts` adds `archivedAt`, `deletedAt`, and
  `manualTitle` columns plus `listSessionsForUser`, `applyAutoTitle`,
  `renameSession`, `setSessionArchived`, `softDeleteSession`, and the
  pure `deriveSessionTitle` helper.
- `apps/api/src/routes/api.ts` exposes `/sessions?q=&archived=`,
  `PATCH /sessions/:id`, `POST /sessions/:id/archive`,
  `POST /sessions/:id/unarchive`, and `DELETE /sessions/:id`. The
  create-session and message-edit flows now call `applyAutoTitle` so a
  freshly extracted session picks a meaningful title without a second
  LLM call.
- `src/api.ts` extends `reviewApi.listSessions` to forward `q` /
  `archived` and adds `renameSession`, `archiveSession`,
  `unarchiveSession`, and `deleteSession`.
- `src/App.tsx` replaces the title-only client-side filter with a
  debounced server-side search, swaps the hardcoded `进行中` badge for
  a status pill keyed on the server lifecycle, and adds an inline kebab
  menu (`Rename` / `Archive` or `Unarchive` / `Delete`) plus a
  centered `RenameDialog` and `DeleteDialog`. The default view hides
  archived sessions; an `Active / Archived` chip switches the scope.
- `src/styles.css` adds the new sidebar filter, kebab trigger / menu,
  status pill colors, and dialog action styles. All additions reuse
  the existing palette and typography tokens.

**Validation**
- `bun test` from `apps/api/` — 219 pass / 0 fail (10 new
  `session-library.test.ts` cases covering auto-title, single-symbol
  fallback, manual-rename lock, input validation, content search,
  completed/needs_input status, archive/unarchive persistence, soft
  delete with user scoping, cross-user hijack rejection, and the
  pure title helper).
- `bun run build` from the repo root — frontend bundles cleanly (CSS
  30.05 kB, JS 841.67 kB) with no type or template errors.
- `bun run preflight` — passes with one expected dirty-tree warning
  (current change set).

**Human corrections**
- Renamed the optimistic local placeholder session entry after the
  `listSessions` refresh, so the sidebar reflects the server-derived
  title as soon as the response arrives instead of briefly showing a
  client-only summary.
- Decision: do not allow editing the title of an already-running
  session through the kebab menu while it is `running`; rename is
  still allowed (matches the existing user requirement that completed
  reviews stay editable). The backend treats `manualTitle` as a
  one-way lock regardless of lifecycle.

**Residual risk / unresolved**
- Search is a bounded `LIKE` against title, decision symbols/names/
  reasons, and message bodies. Acceptable for v0.1 MVP traffic; if
  session volume grows significantly, swap for SQLite FTS5 or move
  index creation to a dedicated migration.
- Soft-deleted sessions keep their attached `review_runs` and
  evidence rows for audit; a hard-delete maintenance path is not in
  v0.1.

## ELI-358 — P0 archived-vs-active scope regression (PR #26)

**AI / tool used**
Local CC agent fixing a user-reported regression found in PR #26
smoke testing: the sidebar's Active / Archived filter chips rendered
identical lists because `listSessionsForUser` returned a superset for
the `archived=1` branch.

**Task**
Tighten the sidebar scope contract so `archived=1` strictly returns
sessions with `archivedAt IS NOT NULL` and the omitted-`archived`
default strictly returns sessions with `archivedAt IS NULL`. Pin the
contract with API regression (disjoint ID sets, search respects scope,
empty archive truly empty, archive/unarchive moves between scopes) and
a frontend wire-contract regression for the URL builder.

**Output**
- `apps/api/src/db/sqlite.ts` — `listSessionsForUser` now derives a
  `scopeFilter` string (`AND archivedAt IS NOT NULL` vs
  `AND archivedAt IS NULL`) and applies it to BOTH the no-query and
  with-query SQL branches, replacing the previous ternary that emitted
  a no-`archived` filter when `includeArchived=true`. Option renamed
  to `archived?: boolean` to make the wire contract explicit.
- `apps/api/src/routes/api.ts` — passes `archived: archivedScope` into
  `listSessionsForUser`; the `archived=1` / omitted query split is
  preserved on the wire.
- `src/sessions-query.ts` — new pure helper `buildSessionsQueryString`
  exports the URL builder so a regression test can pin the contract
  without pulling in the Vite `import.meta.env` reference in
  `src/api.ts`. Active view serializes no `archived` parameter;
  archived view serializes `archived=1`; `q` is always URL-encoded
  and combined with the active scope flag.
- `src/api.ts` — `listSessions` delegates the query-string build to
  `buildSessionsQueryString`. No behavior change for callers.
- `apps/api/tests/session-library.test.ts` — 4 new API regression
  cases: `archived scope is strictly disjoint from active scope`
  (2 active + 2 archived, asserts disjoint ID sets and the
  `archivedAt` polarity of each row); `archived=1 with no archived
  rows returns empty`; `search respects archive scope — no
  cross-scope leakage` (matches a unique phrase in both an active and
  an archived row, asserts each scope only returns its own);
  `archive/unarchive moves session between scopes immediately`.
- `apps/api/tests/sidebar-filter-frontend-contract.test.ts` — new
  file, 5 cases pinning the wrapper wire contract (active sends no
  `archived`; archived sends `archived=1`; `q` is encoded; blank
  `q` is dropped; the two URLs are mutually exclusive).

**Validation**
- `bun test` from `apps/api/` — **228 pass / 0 fail** (was 219 before
  this regression fix; +9 = 4 new API cases + 5 new frontend wire
  cases).
- `bun run build` from the repo root — clean (CSS 30.05 kB,
  JS 841.67 kB; same bundle sizes as before, no new top-level deps).
- `bun run preflight` — 0 errors (one expected dirty-tree warning
  pre-commit).

**Human corrections**
- Switched the option name from `includeArchived` to `archived` so
  the wire contract is unambiguous; the route handler still maps
  `?archived=1` to `archived: true`, but the database helper no
  longer reads as "include archived in the result" (which was the
  wording that allowed the regression).
- Extracted `buildSessionsQueryString` as a pure helper instead of
  testing the wrapper through a JSDOM/React harness; the project has
  no frontend test runner, and the wire contract is the layer that
  actually broke.

**Residual risk / unresolved**
- Same v0.1 LIKE-vs-FTS5 trade-off as the parent entry.
- The Active / Archived chips still rely on a single `archiveFilter`
  React state; concurrent toggles during an in-flight request could
  briefly race the local list. Acceptable for the smoke path;
  pinning request sequencing is deferred.


