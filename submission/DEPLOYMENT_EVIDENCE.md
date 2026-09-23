# Deployment evidence — AIME Decision Review

> Populated record of the running production deployment. This file is the
> **canonical deployment evidence** for the submission; it replaces the
> unfilled `submission/DEPLOYMENT_EVIDENCE.template.md` once real values
> are known. The preflight script (`scripts/preflight.mjs`) verifies that
> no line in this file is empty and that any remaining `UNKNOWN` carries
> a reason.

## Login note (bootstrap admin)

The first user on a fresh database is the **bootstrap admin**, created
by the API on first startup when `INITIAL_ADMIN_PASSWORD` is configured
in the server `.env`. The flow:

1. **Operator** sets `INITIAL_ADMIN_PASSWORD` in the server `.env`
   (never in the repo; `.env.example` documents the variable).
2. **Operator** runs `docker compose up -d --build` from the canonical
   production path (see "Production path" below). The API refuses to
   start without `INITIAL_ADMIN_PASSWORD` (fail-fast gate, per
   ELI-325 follow-up). On first startup the API creates the bootstrap
   admin row and stores a hashed password.
3. **Bootstrap admin** opens `https://<production-domain>/login` and
   logs in with the configured password. The session cookie is set.
   `must_change_password` is true on the first login — the UI prompts
   the admin to rotate the password before any review route is
   reachable.
4. **Bootstrap admin** then either:
   - creates managed users via the admin portal
     (`POST /api/auth/admin/users`), or
   - delegates the bootstrap password to a designated operator via an
     out-of-band channel and revokes it after rotation.

The public Web URL **always requires a login**, and the first login
experience is documented above. Public registration is not enabled in
MVP. The bootstrap admin must change their password on first login;
the UI enforces this gate.

## Production path

The canonical production path on the host:

```text
/root/projects/aime-decision-review
```

Production deploys must run from this path. Do not run production
from `/root/multica_workspaces/...` or another transient agent/issue
workspace. See `docs/DEPLOYMENT.md` for migration, SQLite-volume
preservation, and rollback details.

## Production URL

- Web URL: `https://<production-domain>/` (canonical example: `https://10jqka-aime.tong-xiao.top/`)
- Login URL: `https://<production-domain>/login` (bootstrap admin first-login flow, see above)
- API health behind web proxy: `https://<production-domain>/api/health`
- Internal API direct health (host-only, not exposed): `http://127.0.0.1:13608/api/health`

> The exact `<production-domain>` for the submitted archive is recorded
> in the production environment, not in this repository. Reviewers
> verify it against the running deployment.

## Git identity

- Repository: `https://github.com/drtx32/AIME-Decision-Review`
- Last successful production deploy SHA (long): `de42657675ad39c49bf78f53c25bb14ecbee3d01` (merge of PR #27 — `ELI-318: harden MCP routing and production tool-map semantics`)
- Last successful production deploy SHA (short): `de42657`
- Branch: `main`
- Working-tree state at archive build time: `clean`
- Final deployed SHA at submission archive time: `UNKNOWN — main has advanced past `de42657` (current `main` = `b87e8fb`); final deployed SHA must be re-captured at archive build time once P0 fixes ELI-355 / ELI-362 / ELI-360 land and a fresh `docker compose up -d --build` completes successfully`

## Container / image versions

| Service | Image reference                                  | Image tag / SHA digest            |
|---------|---------------------------------------------------|------------------------------------|
| web     | `apps/web/` (local: built from source via Compose) | image label `aime-web:<short-sha>` |
| api     | `apps/api/` (local: built from source via Compose) | image label `aime-api:<short-sha>` |

> Images are built **locally** from source via `docker compose build`
> at deploy time; no public registry pull is required. The
> `<short-sha>` matches the git SHA recorded above.

## LLM provider (server .env)

- Provider: **MiniMax-M3** via the `openai-compatible` adapter
  (`apps/api/src/providers/openai-compatible.ts`).
- Configuration (server `.env`, never committed):
  - `LLM_PROVIDER=openai-compatible`
  - `LLM_BASE_URL=<redacted>`
  - `LLM_API_KEY=<redacted>` (server environment variable only)
  - `LLM_MODEL=MiniMax-M3`
- Live call evidence: see `docs/AI_VALIDATION.md` and
  `submission/AI_VALIDATION_RECORD.md` §"Real validation" for the
  credentialed MiniMax-M3 run captured against this provider.

## MCP servers

Six Fuyao + eleven iFinD servers are configured in the registry but
resolved on demand by the review plan. Production credentials are
loaded from the server `.env` only.

- **Fuyao**: real-credential validation **complete on the historical
  review path** (`a-share`, `a-share-index`, `meta`). See
  `submission/AI_VALIDATION_RECORD.md` §"Real validation" → "Real
  Fuyao MCP call".
- **iFinD**: direct stock / news probes verified previously
  (`stock`, `news`). The **current production review path uses
  mapped-news**, which still needs the final mapped-news acceptance
  run before the iFinD row can be promoted to "Real (review path)".
  Direct probes remain Real; mapped-news is **partial pending final
  acceptance**. See `submission/AI_VALIDATION_RECORD.md` §"Real
  validation" → "Real iFinD MCP call".

## Deploy timestamp

- UTC: recorded in the production environment at the time the final
  archive SHA is captured (one last factual sweep at final deployed
  SHA).
- Local: `2026-09-23 TZ Asia/Shanghai` for the last successful run
  that produced `de42657`. Subsequent deploys are pending the close-out
  of ELI-355 / ELI-362 / ELI-360.

## Health endpoints

```text
GET /health            → 200 (text/plain "ok")
GET /api/health        → 200 (JSON { status: "ok", provider, configuredServers })
```

The `/api/health` body reports the configured LLM provider and the set
of MCP servers whose credentials + tool-map are present.

## Smoke-test evidence

```bash
# From the host:
curl -fsS http://127.0.0.1:13608/health
curl -fsS http://127.0.0.1:13608/api/health
docker compose ps

# From outside the host:
curl -fsS https://<production-domain>/health
curl -fsS https://<production-domain>/api/health
```

Smoke-test transcripts (with `Authorization:`, `LLM_API_KEY`,
`HITHINK_FINANCE_API_KEY`, `IFIND_MCP_AUTHORIZATION` redacted to
`Bearer <redacted>` / `<redacted>` / `<redacted>`) and a `docker
compose ps` snapshot are attached to the PR that records each
production deploy.

## Database state

- Volume name: `aime-decision-review_api-data`
- Row count snapshot (review_runs + users): recorded in the production
  environment per deploy; not duplicated here to avoid drift.
- Last successful review run id: `UNKNOWN — pending final-acceptance run against the mapped-news code path`

## Reverse proxy / DNS

- Public hostname: `<production-domain>` (recorded in the production environment)
- Reverse proxy target: `http://127.0.0.1:13608` (the host-published web container)
- TLS termination: managed by the production host's TLS terminator (out of repo)

## Rollback

- Previous commit SHA on `main`: `4fb66536c9246e8fcad0fd4312b8bb506f7e514e` (merge of PR #25 — submission expansion)
- `docker compose down` (NO `-v`) then `git checkout <sha> && docker compose up -d --build`
- Restore SQLite snapshot if needed: see `docs/DEPLOYMENT.md` §"Backup the SQLite volume".

## Outstanding deployment notes

- **Markdown / CoT / conversation routing** (PR #30, ELI-355) **merged**
  at `171907b`. ELI-362 (T0 datetime hotfix) and ELI-360 (user BYOK
  browser-local) are still **running**; the final deployed SHA at
  archive time must be re-captured once those land and a fresh
  `docker compose up -d --build` completes.
- **T0 datetime hotfix** (ELI-362) is **running**. Final deploy must
  happen on a SHA that contains this fix.
- **User BYOK browser-local fix** (ELI-360) is **running**. Final
  deploy must happen on a SHA that contains this fix.
- **Archived vs Active scope** (PR #29, ELI-358) **merged** at
  `b87e8fb`; already present in any deploy from `b87e8fb` onward.
- iFinD **mapped-news** final acceptance remains **pending**;
  do not overclaim `Real` on the iFinD row until that acceptance run
  is captured in `docs/AI_VALIDATION.md`.