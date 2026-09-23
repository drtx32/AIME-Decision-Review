# AIME Decision Review

AI-native historical investment decision review product for the AIME test.

## Canonical project docs

All agents and contributors MUST read the repository docs before implementation or when context is uncertain:

- `docs/SPEC.md` — canonical product and technical specification
- `docs/AI_VALIDATION.md` — AI usage and validation log
- `docs/TEST_PLAN.md` — required test coverage and evidence
- `docs/AUTOMATION.md` — GitHub Actions → Multica supervision
- `docs/DEPLOYMENT.md` — canonical production path, Compose pinning, secrets, health checks, backup, and rollback

If an Issue conflicts with `docs/SPEC.md`, the explicit newer Issue instruction wins; otherwise follow the docs.

## Security

Never commit API keys, Authorization headers, MCP credentials, cookies, or other secrets. Use server environment variables / GitHub Secrets only.

## Production deploy path

Production deploys must run from:

```bash
~/projects/aime-decision-review
```

Do not run production from `/root/multica_workspaces/...` or another transient agent/issue workspace. See `docs/DEPLOYMENT.md` for migration, SQLite-volume preservation, and rollback details.

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
  ├─ agents/decision-review one bounded agent: T0 → plan → retrieve → align → reflect → result
  ├─ mcp/registry           Fuyao (6) + iFinD (11), lazy-loaded by intent
  ├─ providers/             thin LLM provider abstraction (mock + openai-compatible)
  ├─ db/sqlite              ReviewRepository + UserRepository (bun:sqlite)
  └─ config.ts              env parsing with documented fail-fast for missing secrets
```

Secrets stay on the API container only; the frontend bundle never sees
them. The Decision Review Agent is single-pass, T0-frozen, and never
exposes hidden chain-of-thought — only product-level trace events.

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
