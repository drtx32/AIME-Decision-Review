# AIME Decision Review

AI-native historical investment decision review product for the AIME test.

## Canonical project docs

All agents and contributors MUST read the repository docs before implementation or when context is uncertain:

- `docs/SPEC.md` — canonical product and technical specification
- `docs/AI_VALIDATION.md` — AI usage and validation log
- `docs/TEST_PLAN.md` — required test coverage and evidence
- `docs/AUTOMATION.md` — GitHub Actions → Multica supervision

If an Issue conflicts with `docs/SPEC.md`, the explicit newer Issue instruction wins; otherwise follow the docs.

## Security

Never commit API keys, Authorization headers, MCP credentials, cookies, or other secrets. Use server environment variables / GitHub Secrets only.

## Run with Docker Compose

The root Compose file is the production-like local path. It builds the static
frontend and Bun/Hono API, proxies browser `/api` requests to the API, and
stores SQLite in the named `api-data` volume.

```bash
cp .env.example .env
docker compose up --build
```

Open `http://localhost:8080`. The API is also available at
`http://localhost:3000/health`. Set `WEB_PORT` or `API_PORT` in the root `.env`
to change host ports. Backend credentials stay in the API container and are
never passed to the frontend build.

For frontend-only development, `npm install && npm run dev` keeps the mock
adapter unless `VITE_API_BASE_URL` is set. The root `.env.example` is the only
runtime configuration template; do not create an app-local `.env.example`.
