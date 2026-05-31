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
  /**
   * Phase 3: sub-budget for the 'normalize' bucket — covers stage='normalise'
   * + stage='embed' (per-raw-item processing). Default = 60% of the overall
   * daily ceiling so the ingestion tier can't starve the orchestrator
   * tier if a backlog spike floods the normalize stage. The default keeps
   * the sum (normalize + orchestrator) ≤ overall ceiling so a balanced
   * day doesn't hit the per-bucket caps before the daily.
   */
  costCeilingNormalizeDailyUsd: () => {
    const raw = process.env.COST_CEILING_NORMALIZE_DAILY_USD;
    if (raw === undefined || raw === '') {
      // 60% of overall ceiling. Reads costCeilingDailyUsd to stay in sync
      // if the overall ceiling is raised, without operator having to also
      // bump the sub-budgets.
      return env.costCeilingDailyUsd() * 0.6;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `Invalid COST_CEILING_NORMALIZE_DAILY_USD=${JSON.stringify(raw)} — must be a positive number`,
      );
    }
    return parsed;
  },
  /**
   * Phase 3: sub-budget for the 'orchestrator' bucket — covers
   * stage='stage4_summarise' + stage='stage6_curate'. Default = 80% of
   * the overall daily ceiling. Larger than the normalize default because
   * a single curate call (Gemini 3.5 Flash, ~$0.003-0.004) is materially
   * pricier than a single normalise call (Gemini Flash-Lite, ~$0.0006);
   * a 50/50 split would have orchestrator hit its sub-budget too easily
   * on a day with normal cluster volume. The two sub-budgets DELIBERATELY
   * sum to >100% of the overall ceiling so the overall ceiling remains
   * the binding constraint on a day where both tiers are spending; the
   * sub-budget only fires when ONE tier is running away while the other
   * is quiet.
   */
  costCeilingOrchestratorDailyUsd: () => {
    const raw = process.env.COST_CEILING_ORCHESTRATOR_DAILY_USD;
    if (raw === undefined || raw === '') {
      return env.costCeilingDailyUsd() * 0.8;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `Invalid COST_CEILING_ORCHESTRATOR_DAILY_USD=${JSON.stringify(raw)} — must be a positive number`,
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
  // Simon's YouTube channel handle for the backfill corpus load
  // (SPEC §13, ADR-012). Default matches the canonical handle in
  // SPEC §13. Override for test channels or if the handle changes.
  youtubeChannelHandle: () => optional('YOUTUBE_CHANNEL_HANDLE', '@leesimon'),
  // ADR-013: daily Bayesian recalibration of source authority. Default
  // 04:00 UTC (between morning and afternoon scoring runs). Prior strength
  // k controls how much accumulated feedback is needed to meaningfully
  // move a source away from its seed authority — k=20 means ~20 picks/passes
  // before the posterior moves materially.
  recalibrateCron: () => optional('RECALIBRATE_CRON', '0 4 * * *'),
  recalibratePriorStrength: () =>
    positiveIntEnv('RECALIBRATE_PRIOR_STRENGTH', 20),
  // Twice-daily orchestrator cron (Build task U0xDaFVlYkpZVW02aEcwdg,
  // SPEC §9). Defaults match the spec: 05:00 ET morning, 14:00 ET
  // afternoon. Timezone is pinned via the cron-registration options so
  // the schedule is independent of host TZ. Override via env to test
  // (e.g. set both to '* * * * *' against a stub runScoring in dev).
  orchestratorMorningCron: () => optional('ORCHESTRATOR_MORNING_CRON', '0 5 * * *'),
  orchestratorAfternoonCron: () => optional('ORCHESTRATOR_AFTERNOON_CRON', '0 14 * * *'),
  orchestratorTimezone: () => optional('ORCHESTRATOR_TIMEZONE', 'America/New_York'),
};
