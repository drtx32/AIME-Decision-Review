# syntax=docker/dockerfile:1.7

# --- Build stage -----------------------------------------------------------
FROM oven/bun:1.2 AS build
WORKDIR /srv/app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN bun run typecheck

# --- Runtime stage ---------------------------------------------------------
FROM oven/bun:1.2-slim AS runtime
WORKDIR /srv/app

ENV NODE_ENV=production \
    PORT=3000 \
    SQLITE_PATH=/var/lib/aime/decision-review.db \
    LOG_LEVEL=info

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 aime \
    && useradd --system --uid 1001 --gid aime --home /srv/app aime

COPY --chown=root:root package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --chown=root:root tsconfig.json ./
COPY --chown=root:root --from=build /srv/app/src ./src

RUN mkdir -p /var/lib/aime \
    && chown -R aime:aime /var/lib/aime

VOLUME ["/var/lib/aime"]
USER aime

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["bun", "run", "src/index.ts"]
