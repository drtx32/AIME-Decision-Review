# Deployment evidence — TEMPLATE

> Copy this file to `submission/DEPLOYMENT_EVIDENCE.md` after a real
> production deployment completes. Leave any field you cannot fill in as
> `UNKNOWN — <reason>`; do not invent values. The preflight script
> (`scripts/preflight.mjs`) validates that all `UNKNOWN` placeholders have
> a reason and that no line is empty.
>
> **Final SHA placeholder (deferred).** The exact `main` SHA the final
> submission archive will be built from is intentionally left as
> `UNKNOWN — final SHA pending P0 fixes ELI-354/355/357 to land` until
> those PRs merge. Once they do, replace the placeholders below and
> re-run `node scripts/preflight.mjs --strict` to confirm the archive is
> still deterministic.

## Login note (bootstrap admin)

The first user on a fresh database is the **bootstrap admin**, created
by the API on first startup when `INITIAL_ADMIN_PASSWORD` is configured
in the root `.env`. The flow:

1. **Operator** sets `INITIAL_ADMIN_PASSWORD` in the root `.env` (never
   in the repo; the `.env.example` template documents the variable).
2. **Operator** runs `docker compose up -d --build`. The API refuses to
   start without `INITIAL_ADMIN_PASSWORD` (fail-fast gate, per
   ELI-325 follow-up). On first startup the API creates the bootstrap
   admin row and stores a hashed password.
3. **Bootstrap admin** opens `https://<production-domain>/login`,
   logs in with the configured password. The session cookie is set.
   `must_change_password` is true on the first login — the UI prompts
   the admin to rotate the password before any review route is
   reachable.
4. **Bootstrap admin** then either:
   - creates managed users via the admin portal
     (`POST /api/auth/admin/users`), or
   - delegates the bootstrap password to a designated operator via an
     out-of-band channel and revokes it after rotation.

This note exists so reviewers know the public Web URL **always requires
a login**, and so the first login experience is documented. Public
registration is not enabled in MVP. The bootstrap admin must change
their password on first login; the UI enforces this gate.

## Production URL

- Web URL: `https://<production-domain>/`          (e.g. `https://10jqka-aime.tong-xiao.top/`)
- Login URL: `https://<production-domain>/login`   (bootstrap admin first-login flow, see above)
- API health behind web proxy: `https://<production-domain>/api/health`
- Internal API direct health (host-only, not exposed): `http://127.0.0.1:13608/api/health`

## Git identity

- Repository: `https://github.com/drtx32/AIME-Decision-Review`
- Commit SHA (long): `<40-char hex — UNKNOWN — final SHA pending P0 fixes ELI-354/355/357 to land>`
- Commit SHA (short): `<7-char hex — UNKNOWN — final SHA pending P0 fixes ELI-354/355/357 to land>`
- Branch: `main`
- Working-tree state: `clean` / `dirty — <reason>`

## Container / image versions

| Service | Image reference                                         | Image tag / SHA digest      |
|---------|----------------------------------------------------------|-----------------------------|
| web     | `<registry>/<image>` (e.g. local: built from source)     | `<tag>` or `sha256:<...>`   |
| api     | `<registry>/<image>`                                     | `<tag>` or `sha256:<...>`   |

If images were built locally:

```bash
docker compose images
docker compose ps
```

## Deploy timestamp

- UTC: `YYYY-MM-DDTHH:MM:SSZ`
- Local: `YYYY-MM-DD HH:MM TZ`

## Health endpoints

```text
GET /health            → 200 (text/plain "ok")
GET /api/health        → 200 (JSON { status: "ok", provider, configuredServers })
```

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

Attach the curl output (with secrets redacted) and the `docker compose ps`
snapshot to the PR that records this deployment.

## Database state

- Volume name: `aime-decision-review_api-data`
- Row count snapshot (review_runs + users): `<n>`
- Last successful review run id: `<rev_…>`

## Reverse proxy / DNS

- Public hostname: `<production-domain>`
- Reverse proxy target: `http://127.0.0.1:13608`
- TLS termination: `<managed-by-…>`

## Rollback

- Previous commit SHA on `main`: `<40-char hex>`
- `docker compose down` (NO `-v`) then `git checkout <sha> && docker compose up -d --build`
- Restore SQLite snapshot if needed: see `docs/DEPLOYMENT.md` §"Backup the SQLite volume".

## Outstanding deployment notes

- Anything that did not work as expected, any warnings, any follow-ups.