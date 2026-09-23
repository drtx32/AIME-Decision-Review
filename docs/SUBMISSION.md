# Submission checklist

## Candidate handoff (not final)

- **Submission-prep PR:** [PR #8](https://github.com/drtx32/AIME-Decision-Review/pull/8), Draft
- **Branch:** `agent/oracle-codex/5c4465503faf`
- **Current head:** `7f2c694` (rebased on `main@38818eb`)
- **Public URL:** `https://10jqka-aime.tong-xiao.top` (deployment health and public review POST previously verified)
- **Canonical startup:** root `.env` from `.env.example`, then `docker compose up -d --build`; web-only `13608:80`, API internal `api:3000`, named SQLite volume, `restart: unless-stopped`.

The archive produced by `scripts/build-submission-zip.sh` is a **draft
submission skeleton**, not a final archive. PR #7 / ELI-333 / ELI-318 final
candidate evidence still needs to be merged or reconciled before final delivery.

## Delivered in this branch

- [x] Root README uses Docker Compose as the canonical startup/deployment path.
- [x] README documents web/API separation, root `.env.example`, server-only credentials, SQLite volume, product choices, AI role, Fuyao/iFinD data sources, T0 boundaries, and known limits.
- [x] `docs/DEPLOYMENT.md` documents `docker compose up --build`, config/health checks, persistence, lifecycle, and rollback.
- [x] `docs/TEST_PLAN.md` and `docs/AI_VALIDATION.md` contain Compose-oriented evidence and explicit pending items.
- [x] `docs/THIRD_PARTY.md` records direct dependency licenses, Google Fonts attribution, and the no-vendored/Hermes-reference check.
- [x] Public URL is verified: `https://10jqka-aime.tong-xiao.top`.
- [x] Deployment smoke confirms web-only host exposure on `13608`; API remains internal at `api:3000`.
- [x] Auth evidence is recorded: bootstrap admin, forced first-password change, HttpOnly session, admin-managed users, and no public registration.
- [x] README/SPEC describe the conversation-first multi-decision candidate direction, auth/settings boundary, T0/ex-ante/ex-post design, learning, provider/data sources, startup, and known limits.
- [x] `scripts/build-submission-zip.sh` creates a tracked-files-only draft archive and excludes runtime files, secrets, databases, logs, caches, and `.git`.
- [x] `scripts/submission-preflight.sh` provides reproducible diff/build/Compose/secret/archive checks without starting or deleting containers.

## Must be completed before final submission

- [x] Deploy the Compose stack on the target host and record the real public URL.
- [x] Verify the public homepage, `/api/health`, and POST `/api/reviews` through the deployed web proxy.
- [ ] Run credentialed real LLM smoke and at least one real Fuyao plus one real iFinD gateway smoke; record source/timestamp provenance and failures.
- [ ] Resolve PR #3/real-gateway work and confirm the credentialed validation result before finalizing the integration claim.
- [ ] Run final secret/image scan and confirm no credential reaches the web image or browser.
- [ ] Re-run the final auth + provider smoke against the exact post-merge deployment; auth tests are green on the merged main baseline, while credentialed LLM/MCP remains pending.
- [ ] Reconcile PR #7 latest head `04a7173f5b6d019e7ceddc531ebf9bd09b831bc5` after ELI-333/318 current-head audit; do not reuse older `5e5aa30` evidence as final without rerun.
- [ ] Complete T01/T02/T07–T10 multi-decision, temporal-adversarial, grounding, and learning-persistence evidence from ELI-333.
- [ ] Run/record Product CI for PR #8; current Multica PR snapshot reports no checks yet.
- [ ] Optional demo video: not requested; no video work performed.

Canonical references: `README.md`, `.env.example`, `docker-compose.yml`, `docs/DEPLOYMENT.md`, `docs/SPEC.md`, `docs/TEST_PLAN.md`, `docs/AI_VALIDATION.md`, and `docs/AUTOMATION.md`.
