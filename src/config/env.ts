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
  schedulerTickCron: () => optional('INGESTION_SCHEDULER_TICK_CRON', '* * * * *'),
  ingestionConcurrency: () => positiveIntEnv('INGESTION_CONCURRENCY', 8),
  httpUserAgent: () =>
    optional(
      'HTTP_USER_AGENT',
      'socialisn2/0.1 (+https://github.com/unsubject/socialisn2)',
    ),
  httpTimeoutMs: () => positiveIntEnv('HTTP_TIMEOUT_MS', 30_000),
  gdeltUserAgent: () =>
    optional(
      'GDELT_USER_AGENT',
      'socialisn2/0.1 (+https://github.com/unsubject/socialisn2)',
    ),
  litellmBaseUrl: () => required('LITELLM_BASE_URL'),
  litellmApiKey: () => required('LITELLM_API_KEY'),
  openaiApiKey: () => required('OPENAI_API_KEY'),
  twoBrainMcpUrl: () => optional('TWO_BRAIN_MCP_URL', ''),
  twoBrainMcpToken: () => optional('TWO_BRAIN_MCP_TOKEN', ''),
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
  scoringWorkerTickCron: () => optional('SCORING_WORKER_TICK_CRON', '* * * * *'),
  scoringWorkerCompactionCron: () =>
    optional('SCORING_WORKER_COMPACTION_CRON', '0 4 * * *'),
  scoringWorkerBatchSize: () => positiveIntEnv('SCORING_WORKER_BATCH_SIZE', 20),
  scoringWorkerMaxAttempts: () => positiveIntEnv('SCORING_WORKER_MAX_ATTEMPTS', 3),
  rssPath: () => optional('RSS_PATH', ''),
  publicHost: () => required('PUBLIC_HOST'),
  telegramBotToken: () => optional('TELEGRAM_BOT_TOKEN', ''),
  telegramChatId: () => optional('TELEGRAM_CHAT_ID', ''),
  socialisn2McpToken: () => optional('SOCIALISN2_MCP_TOKEN', ''),
  // YouTube Data API key (SPEC §13 + §17). Optional — empty disables
  // the Phase 5 backfill's "fetch Simon's own channel videos" path.
  // Competitor channel polling (src/ingestion/youtube.ts) uses the
  // public Atom feed and does NOT need this key per ADR-004.
  youtubeApiKey: () => optional('YOUTUBE_API_KEY', ''),
};
