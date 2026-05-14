// Env-var loader for application-side processes (worker, scheduler, future app).
// Cloudflare Workers under email-worker/ and feed-worker/ have their own env model
// and don't go through here.

import process from 'node:process';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/**
 * Parse an env var as a positive integer, falling back to `fallback` when
 * unset. Throws on NaN, zero, negative, or non-integer — values that would
 * lead to silent runtime weirdness (zero-concurrency BullMQ worker, zero-ms
 * fetch timeout) if `Number()` had been used directly.
 */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid env var ${name}=${JSON.stringify(raw)} — must be a positive integer`,
    );
  }
  return parsed;
}

export const env = {
  databaseUrl: () => required('DATABASE_URL'),
  redisUrl: () => required('REDIS_URL'),
  // Scheduler tick frequency — every minute by default. The scheduler checks
  // each source's last_fetched_at + fetch_interval_min on every tick and
  // enqueues those that are due, so a 1-min tick gives ~1-min granularity on
  // top of the per-source cadences. Tighten only if very-fast cadences are
  // added (none in v1 — minimum is 30 min).
  schedulerTickCron: () => optional('INGESTION_SCHEDULER_TICK_CRON', '* * * * *'),
  // Cap on concurrent fetches the BullMQ worker processes. RSS fetches are
  // I/O bound; 8 is a safe default for a small VPS.
  ingestionConcurrency: () => positiveIntEnv('INGESTION_CONCURRENCY', 8),
  // User-Agent string for outbound HTTP fetches. Some publishers gate non-
  // browser UAs (Caixin returned 406 to the verifier in PR #1). Override
  // per-deployment if needed.
  httpUserAgent: () =>
    optional(
      'HTTP_USER_AGENT',
      'socialisn2/0.1 (+https://github.com/unsubject/socialisn2)',
    ),
  httpTimeoutMs: () => positiveIntEnv('HTTP_TIMEOUT_MS', 30_000),
  // GDELT requires an identifying User-Agent per their terms (no API key —
  // the UA + low traffic profile is the rate-limit budget). See ADR-005.
  gdeltUserAgent: () =>
    optional(
      'GDELT_USER_AGENT',
      'socialisn2/0.1 (+https://github.com/unsubject/socialisn2)',
    ),
  // LiteLLM proxy — chat-completion calls in scoring stages route here.
  litellmBaseUrl: () => required('LITELLM_BASE_URL'),
  litellmApiKey: () => required('LITELLM_API_KEY'),
  // OpenAI direct — embeddings only (text-embedding-3-small). See
  // src/lib/embeddings.ts for why we don't proxy this through LiteLLM.
  openaiApiKey: () => required('OPENAI_API_KEY'),
  // SPEC §12 cost enforcement. Hard ceiling, not advisory.
  costCeilingDailyUsd: () => {
    const raw = process.env.COST_CEILING_DAILY_USD ?? '1.50';
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `Invalid COST_CEILING_DAILY_USD=${JSON.stringify(raw)} — must be a positive number`,
      );
    }
    return parsed;
  },
  costAlertThreshold: () => {
    const raw = process.env.COST_ALERT_THRESHOLD ?? '0.80';
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
      throw new Error(
        `Invalid COST_ALERT_THRESHOLD=${JSON.stringify(raw)} — must be a number in (0, 1]`,
      );
    }
    return parsed;
  },
};
