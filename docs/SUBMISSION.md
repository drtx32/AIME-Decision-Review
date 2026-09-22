# Submission checklist

## Delivered in this branch

- [x] Root README covers product rationale, startup, environment names, architecture, AI role, data sources, boundaries, and security.
- [x] Static frontend production build command documented.
- [x] Bun/Hono API start command, `/health`, CORS origin, and SQLite persistence documented.
- [x] T0, ex-ante/ex-post, decision quality/outcome separation documented.
- [x] AI validation log and test execution evidence are maintained in canonical docs.
- [x] Current `main` supervisor workflow is documented without reviving cancelled requirements.

## Must be completed before final submission

- [ ] Deploy the static frontend and replace the README URL placeholder.
- [ ] Deploy the API with server-side environment variables and a persistent SQLite path.
- [ ] Connect and browser-test the real frontend API adapter (the shipped shell is mock-backed).
- [ ] Run clean-browser, deployment health, and final secret-scan evidence; append results to `docs/TEST_PLAN.md`.
- [ ] Verify live Fuyao and iFinD connectivity and a real compatible-model call, or clearly submit with the mock-only boundary stated.
- [ ] Open the PR against `main` and have CI/supervisor review complete.

Canonical references: `README.md`, `docs/DEPLOYMENT.md`, `docs/SPEC.md`, `docs/TEST_PLAN.md`, `docs/AI_VALIDATION.md`, and `docs/AUTOMATION.md`.
