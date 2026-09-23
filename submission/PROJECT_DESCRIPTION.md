# AIME Decision Review — Project Description

> Submission-facing 1–2 page summary. The longer canonical documents are
> `docs/SPEC.md`, `docs/AI_VALIDATION.md`, `docs/TEST_PLAN.md`, and
> `submission/AI_VALIDATION_RECORD.md`.

## Problem

A retail or research investor looking back on a single past investment
decision (a buy or sell that already happened) typically falls into one of
two failure modes:

- **Outcome bias.** A profitable trade is automatically judged "good" and a
  losing trade is automatically judged "bad", regardless of whether the
  process that produced the decision was sound.
- **Ex-post hindsight.** Information that was only published *after* the
  decision is folded back into the original reasoning, producing a clean
  narrative that nobody could have held at the time.

The result is that lessons extracted from past trades are usually wrong:
they reinforce whatever outcome happened, and they are not portable to
the next decision. AIME topic 11 is built around the idea that **decision
quality** and **outcome** must be evaluated separately, and that **only
information published at or before the decision timestamp T0** is allowed
to judge the original reasoning.

## Solution

AIME Decision Review turns one historical trade into a structured review
that:

1. **Identifies the decision timestamp T0** (exact, approximate, or
   unknown). If the user only knows the approximate date or a relative
   phrase ("around March 2024"), the system preserves that ambiguity and
   does not fabricate an exact ISO timestamp.
2. **Splits all retrieved evidence around T0** into `exAnte` (≤ T0) and
   `exPost` (> T0). Decision quality is reasoned only on `exAnte`; the
   `exPost` evidence is used to evaluate outcome and learning, never to
   judge the original decision.
3. **Runs a single bounded agent** (`DecisionReviewAgent`) that plans,
   retrieves evidence via Fuyao / iFinD MCP, aligns by T0, runs one
   reflection, and returns a structured JSON review — not an unstructured
   Markdown blob.
4. **Separates decision quality from outcome** as two distinct objects in
   the result so the UI can display them side by side.
5. **Returns reusable lessons and a next-decision checklist** grounded in
   the cited evidence, with fact / inference / uncertainty labelled.
6. **Fails safely.** A missing data source, an invalid request, or a
   provider outage produces an explicit `partial` or `failed` review —
   never a confident answer.

## Key features

- **Conversation-first UI** adapted from the Hermes WebUI interaction
  model: stable composer, sidebar history, independent Findings /
  Evidence / Learning context panel. See `docs/HERMES_ADAPTATION.md` for
  the reference boundary.
- **Natural-language extraction → explicit confirmation.** The user types
  a paragraph in Chinese or English; `DecisionExtractorAgent` produces
  one or more `DecisionCandidate` entries; the user reviews and confirms
  them before the Review Agent runs. This keeps the Review Agent's input
  explicit and traceable.
- **Multi-security and repeated-order support.** A single message like
  "I queued NVDA at $X three days in a row, none filled" produces three
  `DecisionCandidate` entries (one per day, all `executedAt = null`,
  `notes: attempted/unfilled`) instead of one merged entry.
- **Approximate T0 handling.** When the original message uses a relative
  or approximate time, the extractor returns `timePrecision:
  "approximate"` and leaves `executedAt = null` (or only an ISO backed by
  a real-world anchor). The Review Agent never invents a precise minute
  from an approximate one.
- **Structured review result** with `decisionQuality`, `outcome`,
  `attribution`, `biases`, `missedEvidence`, `lessons`, `nextChecklist`,
  `uncertainties`, and `citations` as separate fields.
- **Bounded reflection.** Exactly one self-check pass. Reflection can
  pass or downgrade to `partial` / `failed`. There is no infinite
  refinement loop.
- **Product-level trace only.** No hidden chain-of-thought is exposed
  to the browser; the SSE stream carries events like `review_created`,
  `market_data_retrieved`, `evidence_time_aligned`,
  `fact_consistency_checked`, `final_review_generated`.

## Agent workflow

```text
User chat message
   │
   ▼
DecisionExtractorAgent (LLM, structured JSON)
   │   - 1..N decision/order events
   │   - per-event timePrecision: exact | approximate | unknown
   │   - per-event executedAt: ISO | null (when only text or approximate)
   ▼
User confirms (or edits) extracted decisions
   │
   ▼
DecisionReviewAgent (state machine)
   │   created → planning → retrieving → analyzing → reflecting → completed|partial|failed
   │
   │   - plan: select intent-driven MCP servers (Fuyao / iFinD)
   │   - retrieve: call selected adapters, classify success / empty /
   │     transient_error / permanent_error — never translate failure into
   │     "no data"
   │   - align: classify every evidence row as ex_ante (≤ T0) or
   │     ex_post (> T0) based on `publishedAt` (not `retrievedAt`)
   │   - rate: structured judgment layer using the LLM
   │   - reflect: one bounded self-check for T0 leakage, numeric
   │     grounding, counter-evidence, outcome contamination
   ▼
Structured Review Result (JSON)
   │
   ▼
Frontend renders: Decision Summary | T0 split | Decision Quality vs
Outcome | Citations | Lessons | Next-decision checklist
```

The two agents are deliberately separate:

- **`DecisionExtractorAgent`** (`apps/api/src/agents/decision-extractor.ts`)
  only runs LLM-side structured extraction. It does not do review, does
  not call MCP, does not produce a `DecisionReviewResult`.
- **`DecisionReviewAgent`** (`apps/api/src/agents/decision-review.ts`)
  owns the full review lifecycle. It is deterministic in code for
  evidence retrieval, T0 alignment, and reflection; LLM is consulted only
  for the structured-judgment layer (rating, attribution, lesson
  phrasing). OpenAI Agents SDK integration is opt-in via
  `runWithOpenAIAgents` and is not exercised by default.

## MCP + data sources

All six Fuyao and all eleven iFinD servers are configured in the registry
(`apps/api/src/mcp/registry.ts`) but never enumerated eagerly. Each
server is resolved lazily, on demand, by the review plan:

- **Fuyao**: `meta`, `a-share`, `a-share-index`, `fund`, `futures`,
  `options`. Common stock review context routes to `a-share`,
  `a-share-index`; cross-asset context routes to `fund`, `futures`,
  `options`; `meta` resolves instruments/capabilities.
- **iFinD**: `ds`, `enterprise`, `law`, `stock`, `fund`, `edb`, `news`,
  `bond`, `global-stock`, `index`, `futures`. Common stock review context
  routes to `stock`, `index`, `news`, `edb`; conditional context to
  `fund`, `futures`, `global-stock`, `bond`; corporate / legal cases to
  `enterprise` and `law`; `ds` is used to inspect actual exposed
  capabilities when needed.

The registry uses **three behaviour paths**:

1. **No credentials configured** → `MockFuyaoAdapter` / `MockIFindAdapter`
   (deterministic fixtures, no fabricated data; honest `empty` /
   `transient_error` / `permanent_error` branches).
2. **Credentials configured but no intent→tool map** → no live adapter
   for that server (the system refuses to invent tool names).
3. **Credentials + operator-supplied
   `HITHINK_FINANCE_TOOL_MAP` / `IFIND_MCP_TOOL_MAP`** →
   `LiveMcpAdapter` drives JSON-RPC 2.0 (`initialize` → `tools/list` →
   `tools/call`) on each call. Server real-credential validation is
   pending — see `submission/AI_VALIDATION_RECORD.md` §"Real validation".

Tool error semantics are explicit and uniform across adapters:
`success` / `empty` / `transient_error` / `permanent_error`. A tool
failure never becomes "no data"; it becomes an explicit gap that
downgrades the review to `partial` or `failed`.

## Canonical example

A user types (simplified):

> "I bought 600519 (Maotai) at ¥1,720 on 2024-03-15 because the 2023
> annual report showed stable cash flow and the P/E had compressed back
> to the 5-year average. I held through the Q2 correction."

The pipeline:

1. `DecisionExtractorAgent` returns one candidate with `timePrecision:
   "exact"`, `executedAt: "2024-03-15T<…>Z"`, `price: 1720`,
   `action: "buy"`, plus `needsConfirmation: []`.
2. User confirms (or edits) the candidate.
3. `DecisionReviewAgent` enters `planning`, selects `fuyao:a-share` (price
   series + financial), `fuyao:a-share-index` (sector benchmark),
   `ifind:news` (event context), `ifind:edb` (macro: PBOC, CNF, ITF),
   and possibly `ifind:enterprise` (corporate filings).
4. The registry resolves adapters based on configured credentials. In
   the default fixture run, all six Fuyao + all eleven iFinD servers
   return deterministic, T0-aligned evidence (`publishedAt` ≤ T0 → exAnte;
   > T0 → exPost).
5. After retrieval, the agent enters `analyzing` (structured rating
   layer via the LLM), then `reflecting` (one bounded self-check), then
   `completed`.
6. The result page shows the T0 split: ex-ante price action, valuation
   context, macro context on one side; ex-post Q2 correction, Q3 rebound
   on the other. `decisionQuality` is reasoned only on ex-ante;
   `outcome` is reasoned only on ex-post. Lessons cite both sides.

## Technical highlights

- **T0-frozen reasoning** — a hard rule at the architecture layer, not a
  prompt-only rule. The agent's code, not the LLM, decides what counts
  as ex-ante vs ex-post based on `publishedAt`.
- **One agent, one bounded reflection** — no multi-agent orchestration,
  no infinite refinement loop. Fast, auditable, deterministic.
- **Broad MCP configuration, narrow resolution** — all six Fuyao + all
  eleven iFinD servers are configured but only the ones the plan asks
  for are constructed and exposed to the model. Tool schemas are not
  enumerated at startup.
- **Thin LLM provider abstraction** — `mock` is the default; the
  `openai-compatible` provider is plumbed for the real LLM path. No
  multi-architecture fallback routing in v0.1.
- **SQLite per-process** with `bun:sqlite`, persisted in the named
  `api-data` Docker volume. Multi-architecture deployment requires a
  migration (documented boundary).
- **Deterministic ZIP packaging** — `scripts/preflight.mjs` verifies the
  working tree, scans for forbidden paths and secret-pattern content,
  records git SHA + dirty state, and (with `--zip`) produces a
  byte-stable archive (sorted entries, normalised timestamps).
- **Hermes-inspired chat shell, not vendored** — interaction model
  inspired by `nesquena/hermes-webui` REST surface and UX guidance; no
  copied source (see `docs/HERMES_ADAPTATION.md` and
  `submission/LICENSE_INVENTORY.md` §2.1).

## Known limitations

These are honest boundaries reviewers should know about before judging
the submission. They are also tracked per-case in
`submission/TEST_NOTES.md` and `docs/AI_VALIDATION.md`.

- **Real LLM call not yet recorded.** The `openai-compatible` provider
  is plumbed but no credentialed end-to-end run has been recorded in the
  validation evidence. All fixture-validation paths use `LLM_PROVIDER=mock`.
- **Real Fuyao / iFinD calls not yet recorded.** The `LiveMcpAdapter` is
  wired but no credentialed run against the live Fuyao or iFinD HTTP
  endpoints has been recorded. The submission defaults to the mock
  adapters in the absence of credentials.
- **Visual regression not automated.** Responsive desktop layout (T15)
  is verified manually; no Playwright/Cypress harness in this slice.
- **Production deployment not yet executed.** `submission/DEPLOYMENT_EVIDENCE.md`
  remains the unfilled template; the public Web URL placeholder and the
  exact final deployed SHA are `UNKNOWN` until the production deploy
  step lands (out of scope for ELI-340).
- **P0 fixes status (as of `main` `b87e8fb`).** ELI-354 (chat
  interaction primitives) merged. ELI-358 (P0 archived-vs-active scope)
  merged at `b87e8fb`. PR #30 / ELI-355 (Markdown / CoT / conversation
  routing) is **pending**. ELI-362 (T0 datetime hotfix) and ELI-360
  (user BYOK browser-local) are **running**. This package documents the
  state at the recorded SHA; later fixes land in a follow-up PR before
  the final archive SHA is captured.
- **Scanned / image-only PDFs are not OCR'd in v0.1** unless a verified
  vision capability is configured. Vision probing is explicitly opt-in
  (`d1a2e8c`).
- **Fuyao / iFinD field availability depends on the configured account.**
  Tools advertised by the upstream server may not be available on the
  consumer's plan. Tool discovery (`ds`) is the source of truth; do not
  infer from server name alone.
- **Personal broker positions/orders are not assumed available** through
  Fuyao / iFinD market-data APIs. The extractor treats broker / portfolio
  statements as out-of-band inputs, never as automatic MCP queries.