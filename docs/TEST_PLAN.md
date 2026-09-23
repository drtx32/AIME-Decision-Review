# Test Plan

## Goal

Demonstrate that the Decision Review product works on its core path and fails safely when data/tools are incomplete or unavailable.

## Required pre-submit evidence

For each case record:
- input
- environment/mode
- observed result
- pass/fail
- screenshot/log/command evidence where appropriate
- known limitation

## 1. Core vertical slice

### T01 — Normal historical decision review
Input:
- valid A-share symbol
- buy/sell action
- historical T0
- user reason
- one or multiple decisions/trades where supported

Expected:
- review run completes
- ex-ante and ex-post evidence shown separately
- decision quality and outcome shown separately
- lessons/checklist produced
- key claims cite evidence

### T01a — Conversation-first shell
Expected:
- empty chat shows three neutral starter prompts;
- clicking a starter fills the composer without submitting;
- sidebar/history, central conversation, and Findings/Evidence/Learning panel
  remain distinct;
- Settings is centered independently of those panels;
- no dense dashboard or form-first generator is the primary entry point.

### T01b — Composer and message actions
Exercise draft text, attachment picker/add/remove, stop/cancel, copy, edit,
delete, retry, reconnect, and reload where applicable.

Expected:
- the draft survives every non-submit action;
- the composer stays at the bottom and validation/errors appear immediately
  above it without moving it;
- edit/resend invalidates dependent outputs safely;
- stopped/partial runs do not persist normal Findings/Learning;
- copy/edit/delete/retry actions perform their stated operation.

### T01c — Conversation library (sidebar) — ELI-358
Exercise the sidebar list, search, status badges, and per-row actions
(rename, archive, delete).

Expected:
- a freshly created session receives a deterministic title derived from
  the extracted decision symbols (e.g. `万科A / 一鸣食品 复盘`,
  `万科A 决策复盘`) after the first accepted turn, instead of every row
  being labeled `新建复盘`;
- the sidebar status reflects the real lifecycle: completed reviews
  show `已完成`, needs-input shows `需补充`, partial/failed/cancelled
  show their own labels — never a hardcoded `进行中`;
- server-side search matches the conversation and review content: a
  phrase that only appears in a message body or review output still
  finds the session, even when the title does not contain that phrase;
- rename persists across reload and locks out later auto-title
  rewrites (re-extracting the same message must not overwrite a
  manually-set title);
- delete is user-scoped and confirmation-gated; the deleted session
  disappears from Recent Reviews, search, and the archive view, and
  cannot be read by another user;
- archive hides the session from the default Recent Reviews view, the
  session can be unarchived, and the `Active / Archived` filter chip
  switches scope;
- kebab menu clicks never open the session — the kebab trigger and
  row click are distinct.

## 2. Time-bound reasoning

### T02 — T0 boundary
Prepare evidence immediately before and after T0.

Expected:
- post-T0 evidence never appears as support for original decision quality
- post-T0 evidence may appear only in outcome/ex-post analysis

### T03 — Missing publication timestamp
Expected:
- evidence is rejected, marked uncertain, or excluded from time-bound judgment
- system does not silently treat retrieval time as publication time

## 3. Tool/data failure semantics

### T04 — Empty result
Mock or query a case with no matching data.

Expected:
- state is empty
- UI says source returned no result
- no fabricated evidence

### T05 — Transient failure
Simulate HTTP 5xx/timeout.

Expected:
- classified as transient_error
- bounded retry if implemented
- if still failing, review becomes partial/uncertain
- system does not translate failure into “no data”

### T06 — Permanent/invalid request
Simulate invalid parameter/schema error.

Expected:
- no blind repeated retry
- clear error classification

### T06a — Attachment boundaries
Exercise allowed image/docx/xlsx/csv/pdf types, over-limit files, unsupported
extensions, scanned/no-text PDF, and provenance display.

Expected:
- allowlisted types and count/file/parsed-size limits are enforced;
- image vision is used only when the configured capability is verified;
- no fake OCR claim is made;
- PDF unsupported states are explicit;
- filename/page/sheet/cell-range provenance is retained;
- uploaded context is not silently classified as ex-ante evidence.

### T06b — Trusted web evidence
Exercise approved primary source, approved secondary source, unknown domain,
redirect, SSRF-shaped URL, missing publication time, and no-source cases.

Expected:
- policy is backend default-deny and unknown URLs are labeled unverified;
- redirects are revalidated and SSRF protections apply;
- `publishedAt` and `retrievedAt` remain distinct;
- no trusted source produces an explicit evidence gap;
- no arbitrary JS/headless browsing is required in v0.1.

## 4. Grounding

### T07 — Numeric evidence mismatch
Evidence contains one financial value; mock generated result contains a different value.

Expected:
- validation/reflection flags mismatch or result is rejected/corrected

### T08 — Unsupported causal claim
Evidence supports an event but not causality.

Expected:
- claim is marked uncertain/unsupported rather than stated as fact

## 5. Outcome bias

### T09 — Good process, bad outcome
Expected:
- system can score/reason about decision quality positively while outcome is negative

### T10 — Bad process, good outcome
Expected:
- profitable outcome does not automatically make decision quality positive

## 6. Compliance

### T11 — Request for deterministic prediction/direct trade instruction
Expected:
- product stays within review scope
- avoids guaranteed return / deterministic prediction / direct buy-sell instruction

## 7. Security

### T12 — Secret scan
Check repository and built frontend for:
- API keys
- Authorization headers
- MCP tokens
- cookies

Expected:
- none present

### T13 — Trace redaction
Expected:
- product trace/logs never print secret headers

## 8. Frontend

### T14 — Mock-only demo
Expected:
- frontend can demonstrate complete Home → Running → Result flow before real backend is connected

### T15 — Responsive desktop layout
Expected:
- T0 split remains readable
- evidence cards and citations usable

## 9. Backend

### T16 — Health check
GET /health

Expected:
- 200

### T17 — Review API contract
Exercise:
- POST /api/reviews
- GET /api/reviews/:id
- GET /api/reviews/:id/events
- GET /api/reviews/:id/result

Expected:
- contract matches frontend types

### T17a — Normalized chart contract
Exercise K-line/volume/MA, timeline with trade markers, comparison, and
provider-supported valuation/financial trend.

Expected:
- native ECharts renders inline in the conversation and can expand/collapse;
- source/provider, symbol, timezone, timestamps, units, adjustment mode,
  `retrievedAt`, and applicable `publishedAt` are explicit;
- direct Fuyao/iFinD structured-data failures produce an unavailable/degraded
  state, never a normal finding or fabricated target price;
- after-hours/non-trading-day markers are not silently snapped to a wrong bar;
- the right Findings/Evidence/Learning panel and stable composer remain intact.

### T17b — First-turn routing, capability status, CoT hygiene
Exercise:
- first trade narrative via `POST /api/sessions/:id/messages` on a session
  without structured decisions;
- capability question ("MCP/Fuyao/iFinD 能不能用") on an empty session;
- a provider response containing `<thinking>` chain-of-thought;
- confirmed session followed by a follow-up question.

Expected (covered by `apps/api/tests/eli-355-session-routing.test.ts`):
- narrative transitions to extraction → confirmation state ("已识别 N 笔决策，
  请确认每笔 T0、方向与数量"), never a generic follow-up chat reply;
- capability questions are answered from runtime configuration without invoking
  the LLM, mention Fuyao/iFinD, never demand a structured-data template, and
  contain no secrets, URLs, or tool names;
- raw chain-of-thought never appears in stored or returned conversation content;
- confirmed sessions expose worklog activities (tool_completed/tool_updated/
  reasoning_summary) alongside the persisted assistant review summary, and
  follow-ups are grounded in stored results without new MCP calls.

## 10. Integration

### T18 — Real MCP minimal path
Use at least one real Fuyao source and one real iFinD source if credentials/connectivity allow.

Expected:
- source/timestamp provenance preserved
- partial failures are visible

### T18a — Credentialed versus fixture validation
Record real credentialed Fuyao, iFinD, and LLM probes separately from fixture
tests. Each real probe must include endpoint/tool, schema/field mapping,
units/timezone, quota/error behavior, account permission, exact tested SHA, and
sanitized evidence. Never turn a controlled fake upstream into a claim of real
provider validation.

## 11. Container orchestration

### T19 — Compose build, health, and persistence
Expected:
- root `docker compose build` succeeds using the frontend/backend Dockerfiles
- API `/health` and web `/health` return 200 after health-gated startup
- a review written through the web `/api` proxy completes successfully
- SQLite remains writable and persists in the named `api-data` volume
- images contain no secrets and the API runtime remains non-root

## Pre-submit checklist

- [ ] Web URL works in clean browser session
- [ ] README contains setup and architecture
- [ ] SPEC matches implementation
- [ ] AI_VALIDATION has real entries
- [ ] main path tested
- [ ] data failure tested
- [ ] compliance boundary tested
- [ ] secrets absent from repo/build/logs
- [ ] known limitations documented
- [ ] exact tested/deployed SHA recorded
