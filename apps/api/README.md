# AIME Decision Review API

Backend MVP for AIME topic 11 — historical investment decision review.

This service accepts a single historical decision, runs the **Decision Review Agent**
on top of an OpenAI Agents SDK TS primitive, selectively queries Fuyao / iFinD MCP
servers for evidence, classifies it around **T0** (the decision timestamp), and
returns a structured review that separates **decision quality** from final
**outcome**.

The vertical slice is intentionally minimal: the goal is a runnable skeleton with
the right shape, hard rules enforced, and a mock provider so the loop works
without real LLM credentials.

## Stack

- **Bun** runtime (>= 1.1)
- **Hono** HTTP framework
- **OpenAI Agents SDK TS** for the agent loop / MCP / HITL / tracing primitives
- **SQLite** via `bun:sqlite` for persistence
- **TypeScript** strict

## Quick start

```bash
cd apps/api
bun install
cp .env.example .env   # fill values if you have them; otherwise leave empty
bun run dev            # http://localhost:3000
```

With no `LLM_API_KEY` and `LLM_PROVIDER=mock`, the API runs an in-process mock
agent that exercises every code path (planning → retrieving → analyzing →
reflecting → result) and returns a structured review with deterministic mock
evidence.

## API

| Method | Path                          | Purpose                          |
|--------|-------------------------------|----------------------------------|
| GET    | `/health`                     | Liveness probe                   |
| POST   | `/api/reviews`                | Create + start a review run      |
| GET    | `/api/reviews/:id`            | Review run metadata + status     |
| GET    | `/api/reviews/:id/events`     | Product-level trace events       |
| GET    | `/api/reviews/:id/result`     | Final structured result          |

### Create a review

```bash
curl -sS -X POST http://localhost:3000/api/reviews \
  -H 'content-type: application/json' \
  -d '{
    "symbol": "600519",
    "market": "CN",
    "action": "buy",
    "executedAt": "2024-03-15T00:00:00Z",
    "price": 1620.5,
    "quantity": 100,
    "userReason": "Strong Q4 2023 channel checks; brand pricing power intact."
  }'
```

Response:

```json
{
  "id": "rev_...",
  "status": "planning",
  "decision": { "...": "..." }
}
```

### Get the result

```bash
curl -sS http://localhost:3000/api/reviews/<id>/result
```

The result follows the schema in `docs/SPEC.md` §10.

## Architecture

```
src/
  index.ts                # entrypoint — boots server
  server.ts               # Hono app factory
  config.ts               # env parsing
  types/                  # shared Zod schemas + TS types
  providers/              # thin LLM provider abstraction (mock + openai-compatible)
  mcp/                    # MCP registry — Fuyao (6) + iFinD (11), lazy by intent
  db/                     # SQLite repository
  agents/                 # Decision Review Agent state machine + reflection
  tools/                  # tool adapters w/ success/empty/transient_error/permanent_error
  routes/                 # Hono routes (health, api/reviews)
tests/                    # bun:test specs
```

## Hard rules enforced

- T0 is parsed and frozen from the request `executedAt`.
- All evidence carries `publishedAt`; evidence without it is rejected from
  time-bound reasoning.
- Evidence is split into `ex_ante` / `ex_post` by comparing `publishedAt` to T0.
- The reflection pass is bounded (single iteration) and checks:
  ex-post leak, numeric grounding, correlation vs causation, ignored
  counter-evidence, outcome contamination.
- Tool adapters never translate a failure into "no data"; the result carries the
  classified status so the UI can show partial/uncertain correctly.

## Environment variables

See `.env.example`. Real values **must** come from server environment variables
or GitHub Secrets — never commit them.

## Tests

```bash
cd apps/api
bun test
```

Covers:

- normal historical review (vertical slice with mock provider)
- empty MCP result
- transient tool failure
- API contract smoke test (`/health`, create → poll → result)

## Limitations of v0.1

- Single agent; no multi-agent orchestration.
- One LLM provider at a time (no routing/fallback).
- Mock provider is the default; real Fuyao / iFinD connections are wired but not
  verified against live credentials in this slice.
- Reflection is one bounded pass — no iterative improvement loop.