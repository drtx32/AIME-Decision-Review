# AIME Decision Review · Web Shell

The React + TypeScript + Vite shell lives at the repository root in `src/`
(`App.tsx`, `api.ts`, `main.tsx`, `styles.css`). Run `bun install && bun run
dev` from the repo root, or `bun run build` for production. Only the
non-sensitive `VITE_API_BASE_URL` may be configured client-side; API keys,
MCP Authorization headers, and model credentials stay server-side.

## Page structure

Home — input a historical decision.
Running — product-level progress (no chain-of-thought).
Result — T0 split, ex-ante / ex-post evidence, decision quality vs outcome,
attribution, lessons, checklist, citations.

## Adapter wiring

`src/api.ts` exports `createReview` + `pollResult` and an `adapterKind` flag.

- When `VITE_API_BASE_URL` is set, the adapter POSTs `/api/reviews`, polls
  `/api/reviews/:id`, and fetches `/api/reviews/:id/result`. It also
  implements the T11 boundary (deterministic-prediction language in the
  user reason → 422 surfaced to the user).
- Otherwise it falls back to a static mock so the UI stays demoable
  before the backend is reachable.