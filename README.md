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

## Product purpose and AI role

This product implements AIME topic 11: review one historical investment decision and turn the review into reusable learning. It identifies T0, separates evidence known before T0 (ex-ante) from later outcome information (ex-post), and evaluates decision quality separately from P&L. Results include attribution, uncertainty, missed evidence, lessons, and a next-decision checklist.

The frontend is React + TypeScript + Vite. The API is Bun + Hono with OpenAI Agents SDK TS primitives, lazy intent-based Fuyao/iFinD MCP adapters, SQLite persistence, and cookie-based authentication. The bounded AI role is retrieval planning, timestamp alignment, fact/inference/uncertainty classification, structured review generation, and one reflection pass for ex-post leakage, grounding, unsupported causality, counter-evidence, and outcome bias. Hidden chain-of-thought is not exposed.

## Authentication and managed users

The API bootstraps one admin on a fresh database from the server-only `INITIAL_ADMIN_USERNAME` and `INITIAL_ADMIN_PASSWORD` variables. The first login must change the bootstrap password. There is no public registration: an admin creates normal users, can issue one-time temporary passwords or reset/disable/enable accounts, and cannot disable or delete the last enabled admin. Sessions use HttpOnly cookies; identity is derived from the session rather than client-supplied user headers.

The root `.env.example` is the only runtime template. In addition to `COMPOSE_PROJECT_NAME`, `WEB_PORT`, `VITE_API_BASE_URL`, `SQLITE_PATH`, `LOG_LEVEL`, and the LLM/MCP variables, it documents the two bootstrap-admin variable names. Real values belong only in the protected server `.env` or deployment secret store and never in the web build.

## Data sources and current limits

The configured data registries cover Fuyao groups (`meta`, `a-share`, `a-share-index`, `fund`, `futures`, `options`) and iFinD groups (`ds`, `enterprise`, `law`, `stock`, `fund`, `edb`, `news`, `bond`, `global-stock`, `index`, `futures`). Real credentialed LLM/Fuyao/iFinD smoke remains pending; the verified deployment evidence uses the mock provider.

The verified public entrypoint is [https://10jqka-aime.tong-xiao.top](https://10jqka-aime.tong-xiao.top). Oracle host evidence verified the homepage, `/api/health` with HTTP 200, and public POST `/api/reviews` with HTTP 202. The host exposes only web `13608:80`; API `3000` is Compose-internal and SQLite uses the named `aime-decision-review_api-data` volume. Remaining limits include single-instance SQLite, no trade execution, no real-time monitoring, no vector database, no multi-agent orchestration, and no GBrain LessonStore integration.

## Product purpose and design

This product implements AIME topic 11: review one historical investment decision and turn the review into reusable learning. It addresses hindsight bias by identifying T0, separating evidence known before T0 (ex-ante) from later outcome information (ex-post), and evaluating decision quality separately from P&L. The result includes attribution, uncertainty, missed evidence, lessons, and a next-decision checklist.

The frontend is React + TypeScript + Vite. The API is Bun + Hono with OpenAI Agents SDK TS primitives, lazy intent-based Fuyao/iFinD MCP adapters, and SQLite persistence. The AI role is bounded to retrieval planning, timestamp alignment, fact/inference/uncertainty classification, structured review generation, and one reflection pass for ex-post leakage, grounding, unsupported causality, counter-evidence, and outcome bias. Hidden chain-of-thought is not exposed.

The configured data registries cover Fuyao groups (`meta`, `a-share`, `a-share-index`, `fund`, `futures`, `options`) and iFinD groups (`ds`, `enterprise`, `law`, `stock`, `fund`, `edb`, `news`, `bond`, `global-stock`, `index`, `futures`). Real credentialed gateway/model smoke remains pending; the verified deployment path currently uses the mock provider.

## Runtime variables

The root `.env.example` documents names and purposes without values. `WEB_PORT` is the only host-published port and defaults to `13608`; `VITE_API_BASE_URL` defaults to `/api`; `COMPOSE_PROJECT_NAME` pins the SQLite volume identity. `SQLITE_PATH`, `LOG_LEVEL`, `LLM_PROVIDER`, `LLM_MODEL`, `LLM_BASE_URL`, `LLM_API_KEY`, `HITHINK_FINANCE_BASE_URL`, `HITHINK_FINANCE_API_KEY`, `HITHINK_FINANCE_SERVERS`, `IFIND_MCP_BASE_URL`, `IFIND_MCP_AUTHORIZATION`, and `IFIND_MCP_SERVERS` configure the API container. Backend credentials never enter the web build.

## Verified deployment status

The deployed entrypoint is [https://10jqka-aime.tong-xiao.top](https://10jqka-aime.tong-xiao.top). Oracle host evidence verified the homepage, `/api/health` with HTTP 200, and public POST `/api/reviews` with HTTP 202. The host exposes only web `13608:80`; API `3000` is Compose-internal and SQLite uses the named `aime-decision-review_api-data` volume. Credentialed LLM/Fuyao/iFinD smoke is intentionally still pending.

Known limits include single-instance SQLite, mock-provider default behavior, no account system, no trade execution, no real-time monitoring, no vector database, no multi-agent orchestration, and no GBrain LessonStore integration.
