# Deployment evidence — TEMPLATE

> Copy this file to `submission/DEPLOYMENT_EVIDENCE.md` after a real
> production deployment completes. Leave any field you cannot fill in as
> `UNKNOWN — <reason>`; do not invent values. The preflight script
> (`scripts/preflight.mjs`) validates that all `UNKNOWN` placeholders have
> a reason and that no line is empty.

## Production URL

- Web URL: `https://<production-domain>/`          (e.g. `https://10jqka-aime.tong-xiao.top/`)
- API health behind web proxy: `https://<production-domain>/api/health`
- Internal API direct health (host-only, not exposed): `http://127.0.0.1:13608/api/health`

## Git identity

- Repository: `https://github.com/drtx32/AIME-Decision-Review`
- Commit SHA (long): `<40-char hex>`
- Commit SHA (short): `<7-char hex>`
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