# Submission checklist

## Current candidate

- **Canonical branch:** `main`
- **Current verified integration lineage:** PR #7 merged, inline chart demo merged in PR #14, deadline integration sweep merged in PR #15.
- **Public URL:** https://10jqka-aime.tong-xiao.top
- **Canonical startup:** root `.env` from `.env.example`, then `docker compose up -d --build`
- **Exposure:** web `13608:80`; API internal `api:3000`; SQLite in the named `api-data` volume; restart policy `unless-stopped`.

The exact final submission SHA must be recorded after the last integration/CI/deployment pass. Do not reuse older PR-head SHAs as final evidence.

## Included product scope

- conversation-first historical investment decision review
- one or multiple decision/order events
- exact vs approximate T0 handling
- strict ex-ante vs ex-post separation
- grounded evidence/citations and explicit provider-failure semantics
- durable learning only from grounded completed reviews
- Hermes-inspired chat shell/activity/worklog interaction model
- controlled attachments, settings/usage APIs and inline chart contracts

## Required final checks

- [ ] Record exact final `main` SHA.
- [ ] Run frontend build and backend tests/typecheck on that SHA.
- [ ] Run the canonical multi-decision/T0 regression on that SHA.
- [ ] Run credentialed real LLM + Fuyao + iFinD smoke where account permissions allow; mark unavailable fields honestly.
- [ ] Verify no silent mock adapter is used under real credentials.
- [ ] Run `scripts/submission-preflight.sh`.
- [ ] Build the final submission ZIP with `scripts/build-submission-zip.sh`.
- [ ] Verify the ZIP contains no `.env`, credentials, DB/WAL/SHM files, caches, logs, `node_modules`, build artifacts or local browser profiles.
- [ ] Deploy the exact final SHA non-destructively and verify local/public `/health` and `/api/health`.
- [ ] Run a clean-browser smoke for auth, conversation send/working state, needs-input warning, composer stability and chart rendering.
- [ ] Update `docs/AI_VALIDATION.md` and `docs/TEST_PLAN.md` with only evidence actually observed on the exact final SHA.

## Known boundaries

- Fuyao/iFinD field/tool availability depends on the configured account and server tool map.
- Missing/empty provider data is an explicit evidence gap; it must not become a normal review conclusion.
- Personal broker positions/orders are not assumed available through Fuyao/iFinD market-data APIs.
- Scanned/image-only PDFs are not OCR'd in v0.1 unless a verified vision/provider path is explicitly used.

Canonical references: `README.md`, `.env.example`, `docker-compose.yml`, `docs/DEPLOYMENT.md`, `docs/SPEC.md`, `docs/TEST_PLAN.md`, `docs/AI_VALIDATION.md`, `docs/THIRD_PARTY.md`, and `docs/AUTOMATION.md`.
