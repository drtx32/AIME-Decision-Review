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

Expected:
- review run completes
- ex-ante and ex-post evidence shown separately
- decision quality and outcome shown separately
- lessons/checklist produced
- key claims cite evidence

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

## 10. Integration

### T18 — Real MCP minimal path
Use at least one real Fuyao source and one real iFinD source if credentials/connectivity allow.

Expected:
- source/timestamp provenance preserved
- partial failures are visible

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
