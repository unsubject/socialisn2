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
  ingestionConcurrency: () => Number(optional('INGESTION_CONCURRENCY', '8')),
  // User-Agent string for outbound HTTP fetches. Some publishers gate non-
  // browser UAs (Caixin returned 406 to the verifier in PR #1). Override
  // per-deployment if needed.
  httpUserAgent: () =>
    optional(
      'HTTP_USER_AGENT',
      'socialisn2/0.1 (+https://github.com/unsubject/socialisn2)',
    ),
  httpTimeoutMs: () => Number(optional('HTTP_TIMEOUT_MS', '30000')),
};
