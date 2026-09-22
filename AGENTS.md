# AGENTS.md

This file defines the canonical repository working rules for AI coding agents and human contributors.

## 1. Source of truth

Before implementation, and whenever context is uncertain, read:

1. `docs/SPEC.md` — canonical product and technical specification
2. `docs/TEST_PLAN.md` — required validation and test evidence
3. `docs/AI_VALIDATION.md` — AI usage, validation, and human corrections
4. `README.md` — project entry point and security rules

Instruction precedence:

1. Newer explicit Issue instruction
2. `docs/SPEC.md`
3. This file
4. Local implementation preference

Do not create a competing product specification in another file.

## 2. Product invariants

This repository implements AIME topic 11: historical investment decision review and learning.

Hard rules:

- Identify the decision timestamp T0.
- Information published after T0 must not be used to judge whether the original decision was reasonable.
- Separate evidence into ex-ante and ex-post.
- Separate decision quality from final outcome/P&L.
- Distinguish fact, inference, and uncertainty.
- Important claims must be traceable to evidence.
- Do not turn correlation into causality without support.
- Do not output deterministic return predictions, guaranteed profits, or direct trading instructions.
- Partial/missing/failed data must be explicit, never silently normalized into a confident answer.

## 3. Repository architecture

Target structure:

```text
apps/
  web/   # React + TypeScript + Vite + Bun
  api/   # Bun + Hono + OpenAI Agents SDK TS

docs/
  SPEC.md
  TEST_PLAN.md
  AI_VALIDATION.md
```

Frontend and backend are developed independently and integrated through the documented API contract.

## 4. Frontend rules

- Use React + TypeScript + Vite + Bun.
- Do not use Streamlit.
- Do not embed secrets in the frontend bundle.
- Prefer lightweight dependencies.
- Keep T0 / Ex-Ante / Ex-Post visually prominent.
- Do not expose hidden chain-of-thought; only product-level progress/trace.
- Support mock mode so the product remains demoable before backend integration.

## 5. Backend rules

- Use Bun + Hono + TypeScript.
- Use OpenAI Agents SDK TS for agent loop / MCP / HITL / tracing primitives.
- Keep one thin LLM provider implementation in v0.1; do not build multi-provider routing unless explicitly requested.
- Use SQLite for MVP persistence.
- Use bounded reflection only.
- Tool adapters must distinguish:
  - success
  - empty
  - transient_error
  - permanent_error
- Never translate tool failure into "no data".

## 6. MCP rules

Configure capabilities broadly but load/select lazily by review intent.

Fuyao registry:
- meta
- a-share
- a-share-index
- fund
- futures
- options

iFinD registry:
- ds
- enterprise
- law
- stock
- fund
- edb
- news
- bond
- global-stock
- index
- futures

Do not eagerly enumerate or inject every available tool schema into the model when a smaller relevant capability set is sufficient.

## 7. Security rules

Never commit, print, log, or expose:

- API keys
- Authorization headers
- MCP credentials
- cookies
- bearer tokens
- secret-bearing traces
- local .env files

Use only server environment variables / GitHub Secrets for credentials.

Required placeholder names may include:

- HITHINK_FINANCE_API_KEY
- IFIND_MCP_AUTHORIZATION
- LLM_API_KEY
- LLM_BASE_URL
- LLM_MODEL

Frontend must never receive secret values.

## 8. Git workflow

- Do not push directly to `main`.
- Use feature branches.
- Keep frontend changes out of `apps/api/`.
- Keep backend changes out of `apps/web/`.
- If a root-level shared file must change, call it out explicitly in the PR.
- Prefer small, reviewable commits.
- Before completion, run the relevant tests/build/typecheck and record evidence.

## 9. Documentation and validation

During material AI-assisted development:

- append real entries to `docs/AI_VALIDATION.md`
- update `docs/TEST_PLAN.md` only when test requirements genuinely change
- update `docs/SPEC.md` only when a design change becomes canonical

Do not leave validation documentation until the final hour.

## 10. Completion bar

An issue is not complete until:

- implementation works
- relevant tests/build checks pass
- secrets are absent from source/build/logs
- behavior matches `docs/SPEC.md`
- required validation evidence is recorded
- known limitations are documented

## 11. Multi-component architecture planning

For projects involving multiple frontend, backend, database, or deployment
components, first write and validate an overall architecture plan before
implementing component-level changes. When appropriate, prefer Docker Compose
as the local/prod-like orchestration path, unless the canonical project SPEC
explicitly requires another deployment approach.
