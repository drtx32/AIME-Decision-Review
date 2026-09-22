# Submission checklist

## Delivered in this branch

- [x] Root README uses Docker Compose as the canonical startup/deployment path.
- [x] README documents web/API separation, root `.env.example`, server-only credentials, SQLite volume, product choices, AI role, Fuyao/iFinD data sources, T0 boundaries, and known limits.
- [x] `docs/DEPLOYMENT.md` documents `docker compose up --build`, config/health checks, persistence, lifecycle, and rollback.
- [x] `docs/TEST_PLAN.md` and `docs/AI_VALIDATION.md` contain Compose-oriented evidence and explicit pending items.
- [x] Public URL is verified: `https://10jqka-aime.tong-xiao.top`.
- [x] Deployment smoke confirms web-only host exposure on `13608`; API remains internal at `api:3000`.
- [x] Auth evidence is recorded: bootstrap admin, forced first-password change, HttpOnly session, admin-managed users, and no public registration.

## Must be completed before final submission

- [x] Deploy the Compose stack on the target host and record the real public URL.
- [x] Verify the public homepage, `/api/health`, and POST `/api/reviews` through the deployed web proxy.
- [ ] Run credentialed real LLM smoke and at least one real Fuyao plus one real iFinD gateway smoke; record source/timestamp provenance and failures.
- [ ] Resolve PR #3/real-gateway work and confirm the credentialed validation result before finalizing the integration claim.
- [ ] Run final secret/image scan and confirm no credential reaches the web image or browser.
- [ ] Re-run the final auth + provider smoke against the exact post-merge deployment; auth tests are green on the merged main baseline, while credentialed LLM/MCP remains pending.

Canonical references: `README.md`, `.env.example`, `docker-compose.yml`, `docs/DEPLOYMENT.md`, `docs/SPEC.md`, `docs/TEST_PLAN.md`, `docs/AI_VALIDATION.md`, and `docs/AUTOMATION.md`.
