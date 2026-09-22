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
- Production upstream field names: the controlled-fake upstreams used
  `{items: Evidence[]}`. Some real upstreams use `data` or `list`
  instead. `LiveHttpAdapter.itemsField` is configurable per server;
  real-gateway smoke is the right time to confirm the field name and
  flip the default if needed.
- `LiveHttpAdapter` does not yet retry on transient errors. The agent
  harness treats a transient adapter as `partial` and surfaces it in
  `uncertainties`; retry/back-off is a follow-up if real upstream SLOs
  require it.
- The frontend `VITE_API_BASE_URL` is a single base URL with no per-env
  switching; production deploys must inject it at build time.
- CI `frontend` job runs from repo root without a root
  `package-lock.json`; `npm ci` may fail until a root lockfile exists
  or the job's `working-directory` is set to `apps/web` (out of scope
  for ELI-318).

---

## ELI-318 MCP transport rework — 2026-09-22 (Oracle CC)

**AI/tool used**
- Oracle CC (Claude Opus 4.8) on branch `feature/eli-318-real-llm-mcp-integration`

**Task**
- Replace the earlier REST-shaped `LiveHttpAdapter` (which fabricated
  `/{serverKey}/{intent}` paths) with a real MCP JSON-RPC 2.0 client that
  drives `initialize → tools/list → tools/call` against the Fuyao and iFinD
  MCP gateways, per user instruction:
  - Fuyao: `https://fuyao.aicubes.cn/mcp/<serverKey>`, header `X-api-key`.
  - iFinD: `https://api-mcp.51ifind.com:8643/ds-mcp-servers/<serverKey>`,
    header `Authorization`.
  - Lazy load — never enumerate every tool schema at startup.
  - Tool name per intent must come from operator config (`*_TOOL_MAP`); we
    refuse to fabricate tool names.
  - T0 wall: real `publishedAt` only; never substitute `retrievedAt`.
  - AIME / MiniMax / OpenAI-compatible provider stays as-is.

**Output**
- `apps/api/src/mcp/adapters/mcp-client.ts` (new): `McpStreamableHttpClient`
  drives real MCP JSON-RPC 2.0 — `initialize` (with `protocolVersion`,
  `clientInfo`, `capabilities`), `tools/list` (cached), `tools/call`. Handles
  `Mcp-Session-Id`, `Accept: application/json, text/event-stream`, per-RPC
  `AbortController` timeout, `TransientMcpError` / `PermanentMcpError`
  classification. Credentials forwarded in headers but never logged.
- `apps/api/src/mcp/adapters/live-mcp.ts` (new): `LiveMcpAdapter` wraps the
  client. `toolForIntent` is operator-supplied (one closure per server key).
  `canHandle(intent)` returns true only when an intent has a tool name
  configured — so a missing map means no live call is ever issued.
  `parseToolContent()` accepts MCP `content[].text` carrying JSON, an array,
  or `{items|data|results}`; `normalizeItems()` rejects items lacking
  `publishedAt` and never substitutes `retrievedAt`.
- `apps/api/src/mcp/adapters/live-http.ts` (deleted): the REST-shaped
  adapter is gone — replaced by the real MCP client.
- `apps/api/src/mcp/registry.ts`: builds `LiveMcpAdapter` when credentials
  are present; uses `cfg.fuyao.toolMap` / `cfg.ifind.toolMap` to populate
  `toolForIntent`. Endpoint composition: `<baseUrl>/<serverKey>` (refuses
  to double-append if base already ends with the server key).
- `apps/api/src/config.ts`: added `fuyao.toolMap` / `ifind.toolMap`
  parsed from new env vars `HITHINK_FINANCE_TOOL_MAP` and
  `IFIND_MCP_TOOL_MAP` (format: `intent:toolName,intent2:toolName2`).
- `.env.example` (root): added `HITHINK_FINANCE_TOOL_MAP` and
  `IFIND_MCP_TOOL_MAP` placeholders; refreshed smoke harness notes to
  describe the real MCP protocol path.
- `apps/api/scripts/mcp-smoke.ts` (rewritten): now speaks JSON-RPC 2.0
  against the upstream. In fake mode it boots a `Bun.serve` MCP server
  that responds to `initialize` / `tools/list` / `tools/call` and records
  inbound `Authorization` / `X-api-key` headers. In real-gateway mode it
  drives the production endpoint straight. Credential mask = `{scheme,
  prefix(6), length}`, never raw value.
- `tests/live-http.test.ts` (rewritten): mocks the MCP JSON-RPC protocol
  end-to-end. Covers initialize → tools/list → tools/call round-trip,
  Authorization / X-api-key header forwarding (iFinD sends only
  `Authorization`), 5xx → transient, 4xx → permanent, JSON-RPC error →
  permanent, timeout → transient, missing `publishedAt` → empty,
  upstream `isError` → permanent, content parsing shapes (`items`,
  `data`, `results`, single object, plain text), alternate timestamp
  field names, and T18 vertical slice (real Fuyao + real iFinD side by
  side with verified `initialize`/`tools/call` invocations on each).

**Validation**
- `bun run typecheck` (apps/api) → 0 errors.
- `bun test` → **31 / 31 pass**, 178 `expect()` calls across 5 files
  (was 22 / 22 before rework; +9 new protocol tests).
- `bun test tests/openai-compatible.test.ts` → 2 / 2 pass (LLM provider
  untouched per instruction).
- `bun run scripts/llm-smoke.ts` (LLM harness, fake mode) → still passes;
  no change to the OpenAI-compatible contract.
- `bun run apps/api/scripts/mcp-smoke.ts --provider=fuyao --server=a-share`
  (fake mode) → `tools.list count=1, tools.call content_parts=1`,
  `request_count=3` (initialize + tools/list + tools/call), inbound
  `X-api-key` and `Authorization` present with redacted prefix `sk-fak`.
- `bun run apps/api/scripts/mcp-smoke.ts --provider=ifind --server=news`
  (fake mode) → same shape; inbound `Authorization: Bearer …` present
  with redacted prefix `sk-fak`; `X-api-key` absent (iFinD only).
- Frontend `npm run build` → clean.
- Secret scan → only intentional test fixtures (`sk-test-*`, `sk-fake-*`,
  `Bearer ifind-token-xyz`); no production credentials anywhere.

**Server-env credential probe (this turn)**

```
LLM_API_KEY             = MISSING
LLM_BASE_URL            = MISSING
LLM_MODEL               = MISSING
HITHINK_FINANCE_API_KEY = MISSING
HITHINK_FINANCE_BASE_URL= MISSING
IFIND_MCP_AUTHORIZATION = MISSING
IFIND_MCP_BASE_URL      = MISSING
```

All seven credential env vars MISSING in this Oracle runtime → real-gateway
smoke not exercised this turn; smoke harness still runs against an
in-process JSON-RPC fake to prove the bearer path end-to-end without any
real credential.

**Mock fallback**
- Mock layer (`MockFuyaoAdapter` / `MockIFindAdapter`) is unchanged and
  still selected when credentials are missing. Mock paths exercise the
  full agent state machine end-to-end (T01 / T04 / T05 / T07 / T08 /
  T09 / T10).

**TEST_PLAN crosswalk update**
- T18 — previously *partially satisfied* via REST-shaped client and
  controlled fake. Now: real MCP protocol exchange is unit-tested
  end-to-end (`initialize` / `tools/list` / `tools/call` round-trip,
  session-id cache, header forwarding, error classification, schema
  parsing). Real-gateway trace against `fuyao.aicubes.cn` /
  `api-mcp.51ifind.com` still pending credentialed environment.

**Human corrections**
- Did not relax T0 wall: `publishedAt` from the upstream is mandatory;
  `retrievedAt` is recorded separately and never substituted.
- Did not relax T11 (deterministic-prediction) rejection — still enforced
  in `routes/api.ts`.
- Did not relax the "don't fabricate tool names" rule — without an
  operator-supplied `*_TOOL_MAP`, `canHandle(intent)` returns false and
  the registry falls back to mock adapters for that server.
- Did not touch `OpenAICompatibleProvider`, `MockModelProvider`, or the
  LLM-only structured-judgment layer — AIME provider stays OpenAI-
  compatible, config from env, secrets only in env.

**Residual risk / unresolved**
- Real Fuyao + iFinD gateway smoke is still pending credentialed
  environment. `apps/api/scripts/mcp-smoke.ts` will switch to
  `mode=real-gateway` automatically as soon as the env vars are set.
- Live upstream tool names are not yet enumerated (the production
  gateway may expose different names than we guessed in the examples).
  The operator-supplied `*_TOOL_MAP` env var is the documented override.
- MCP session replay (`Mcp-Session-Id`) is implemented but not all
  servers require it; some servers may also need `notifications/initialized`
  after `initialize` (we send it but don't error if the server returns
  204 / 200 with empty body).
- The iFinD base URL `/ds-mcp-servers/<serverKey>` pattern is based on
  the user-provided host; we have not yet verified against the
  official documentation which server keys are exposed at that host.

PR #3 stays Draft; status `in_progress`; assignee Oracle CC.
