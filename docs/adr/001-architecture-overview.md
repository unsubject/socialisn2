# ADR-001: Architecture overview

- **Status:** accepted
- **Date:** 2026-05-12
- **Resolves:** none (codifies SPEC §4)

## Context

Socialisn2 needs a system architecture that:

1. Holds total LLM spend under $1.50/day with twice-daily runs.
2. Runs alongside `2nd-brain` on the existing Hostinger VPS without coupling.
3. Stays within the no-scraping policy (ADR-003).

The signal volume is large at the top and shrinks fast: ~10,000 raw items/day land in `raw_items`; only ~100 clusters ever reach the Sonnet curation step. The architecture must reflect that asymmetry — cheap operations filter aggressively before expensive ones.

## Decision

A **cost-controlled funnel** of nine stages, each strictly cheaper than its successor's input would be if applied unfiltered:

```
Stage 0  Raw signals          ~10,000 items/day         (free — RSS/API fetch)
Stage 1  De-dup (URL/title)   ~5,000 unique             (free — hashing)
Stage 2  Embed + cluster      ~5,000 → ~500 clusters    (cheap — embedding ~$0.04/day)
Stage 3  Heuristic scoring    rank clusters             (free — authority, recency, volume)
Stage 4  English summarise    top ~200 clusters         (cheap — Gemini Flash-Lite ~$0.15/day)
Stage 5  Archive similarity   compare to 2nd-brain      (free — cached vector cosine)
Stage 6  LLM curation         top ~100 clusters         (Sonnet ~$0.54/day)
Stage 7  Annotate + persist   temperature, trajectory, exclusive flags
Stage 8  Deliver              DB → MCP, Telegram, RSS
```

Deployment is a single docker-compose stack on the Hostinger VPS, sitting next to `2nd-brain`:

```
hostinger-vps/
├── 2nd-brain (existing)     postgres-A, redis-A, app-A
└── socialisn2 (new)         postgres-B, redis-B, litellm, app-B, ingestion-worker, scoring-worker, whisper-worker
```

The two Cloudflare Workers behind SPEC §6.9 (`email-worker` + `feed-worker`, see ADR-003) are the one exception — they run at the CF edge against a shared D1 database, independent of the VPS.

## Rationale

- **Funnel over fanned-out parallel scoring.** The naive approach — score every raw item with Sonnet — would burst the cost ceiling on day one (~$20+ per run). Cheap operations (hash dedup, embedding, heuristic ranking) cut the candidate pool by ~100× before any expensive model touches the data.
- **Separate Postgres + Redis per project, shared host.** Sharing PG between socialisn2 and 2nd-brain would couple their migrations, schemas, and backup cadence. Sharing Redis would commingle BullMQ queues. The cost of running two PG containers on one VPS is negligible compared to that coupling. 2nd-brain integration goes through its MCP server (§10), not its DB.
- **Single docker-compose stack.** Mirrors the `2nd-brain` deployment shape so there is one mental model for "how to deploy/restart/back up a project on this VPS."
- **Edge-hosted email bridge.** VPS reboots or socialisn2 redeploys must not lose incoming newsletters; the bridge running on Cloudflare's edge sidesteps that failure mode entirely.

## Consequences

- Each new ingestion source must keep average raw-items per day within the ~10,000 ceiling assumed by the cost model; significantly higher would push embedding cost over budget.
- Stage 6 is the single expensive call — any prompt regression there has the largest cost-blast-radius. Phase 5 PR 3 wires a hard halt at 80% of the daily ceiling for protection.
- The 2nd-brain MCP becomes a runtime dependency for Stage 5 archive comparison. Phase 3 PR 1 handles the MCP-unavailable case gracefully (see ADR-008 when written).

## References

- SPEC §4 (System Architecture)
- SPEC §9 (Scoring & Curation)
- SPEC §12 (Cost Budget & Enforcement)
- ADR-002 (Stack choices)
- ADR-003 (No-scraping policy + email-bridge)
