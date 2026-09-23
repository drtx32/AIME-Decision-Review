# AIME Decision Review

AI-native historical investment decision review product for the AIME test.

> Chinese version: [【README-zh.md / 中文】](./README-zh.md)

## Problem

A retail or research investor looking back on a single past investment
decision usually falls into one of two failure modes:

- **Outcome bias.** A profitable trade is automatically judged "good" and
  a losing trade is automatically judged "bad", regardless of whether the
  process that produced the decision was sound.
- **Ex-post hindsight.** Information that was only published *after* the
  decision is folded back into the original reasoning, producing a clean
  narrative that nobody could have held at the time.

Lessons extracted under those failure modes are wrong: they reinforce
whatever outcome happened, and they are not portable to the next
decision.

## Solution

AIME Decision Review forces a **T0-frozen** review:

1. The user types a natural-language paragraph about one historical trade.
2. `DecisionExtractorAgent` produces one or more structured
   `DecisionCandidate` entries (symbol, action, time, price, rationale).
3. The user confirms (or edits) the extracted decisions.
4. `DecisionReviewAgent` plans evidence retrieval, calls Fuyao / iFinD
   MCP, splits every evidence row into `exAnte` (≤ T0) or `exPost` (> T0)
   based on `publishedAt`, runs one bounded reflection, and returns a
   structured `DecisionReviewResult`.
5. `decisionQuality` and `outcome` are returned as **separate objects**,
   never collapsed.
6. Lessons and a next-decision checklist are grounded in cited evidence.

If a tool returns empty / transient_error / permanent_error, the review
is downgraded to `partial` or `failed`. **Tool failure never becomes
"no data".**

## Key flow

```text
User natural-language input
   │
   ▼
DecisionExtractorAgent  ──  structured DecisionCandidate[]
   │
   ▼
User confirmation (or edit)
   │
   ▼
DecisionReviewAgent      ──  state machine
   │                          created → planning → retrieving →
   │                          analyzing → reflecting → completed |
   │                          partial | failed
   │
   ▼
Structured DecisionReviewResult
   │   decisionQuality | outcome | attribution | biases | missedEvidence |
   │   lessons | nextChecklist | uncertainties | citations
   │
   ▼
Findings / Evidence / Learning panel
```

The two agents are intentionally separate:

- **`DecisionExtractorAgent`** (`apps/api/src/agents/decision-extractor.ts`)
  runs LLM-side **structured extraction only**. It does not call MCP,
  does not produce a `DecisionReviewResult`, and does not judge the
  decision.
- **`DecisionReviewAgent`** (`apps/api/src/agents/decision-review.ts`)
  owns the **full review lifecycle**. Evidence retrieval, T0 alignment,
  and reflection run in code (not in the LLM); the LLM is consulted only
  for the structured-judgment layer. OpenAI Agents SDK integration is
  opt-in via `runWithOpenAIAgents` and is not exercised by default.

## Demo input

The canonical demo input is the simplified Maotai trade:

```text
我 2024-03-15 在 ¥1,720 买了 600519（贵州茅台）。
当时看了 2023 年报，现金流稳定，估值回到五年中枢。
二季度回调我扛住了，三季度反弹。
```

The expected pipeline on this input (fixture path):

- `DecisionExtractorAgent` returns one candidate with `timePrecision:
  "exact"`, `executedAt: "2024-03-15T…Z"`, `action: "buy"`, `price: 1720`,
  `needsConfirmation: []`.
- After confirmation, `DecisionReviewAgent` enters `planning`, selects
  `fuyao:a-share`, `fuyao:a-share-index`, `ifind:news`, `ifind:edb`,
  and possibly `ifind:enterprise`, runs the lifecycle, returns
  `completed` with a populated Findings / Evidence / Learning panel.

For approximate T0, multi-security, and repeated unfilled-order
variants, see `submission/TEST_NOTES.md` §"Golden-path matrix".

## Canonical project docs

All agents and contributors MUST read the repository docs before implementation or when context is uncertain:

- `docs/SPEC.md` — canonical product and technical specification
- `docs/AI_VALIDATION.md` — AI usage and validation log
- `docs/TEST_PLAN.md` — required test coverage and evidence
- `docs/AUTOMATION.md` — GitHub Actions → Multica supervision
- `docs/DEPLOYMENT.md` — canonical production path, Compose pinning, secrets, health checks, backup, and rollback
- `docs/THIRD_PARTY.md` — third-party licenses and reference-code attribution boundary

If an Issue conflicts with `docs/SPEC.md`, the explicit newer Issue instruction wins; otherwise follow the docs.

## Security

Never commit API keys, Authorization headers, MCP credentials, cookies, or other secrets. Use server environment variables / GitHub Secrets only.

## Production deploy path

Production deploys must run from:

```bash
/root/projects/aime-decision-review
```

Do not run production from `/root/multica_workspaces/...` or another transient agent/issue workspace. See `docs/DEPLOYMENT.md` for migration, SQLite-volume preservation, and rollback details.

## LLM provider

The production LLM provider is **MiniMax-M3**, reached via the
`openai-compatible` adapter in `apps/api/src/providers/`. Credentials
(`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL=MiniMax-M3`) are loaded from the
server `.env` only — they never enter the repository. The mock provider
is the default for fixture / CI runs.

## Run with Docker Compose

The root Compose file builds the static frontend and Bun/Hono API as separate services. Browser `/api` requests are proxied through the web container. SQLite is stored in the named `api-data` volume.

```bash
cp .env.example .env
chmod 600 .env
docker compose up -d --build
```

By default the only host-published service is the web container at `http://localhost:13608`. The API listens on Compose-internal port `3000` and is reached through the web proxy, for example:

```bash
curl -fsS http://127.0.0.1:13608/health
curl -fsS http://127.0.0.1:13608/api/health
```

Set `WEB_PORT` in the root `.env` only if the host web port must change. Backend credentials are passed only to the API container and are never exposed to the frontend build.

For frontend-only development, `npm install && npm run dev` may use the explicit development mock adapter unless `VITE_API_BASE_URL` is set. The root `.env.example` is the only runtime configuration template; do not create an app-local `.env.example`.

## Submission skeleton

`submission/` is the reproducible pre-submit package: a manifest, an AI
usage / validation record that separates fixture from real validation, a
deployment-evidence template, a license / attribution inventory, and
`scripts/preflight.mjs` which verifies the working tree is submission-ready
and (optionally) builds a deterministic ZIP.

```bash
# From the repository root:
node scripts/preflight.mjs                 # verify only — exits non-zero on issues
node scripts/preflight.mjs --zip out.zip  # verify + build a deterministic submission ZIP

# Tests for the preflight script itself (bun:test, in apps/api's test runner):
cd apps/api && bun test ../../tests/preflight/
```

See `submission/MANIFEST.md` for what must and must not ship, and
`submission/DEPLOYMENT_EVIDENCE.template.md` for the deployment record a
human fills in once the production deploy is verified.

## Architecture summary

```text
Browser
  └─ React + TypeScript + Vite + Bun (src/, root npm workspace)
      │  /api/* proxied by Nginx to the API container
      ▼
Hono (apps/api, Bun runtime)
  ├─ routes/api.ts          POST /api/reviews, GET …/events, GET …/result, GET /health
  ├─ routes/auth/*          login / logout / me / change-password / admin users
  ├─ agents/decision-extractor.ts  LLM-side structured extraction only
  ├─ agents/decision-review.ts     single bounded agent:
  │                                 T0 → plan → retrieve → align → reflect → result
  ├─ agents/reflection.ts          one bounded self-check (T0 leakage,
  │                                 numeric grounding, counter-evidence,
  │                                 outcome contamination)
  ├─ mcp/registry           Fuyao (6) + iFinD (11), configured broadly,
  │                         resolved lazily by intent
  ├─ mcp/adapters/*         MockFuyao / MockIFind / LiveMcp (JSON-RPC 2.0
  │                         when credentials + intent→tool map are set)
  ├─ providers/             thin LLM provider abstraction (mock +
  │                         openai-compatible, MiniMax-M3 in prod)
  ├─ db/sqlite              ReviewRepository + UserRepository (bun:sqlite)
  └─ config.ts              env parsing with documented fail-fast for missing secrets
```

### Fuyao / iFinD MCP

The MCP registry (`apps/api/src/mcp/registry.ts`) holds the full
six-Fuyao + eleven-iFinD server set but **never enumerates every tool
schema at startup**. Adapters are resolved lazily by the review plan:

- **Fuyao** (`meta`, `a-share`, `a-share-index`, `fund`, `futures`,
  `options`): `meta` resolves instruments/capabilities; `a-share` /
  `a-share-index` cover common stock review context; `fund`, `futures`,
  `options` provide cross-asset context where supported.
- **iFinD** (`ds`, `enterprise`, `law`, `stock`, `fund`, `edb`, `news`,
  `bond`, `global-stock`, `index`, `futures`): `stock` / `index` /
  `news` / `edb` cover common stock review context; `fund` / `futures`
  / `global-stock` / `bond` are conditional; `enterprise` / `law`
  handle corporate / legal cases; `ds` is used to inspect actual
  exposed capabilities.

Three behaviour paths:

1. **No credentials configured** → `MockFuyaoAdapter` /
   `MockIFindAdapter` (deterministic, honest `transient_error` /
   `permanent_error` / `empty` branches).
2. **Credentials configured but no `HITHINK_FINANCE_TOOL_MAP` /
   `IFIND_MCP_TOOL_MAP`** → no live adapter for that server (we refuse
   to fabricate tool names).
3. **Credentials + operator-supplied tool map** → `LiveMcpAdapter`
   drives JSON-RPC 2.0 (`initialize` → `tools/list` → `tools/call`).
   Server real-credential validation is pending; see
   `submission/AI_VALIDATION_RECORD.md`.

Tool adapters distinguish four outcomes: `success` / `empty` /
`transient_error` / `permanent_error`. A tool failure never becomes
"no data"; it becomes an explicit gap that downgrades the review to
`partial` or `failed`.

### T0 / ex-ante / ex-post design

T0 is identified at the architecture layer, not in the prompt:

- `DecisionExtractorAgent` returns each candidate with
  `timePrecision: "exact" | "approximate" | "unknown"` and either an
  ISO `executedAt` (when exact and grounded) or `null` (when only text
  or approximate).
- `DecisionReviewAgent` classifies every evidence row as `exAnte`
  (`publishedAt ≤ T0 - 1d`, strict) or `exPost` (`publishedAt ≥ T0 + 14d`,
  illustrative floor) using `publishedAt`, **never** `retrievedAt`.
- `decisionQuality` is reasoned only on `exAnteEvidence`; `outcome` is
  reasoned only on `exPostEvidence`. The result schema enforces this
  separation at the JSON level.
- One bounded reflection pass checks: did ex-post leak into ex-ante?
  did outcome contaminate decision-quality? are unsupported causal
  claims labelled uncertain? See
  `apps/api/src/agents/reflection.ts`.

The product trace (SSE stream) exposes product-level events only — no
hidden chain-of-thought. Per `docs/SPEC.md` §15.

## Test commands (recap)

```bash
# Frontend typecheck + production build:
npm ci && npm run build

# Backend typecheck + bun:test:
cd apps/api && bun install --frozen-lockfile && bun run typecheck && bun test

# Container smoke:
docker compose config
docker compose build
```