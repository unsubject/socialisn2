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
EXPOSE 3000
CMD ["node", "dist/index.js"]
