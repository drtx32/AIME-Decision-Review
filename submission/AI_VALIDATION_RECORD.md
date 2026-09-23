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