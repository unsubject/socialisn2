# ADR-002: Stack choices

- **Status:** accepted
- **Date:** 2026-05-12
- **Resolves:** none (codifies SPEC §4.2)

## Context

The stack needs to be runnable on one operator's Hostinger VPS alongside an existing Node project, cheap enough to keep total cost under $1.50/day of LLM spend, and familiar enough that maintenance is a side activity, not a job.

## Decision

| Layer | Choice | Why this over alternatives |
|---|---|---|
| Runtime | Node.js 22 + TypeScript | Mirrors `2nd-brain` — one mental model. Python adds a second toolchain on the same VPS. |
| Web framework | Fastify | Faster than Express; smaller surface than NestJS. |
| ORM | Drizzle | Type-safe queries, raw-SQL migrations (immutable, reviewable). Prisma's migration story is heavier and the generated client adds startup cost. |
| Database | PostgreSQL 16 + pgvector | Single store for relational + vector. Separate vector DB (Qdrant/Weaviate) is a second container, second backup target, second failure mode. |
| Queue | BullMQ + Redis 7 | BullMQ for job orchestration; Redis already needed for caching. RabbitMQ is overkill for one-machine workloads. |
| Scheduler | node-cron | In-process. External scheduler (k8s CronJob / systemd timers) wastes infra for a single VPS. |
| LLM router | LiteLLM proxy | Runs in this repo's docker-compose (`litellm` service + `config/litellm.yaml`); unified billing, retry, and model-swap surface. The original ADR text assumed a pre-existing operator-managed instance; in practice this repo ships its own. |
| Embeddings | OpenAI `text-embedding-3-small` | 1536-dim, cheap, multilingual. Local embedding models cost more VPS RAM than they save in API spend at this volume. |
| Summarisation LLM | Gemini 2.5 Flash-Lite | Cheapest model that produces usable English normalisations at scale. |
| Curation LLM | Claude Sonnet 4.5 | Top-of-funnel decisions only — quality matters more than throughput here. |
| Audio transcription | faster-whisper (CPU, on VPS) | Free at the chosen volume. Cloud transcription would dominate cost. |
| MCP server | `@modelcontextprotocol/sdk` | Official TS SDK; bearer-token auth via `SOCIALISN2_MCP_TOKEN`. |
| Telegram bot | `grammy` | Best-of-breed TS Telegram lib. |
| Container | Docker + docker-compose | Mirrors `2nd-brain` deployment. |
| Reverse proxy | Shared Traefik on VPS | The Odoo + n8n setup on this VPS already runs Traefik with `mytlschallenge`; socialisn2 joins the same network for free TLS termination. |
| Email→RSS bridge | Cloudflare Email Worker + D1 | Two Workers: `email-worker` (writer) + `feed-worker` (reader) over a shared D1 database. See ADR-003. |

## Rationale

- **No Chinese-hosted models** (SPEC §2): Qwen / DeepSeek / GLM are explicitly out. Affects no choice above; just rules out alternatives.
- **No Perplexity API**: direct ingestion from primary sources only — same constraint.
- **No Railway**: Socialisn2 is VPS-resident from day one. Avoids the egress + per-service-pricing trap that bit a related project.

## Consequences

- Future model swaps go through LiteLLM, not direct provider SDKs — keeps the LLM client surface (`src/lib/llm.ts`) minimal.
- VPS Redis is shared between BullMQ and the rate-limit cache; if either grows aggressive, the other suffers. Phase 2 PR 1 (queue plumbing) sets sensible memory limits.
- pgvector + PG16 means `CREATE EXTENSION vector;` at the top of every migration that touches embeddings. The PR 2 init migration does this once.

## References

- SPEC §4.2 (Stack table)
- SPEC §2 (Out of scope — model bans)
- ADR-001 (Architecture overview)
- ADR-003 (No-scraping policy + email-bridge)
