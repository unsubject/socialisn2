# socialisn2

Editorial intelligence agent — successor to socialisn. Sources research-style
inputs (RSS + arXiv + YouTube + Cloudflare Email Worker bridge + GDELT) and
hands a short list of high-signal candidates per day across five domains.

See [SPEC.md](./SPEC.md) for the design contract and
[BUILD-PHASES.md](./BUILD-PHASES.md) for the build sequence.

## Status

Phases 0-2 complete. Foundation, ingestion (RSS / arXiv / YouTube / GDELT /
Cloudflare Email Worker bridge), and the scoring core (normalise → embed →
semantic dedup → cluster + daily compaction) are landed. Phase 3 —
heuristic ranking + Sonnet curation + cost ceiling — is the next step. See
[docs/phase-reports/](./docs/phase-reports) for what shipped in each phase
and [BUILD-PHASES.md](./BUILD-PHASES.md) for the full sequence.

## Local dev

```bash
cp .env.example .env       # fill in secrets and POSTGRES_PASSWORD
docker compose up -d postgres redis
npm install
npm run typecheck
npm run lint
npm test
```

The `app`, `ingestion-worker`, `scoring-worker`, and `whisper-worker` compose
services share one image — their commands are stubs in Phase 0 and become
real in Phase 1 / Phase 2 PRs.

The Cloudflare Workers behind SPEC §6.9 — `email-worker/` (inbound mail
handler) and `feed-worker/` (Atom feed reader) — deploy independently via
`wrangler deploy` against a shared D1 database. Neither is part of
docker-compose.

## Conventions

- Every PR branches from `main`; no stacking.
- ADRs at `docs/adr/NNN-slug.md`, written in the PR that introduces the decision.
- Handoff notes at `docs/handoffs/YYYY-MM-DD*.md`, end-of-session when warranted.
- Integration tests use a real Postgres service container in CI — no DB mocks.
