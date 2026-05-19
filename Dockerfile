# syntax=docker/dockerfile:1.7
# socialisn2 app image. Used by the app, ingestion-worker, scoring-worker,
# and whisper-worker services in docker-compose.yml; each service overrides
# CMD via the compose file. Healthcheck is set per-service in compose
# (only the `app` service serves HTTP — workers don't bind a port and
# would flap as unhealthy if we set a curl-based check at image level).

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
# config/ contains both .ts files (domains, tags) imported by src/ AND
# non-TS files (prompts/*.txt, litellm.yaml) that the compiled code
# loads via import.meta.url-relative paths. tsc needs the .ts in scope
# to resolve src/ imports; the non-TS files are cp'd into dist/config
# alongside the compiled .js so runtime path resolution lands on them.
COPY config ./config
RUN npm run build && mkdir -p dist/config && cp -r config/. dist/config/

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev --no-audit --no-fund; fi
COPY --from=build /app/dist ./dist
# Belt-and-suspenders: also expose the source config/ at /app/config in
# case anything loads via process.cwd() or an absolute path rather than
# import.meta.url-relative. dist/config/ is the canonical runtime path
# (see Dockerfile build stage); this is the fallback. Cleanup deferred
# pending audit that nothing actually reads from /app/config directly.
COPY config ./config
# Migrations consumed by `dist/scripts/migrate.js` via
# readdirSync(resolve(process.cwd(), 'migrations')). The Phase 5 PR 2
# deploy invokes the migrator with WORKDIR /app, so /app/migrations
# must exist. Forward-only SQL files; one-shot container reads them.
COPY migrations ./migrations
EXPOSE 3000
CMD ["node", "dist/src/index.js"]
