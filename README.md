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
