# syntax=docker/dockerfile:1.7
# socialisn2 app image. Used by the app, ingestion-worker, scoring-worker,
# and whisper-worker services in docker-compose.yml; each service overrides
# CMD via the compose file.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev --no-audit --no-fund; fi
COPY --from=build /app/dist ./dist
# Runtime configuration: prompt templates and other static files that Node
# code reads at startup (e.g. src/scoring/normalize.ts loads
# config/prompts/normalize.txt). The path is resolved relative to the
# compiled module (import.meta.url), so the directory layout matches dev.
COPY config ./config
# Migrations consumed by `dist/scripts/migrate.js` via
# readdirSync(resolve(process.cwd(), 'migrations')). The Phase 5 PR 2
# deploy invokes the migrator with WORKDIR /app, so /app/migrations
# must exist. Forward-only SQL files; one-shot container reads them.
COPY migrations ./migrations
EXPOSE 3000
# Healthcheck — hits /healthz via node's built-in fetch so we don't
# need to ship curl/wget in the slim image. Traefik picks up the
# label-driven healthcheck via docker-compose; this one also gives
# `docker compose ps` a meaningful status column for direct triage.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || exit 1
CMD ["node", "dist/index.js"]
