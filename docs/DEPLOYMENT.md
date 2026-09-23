# Deployment

This is the canonical production deployment guide for AIME Decision Review.

## Canonical host path

All production deploys must live under:

```bash
~/projects/aime-decision-review
```

Do not deploy from `/root/multica_workspaces/...` or another issue/agent workspace. Those paths are transient and can disappear when a project or workspace is archived.

The repository working tree and production `.env` live in the canonical path. Real credentials must never be committed.

## One-time bootstrap

```bash
mkdir -p ~/projects
git clone https://github.com/drtx32/AIME-Decision-Review.git ~/projects/aime-decision-review
cd ~/projects/aime-decision-review
git checkout main
git pull --ff-only origin main

cp .env.example .env
chmod 600 .env
# Edit only server-side credentials/configuration in .env.

docker compose up -d --build
```

Both services use `restart: unless-stopped`. Compose passes an unset
`INITIAL_ADMIN_PASSWORD` through as empty; this keeps an existing SQLite-backed
deployment restartable. The API itself refuses startup with a clear error only
when a fresh database has no admin to bootstrap, so the initial password must
still be supplied for first provisioning.

Future deployments should update and restart from the same directory:

```bash
cd ~/projects/aime-decision-review
git checkout main
git pull --ff-only origin main
docker compose up -d --build
```

## Compose identity and SQLite persistence

The production `.env` must keep:

```dotenv
COMPOSE_PROJECT_NAME=aime-decision-review
```

This prevents Docker Compose from deriving a different project name after a directory move and accidentally creating a fresh SQLite volume.

The expected named volume is:

```text
aime-decision-review_api-data
```

Before any cutover, record the currently attached volume and row/data state. Never use `docker compose down -v` during a path migration.

Useful checks:

```bash
docker compose ps
docker volume ls | grep aime-decision-review
docker system df
```

## Host exposure model

- Web container publishes host port `13608` to container port `80` by default.
- API container is not host-published; it is available only on the Compose network at port `3000`.
- Browser `/api/*` traffic is proxied by the web container to the API service.
- The host reverse proxy for `10jqka-aime.tong-xiao.top` should forward to `http://127.0.0.1:13608`.
- Keep backend credentials out of the frontend build and browser-visible configuration.

## Health and smoke tests

From the host:

```bash
curl -fsS http://127.0.0.1:13608/health
curl -fsS http://127.0.0.1:13608/api/health
docker compose ps
```

From outside the host, after DNS/reverse-proxy recovery:

```bash
curl -fsS https://10jqka-aime.tong-xiao.top/health
curl -fsS https://10jqka-aime.tong-xiao.top/api/health
```

Oracle host deployment evidence confirms the public homepage and `/api/health` returned 200, and public POST `/api/reviews` returned 202. Nginx forwards only to `http://127.0.0.1:13608`; it never targets the internal API port directly. The public URL is verified. Credentialed LLM/Fuyao/iFinD provider smoke remains pending.

On 2026-09-23 00:57–00:58 UTC, both containers were found exited with restart
policy `no`, causing local refusal and public 502 health responses. Recovery
used the deployment environment gate without removing the named volume; data
remained intact. The canonical Compose contract now uses `unless-stopped`, and
post-recovery API and web health checks returned 200.

A missing/unavailable LLM must not be treated as process death. Service health and model/provider readiness are separate concerns; provider configuration failures must degrade review creation without taking down the API process.

## Migrating from an old workspace path

1. From the old deployment, capture `docker compose ps`, the Compose project name, the SQLite volume name, and a data snapshot/count.
2. Do not delete the old workspace copy yet.
3. Prepare `~/projects/aime-decision-review` from `main` and copy the production `.env` without printing its secrets.
4. Ensure `COMPOSE_PROJECT_NAME=aime-decision-review` is present in the new `.env`.
5. Stop only the old AIME stack as needed. Do not pass `-v`.
6. From the canonical path, run `docker compose up -d --build`.
7. Verify local health, public health, and that existing SQLite-backed records are still present.
8. Keep the old workspace untouched until the new deployment is fully verified. Cleanup requires explicit approval.

## Secrets

- Keep production `.env` mode `0600` where possible.
- Never commit `LLM_API_KEY`, `HITHINK_FINANCE_API_KEY`, `IFIND_MCP_AUTHORIZATION`, Authorization headers, cookies, or other credentials.
- MCP endpoint/auth configuration is operator/server configuration and should not be exposed in the normal product UI.
- Backend secrets belong only in the API process/container environment.

## Backup the SQLite volume

Example snapshot:

```bash
cd ~/projects/aime-decision-review
docker run --rm \
  -v aime-decision-review_api-data:/data:ro \
  -v "$PWD:/backup" \
  alpine cp /data/decision-review.db /backup/decision-review-$(date +%F-%H%M%S).db
```

Do not restore or replace a live SQLite database blindly. Stop the API first and preserve the original database files before any restore operation.
