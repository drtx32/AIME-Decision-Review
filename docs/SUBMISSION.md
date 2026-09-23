# Submission checklist

## Candidate handoff (not final)

- **Integration PR:** [PR #7](https://github.com/drtx32/AIME-Decision-Review/pull/7)
- **Current integration head:** `5567bbf`
- **Canonical startup:** root `.env` from `.env.example`, then `docker compose up -d --build`; web-only `13608:80`, API internal `api:3000`, named SQLite volume, `restart: unless-stopped`.

The submission candidate is not final until the pending real-provider and
deployment checks below are rerun against the exact integrated SHA.

## Must be completed before final submission

- [ ] Run credentialed real LLM smoke and at least one real Fuyao plus one real iFinD gateway smoke; record source/timestamp provenance and failures.
- [ ] Run final secret/image scan and confirm no credential reaches the web image or browser.
- [ ] Re-run final auth and provider smoke against the exact post-merge deployment.
- [ ] Complete multi-decision, temporal-adversarial, grounding, and learning-persistence evidence.
- [ ] Run/record Product CI for PR #7.

Canonical references: `README.md`, `.env.example`, `docker-compose.yml`,
`docs/DEPLOYMENT.md`, `docs/SPEC.md`, `docs/TEST_PLAN.md`,
`docs/AI_VALIDATION.md`, and `docs/AUTOMATION.md`.
