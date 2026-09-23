# AIME Decision Review — Canonical Product Specification v0.1

## 0. Contract

This is the canonical implementation contract for AIME topic 11, “Investment
Decision Review and Learning.” Agents must read it, `docs/TEST_PLAN.md`,
`docs/AI_VALIDATION.md`, and `README.md` before implementation. Newer explicit
Issue instructions take precedence; otherwise implementation must not silently
diverge from this document.

## 1. Product shape

AIME is a conversation-first workspace for reviewing one or more historical
investment decisions. The user starts by describing the decision naturally,
then confirms compact extracted chips/cards and continues the review in the
same conversation. It is not a form-first generator, dense 问财-style terminal,
or permanent dashboard.

Desktop shell:

- compact conversation/history sidebar;
- central chat and review surface;
- right panel limited to `Findings`, `Evidence`, and `Learning`;
- stable bottom composer, which must not move when results, errors, attachments,
  or charts load or expand;
- Settings is a truly centered overlay independent of the sidebar and right
  panel.

The conversation/history sidebar is the conversation library:

- Each entry's title is auto-derived from the first up-to-two unique
  decision symbols (or names) after the first accepted extraction
  (e.g. `万科A / 一鸣食品 复盘`, `万科A 决策复盘`); the temporary
  placeholder `新建复盘` only shows when extraction has not produced
  any usable symbol yet.
- The status badge reflects the real per-session lifecycle
  (`草稿 / 需补充 / 进行中 / 已完成 / 部分完成 / 失败 / 已停止`),
  not a hardcoded `进行中`; completed reviews keep showing `已完成`
  after reload.
- The search input is server-side and matches title, decision
  symbols/names/reasons, and message bodies; a phrase that only
  appears in a message or review output still finds the session.
- Each row exposes an unobtrusive hover/focus kebab menu with
  `Rename`, `Archive`/`Unarchive`, and `Delete` actions. Action
  clicks must not open the session.
- Rename persists server-side and locks out later auto-title
  rewrites. Delete is soft and user-scoped; archived sessions are
  hidden from the default Recent Reviews view but discoverable via
  the `Active / Archived` filter.

The empty conversation shows three neutral starter prompts. Clicking one fills
the composer but never submits it. Draft text survives attachment picker/add/
remove and all other non-submit actions. The detailed structured review remains
available beside or after the conversation, not as the entire product shell.

The running state shows truthful product-level events only. A step is complete
only after the backend confirms it. If the configured LLM is unavailable, the
review stops with an explicit service message; production must not present a
polished mock review. Explicitly labeled mock/demo mode may remain available.

## 2. Mature chat behavior

User messages support copy, edit, and delete. Assistant messages support copy
and retry. Stop/cancel must be functional. Editing or resending invalidates
dependent downstream outputs safely. Stopped or partial runs must never persist
normal `Findings` or `Learning`. Validation and error messages render directly
above the composer without changing its position.

The product may support authenticated users and session management. Credentials,
provider configuration, MCP endpoints, and authorization material are
server/operator concerns; normal users must not see raw secrets or endpoint
configuration. Sanitized provider status is acceptable.

First narrative turns: when a conversation message arrives on a session without
structured decisions, the backend extracts candidate decisions for T0/direction/
quantity confirmation instead of producing a generic follow-up chat reply.
Capability/status questions ("MCP/Fuyao/iFinD 能不能用") are answered by the
backend from runtime configuration without invoking the LLM and never demand a
structured-data template. Follow-up chat answers are grounded in the stored
review results, are never served as if they were MCP evidence, and never render
provider chain-of-thought verbatim. Assistant/status messages render through a
sanitized standard Markdown pipeline (raw HTML stripped, safe links only).

## 3. Review correctness

The review accepts one or multiple historical decisions and aligns, where
available, trades, original rationale, market data, and events on a timeline.
Each decision has an execution timestamp `T0`. Evidence published after `T0`
cannot justify the original decision; it may be used only for ex-post/outcome
analysis. `retrievedAt` never substitutes for `publishedAt`.

The result must keep these dimensions separate:

- decision quality versus outcome/P&L;
- fact versus inference versus uncertainty;
- ex-ante evidence versus ex-post evidence;
- supported, unsupported, and unknown attribution;
- behavioral bias, missed evidence, and limitations.

Important claims cite auditable sources and timestamps. A completed review may
produce durable reusable lessons, checklists, or decision context only from
grounded evidence and a successful completion. Tool, provider, or validation
failure must remain explicit and cannot become a normal review completion.
Never provide deterministic return predictions, guaranteed profit, or direct
buy/sell instructions.

Minimum structured result:

```ts
interface ReviewResult {
  decisions: DecisionReview[];
  exAnteEvidence: Evidence[];
  exPostEvidence: Evidence[];
  decisionQuality: unknown;
  outcome: unknown;
  attribution: unknown;
  biases: unknown[];
  missedEvidence: unknown[];
  uncertainties: unknown[];
  lessons: unknown[];
  nextChecklist: unknown[];
  citations: unknown[];
}
```

## 4. Attachments and user context

Allow only these user-uploaded types: PNG/JPG/JPEG/WEBP images, DOCX, XLSX,
CSV, and PDF. Enforce file-count, file-size, and parsed-size limits. Preserve
provenance including filename and, where applicable, page, sheet, and cell
range.

Images may use configured model vision only when that capability has been
verified. Do not claim OCR or add a fake OCR fallback. PDF v0.1 supports basic
text extraction only; scanned/no-text PDFs return an explicit unsupported state.
Uploaded material is user-provided context and does not automatically become
historical ex-ante evidence. Its provenance and time semantics must be shown
before it is used in a time-bound conclusion.

## 5. Trusted web evidence

Web retrieval is backend-controlled and default-deny. Prefer official primary
sources, followed by explicitly approved professional secondary sources. An
unknown domain cannot silently become evidence; a user-provided unknown URL is
labeled unverified.

Store and display `publishedAt` separately from `retrievedAt`. Revalidate
redirect destinations, protect against SSRF, and do not use arbitrary
JavaScript/headless browsing in v0.1. No trusted source means an explicit
evidence gap, not a fabricated or silently omitted conclusion.

## 6. Data and chart architecture

MCP remains the agent/tool reasoning interface. Deterministic structured chart
series may and should use direct Fuyao REST/OpenAPI, with iFinD QuantAPI/
OpenAPI as an enhancement or fallback when the connected account supports the
needed capability. Do not route deterministic series through LLM text
generation. Normalize provider payloads server-side into one typed chart
contract.

Charts are native ECharts rendered inline in an assistant turn when the AI
conversation determines they are useful. They are lightweight and expandable,
not permanent dashboard widgets. The right panel remains `Findings`/`Evidence`/
`Learning`.

MVP chart contract:

- K-line + volume with OHLC and MA5/MA10/MA20/MA60 where supported, with
  day/week/month periods;
- decision/event price timeline aligning verified events and the user’s actual
  trade/decision markers;
- comparison line for a requested benchmark, index, industry, or other
  explicitly named series;
- simple valuation or financial trend only for fields supported by the real
  provider/account.

Every series exposes provider/source, symbol, timezone, timestamps, units,
adjustment mode, `retrievedAt`, and `publishedAt` or event timestamps where
applicable. A-share timestamps default to Asia/Shanghai only when consistent
with source semantics. After-hours or non-trading-day decisions must not be
silently snapped to a wrong candle. Analyst/consensus target prices may be
shown only when supplied by a real provider/account and clearly labeled; never
synthesize a target or “recommended price.”

Missing, unsupported, unauthorized, empty, timed-out, or failed chart data
renders an explicit degraded/unavailable state. It must not become a normal
finding or conclusion, and chart loading/expansion must not move the composer.

## 7. Architecture and provider boundaries

```text
React/Vite web app
  → Hono review/chart APIs
  → OpenAI Agents SDK TS + one OpenAI-compatible provider
  → selected MCP tools and/or direct structured-data adapters
  → normalized evidence/chart contracts
  → SQLite persistence
```

The v0.1 LLM implementation is one MiniMax/OpenAI-compatible provider using
server-only `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`, and `LLM_BASE_URL`.
Do not add dynamic multi-provider routing. Configure Fuyao’s six registries
(`meta`, `a-share`, `a-share-index`, `fund`, `futures`, `options`) and iFinD’s
eleven registries (`ds`, `enterprise`, `law`, `stock`, `fund`, `edb`, `news`,
`bond`, `global-stock`, `index`, `futures`), but discover/load them lazily by
review intent. Do not infer capability from a server name.

The API must preserve explicit `success`, `empty`, `transient_error`, and
`permanent_error` semantics. Core review routes are:

- `POST /api/reviews`
- `GET /api/reviews/:id`
- `GET /api/reviews/:id/events`
- `GET /api/reviews/:id/result`
- `GET/POST /api/chart-data` (normalized chart requests)
- `GET /health`

Conversation library routes (ELI-358) are user-scoped and never leak across
users:

- `GET /api/sessions?q=&archived=1` — list with optional full-content search
  and archive scope. `archived=1` strictly scopes to sessions with
  `archivedAt IS NOT NULL`; an omitted `archived` parameter strictly
  scopes to sessions with `archivedAt IS NULL`. The two scopes return
  disjoint ID sets; the `archived=1` branch never falls back to a
  superset that includes active rows. Soft-deleted sessions are excluded
  from both scopes.
- `POST /api/sessions` — create + extract; title is auto-derived from
  extracted symbols unless the user has manually renamed the session.
- `GET /api/sessions/:id`
- `PATCH /api/sessions/:id` — rename; persists server-side and sets a
  manual-title lock.
- `POST /api/sessions/:id/archive`, `POST /api/sessions/:id/unarchive`
- `DELETE /api/sessions/:id` — soft delete; the session disappears from
  Recent Reviews, search, and the archive view.

SSE is preferred for progress; polling is acceptable. Product traces expose
only safe events such as retrieval and time alignment, never hidden reasoning,
prompts, responses containing secrets, or authorization material.

## 8. Persistence and security

SQLite may persist review runs, decisions, evidence, results, and lessons.
Long-term reusable learning/context is written only after a grounded completed
review. No trading execution, vector database, generic crawler, dashboard
builder, heavy scheduler, or arbitrary browsing subsystem is in v0.1.

Never commit or log API keys, cookies, tokens, authorization headers, MCP
credentials, or secret-bearing traces. Secrets stay in server environment
variables/GitHub Secrets and are never sent to the frontend bundle.

## 9. Validation and delivery

Direct API regressions cover representative single- and multi-trade narratives,
T0 classification, provider failure states, chart contracts, and auth/session
boundaries. Browser regressions cover composer stability, draft preservation
through attachment actions, stop/edit/delete/copy/retry, centered Settings,
inline chart load/expand, and reconnect/reload where relevant. Real
credentialed Fuyao/iFinD/LLM validation is distinct from fixture/mock tests and
must be reported as such.

Deployment and submission notes must state the exact tested/deployed Git SHA,
environment/mode, observed result, and known limitations. The acceptance path
is a working conversation review with auditable evidence, truthful degradation,
and reusable grounded learning—not a visually complete report generated without
verified provider evidence.
