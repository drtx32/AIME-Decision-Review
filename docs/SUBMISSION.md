# Submission checklist

## Delivered in this branch

- [x] Root README uses Docker Compose as the canonical startup/deployment path.
- [x] README documents web/API separation, root `.env.example`, server-only credentials, SQLite volume, product choices, AI role, Fuyao/iFinD data sources, T0 boundaries, and known limits.
- [x] `docs/DEPLOYMENT.md` documents `docker compose up --build`, config/health checks, persistence, lifecycle, and rollback.
- [x] `docs/TEST_PLAN.md` and `docs/AI_VALIDATION.md` contain Compose-oriented evidence and explicit pending items.
- [x] No live URL or credentialed LLM/MCP completion is claimed.

## Must be completed before final submission

- [ ] Deploy the Compose stack on the target host and record the real public URL.
- [ ] Run a clean-browser check against the deployed web container.
- [ ] Run credentialed real LLM smoke and at least one real Fuyao plus one real iFinD gateway smoke; record source/timestamp provenance and failures.
- [ ] Resolve PR #3 conflicts and confirm the real gateway validation result before finalizing the integration claim.
- [ ] Update README, deployment, test, and AI validation evidence with those actual results.
- [ ] Run final secret/image scan and confirm no credential reaches the web image or browser.

Canonical references: `README.md`, `.env.example`, `docker-compose.yml`, `docs/DEPLOYMENT.md`, `docs/SPEC.md`, `docs/TEST_PLAN.md`, `docs/AI_VALIDATION.md`, and `docs/AUTOMATION.md`.
