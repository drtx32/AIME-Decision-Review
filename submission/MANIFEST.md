# Submission manifest

This file is the authoritative inventory of what belongs in the final AIME
Decision Review submission archive. The submitter script
(`scripts/preflight.mjs`) reads this manifest, checks the working tree against
it, and rejects anything that looks like a secret or local-only artefact
before producing the final ZIP.

## 1. Required artefacts

Every entry below MUST exist in the working tree before the submission ZIP is
built. The preflight script will refuse to build the archive if any are
missing.

| Path                              | Purpose                                             |
|-----------------------------------|---------------------------------------------------|
| `README.md`                       | Project entry point + setup/run/test commands     |
| `AGENTS.md`                       | Canonical agent rules                             |
| `CLAUDE.md`                       | Claude-specific pointer to `AGENTS.md`            |
| `package.json`                    | Frontend (root) build manifest                    |
| `package-lock.json`               | Frontend (root) frozen dependency graph           |
| `docker-compose.yml`              | Authoritative Compose orchestration               |
| `.env.example`                    | Runtime variable template (placeholders only)     |
| `.gitignore`                      | Ignore rules; must exclude `.env`, `node_modules`, `dist`, etc. |
| `index.html`                      | Vite entrypoint                                   |
| `tsconfig.json`                   | Frontend TS config                                |
| `vite.config.ts`                  | Vite config                                       |
| `src/`                            | Frontend React/TypeScript source                   |
| `apps/api/`                       | Backend Bun/Hono source (TS + tests + Dockerfile) |
| `apps/web/`                       | Frontend Docker/Nginx source                      |
| `docs/SPEC.md`                    | Canonical product + technical spec                |
| `docs/AI_VALIDATION.md`           | AI usage + validation log                         |
| `docs/TEST_PLAN.md`               | Required test coverage + evidence                 |
| `docs/AUTOMATION.md`              | GitHub ↔ Multica supervision                      |
| `docs/DEPLOYMENT.md`              | Production deployment guide                       |
| `submission/MANIFEST.md`          | This file                                         |
| `submission/README.md`            | Submission skeleton overview                      |
| `submission/PROJECT_DESCRIPTION.md` | Submission-facing 1–2 page summary               |
| `submission/DEMO_SCRIPT.md`        | 60–180s demo-video storyboard                     |
| `submission/DEPLOYMENT_EVIDENCE.template.md` | Deployment evidence template            |
| `submission/LICENSE_INVENTORY.md`   | Third-party attribution                           |
| `submission/TEST_NOTES.md`        | Known boundaries + test status + golden-path matrix |
| `submission/AI_VALIDATION_RECORD.md` | AI usage record (fixture vs real)               |
| `scripts/preflight.mjs`           | Submission preflight script (Node)                |
| `scripts/preflight.sh`            | Submission preflight wrapper (POSIX)              |
| `tests/preflight/`                | bun:test coverage for preflight                   |
| `.github/workflows/ci.yml`        | Product CI                                        |
| `.github/workflows/multica-supervisor.yml` | Multica supervisor                       |

## 2. Forbidden paths and patterns

The preflight script fails the build if any of the following appear in the
working tree OR inside the candidate archive. This list is intentionally
strict; a hit on the working tree is a hard error.

### 2.1 Forbidden files (must not be present at build time)

- `.env`, `.env.local`, `.env.*.local`, and any `.env.<instance>` other than
  `.env.example`
- `*.pem`, `*.key`, `*.crt`, `*.p12`, `*.pfx` (private keys / certificates)
- `id_rsa`, `id_ed25519`, `*.rsa` (private blobs)
- `secrets.json`, `secrets.yaml`, `secrets.yml`, `*credentials*`,
  `*credentials.json*`, `*service-account*.json`

### 2.2 Forbidden contents (file-name / inline scan)

The preflight scans every tracked file's first 256 KB for any of:

- `Authorization: Bearer <value>` (with non-empty value)
- `sk-[A-Za-z0-9]{16,}` (any OpenAI-shaped key)
- `HITHINK_FINANCE_API_KEY=<value>` (with non-empty value)
- `IFIND_MCP_AUTHORIZATION=<value>` (with non-empty value)
- `LLM_API_KEY=<value>` (with non-empty value)
- `MULTICA_AIME_SUPERVISOR_WEBHOOK_URL=<value>` (with non-empty value)

The placeholders in `.env.example` (empty values) are exempt; the regex only
flags non-empty RHS.

### 2.3 Excluded build artefacts (never archived)

- `node_modules/` (root + `apps/api/node_modules/`)
- `apps/api/dist/`, `dist/` (Vite build output)
- `.multica/`
- `.claude/`
- `*.db`, `*.db-journal`, `*.db-wal`, `*.db-shm` (local SQLite files)
- `*.tsbuildinfo`
- `*.log`, `npm-debug.log*`, `yarn-error.log*`, `bun-error.log*`
- `.DS_Store`, `Thumbs.db`
- `.vscode/`, `.idea/`
- `coverage/` and `*.lcov`
- `apps/api/bun.lockb` (binary lock cache; keep text `bun.lock`)

## 3. Optional artefacts (recommended if available)

The preflight does not require these, but a complete submission ZIP should
include them when present:

- `submission/DEPLOYMENT_EVIDENCE.md` — populated deployment evidence (filled
  in from `submission/DEPLOYMENT_EVIDENCE.template.md` after the production
  deployment succeeds). If present, preflight verifies it has no empty
  placeholder lines.
- `docs/demo-video-link.md` or a 60–180s demo video under
  `docs/demo/` — recorded end-to-end review run.
- Screenshots of the Home / Running / Result screens under
  `docs/screenshots/`.

## 4. Final ZIP naming convention

```
aime-decision-review-<short-sha>-<yyyymmdd-hhmm>.zip
```

Example:

```
aime-decision-review-547ebb8-20260923-1245.zip
```

`<short-sha>` is the first 7 hex characters of the commit SHA the archive
was built from. `<yyyymmdd-hhmm>` is the UTC timestamp at build time.

## 5. Determinism guarantees

The script enforces:

- git working tree SHA is recorded in `submission/BUILD_INFO.txt`
- the ZIP excludes `.git/`, `.multica/`, `.claude/`, all build artefacts, and
  any file matching §2.1 / §2.3
- file order inside the ZIP is sorted by relative path (stable across runs)
- file mtimes inside the ZIP are normalised to the commit time when known
  (fallback: build UTC timestamp)

A diff of two ZIPs built from the same commit must be byte-identical apart
from `submission/BUILD_INFO.txt` and the deterministic ZIP timestamp.