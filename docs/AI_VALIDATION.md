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