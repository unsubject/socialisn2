// Obs-4 preflight gate. Runs in CI / on the VPS BEFORE migrations.
//
// Why: the 2026-05-19 incident leaked POSTGRES_PASSWORD via a
// postgres-js parse error that landed in the GitHub Actions log. This
// script wraps the DB-connect path so any failure surfaces as a
// redacted error, AND validates the full env surface (LiteLLM, OpenAI,
// cost ceiling/alert, PUBLIC_HOST) so a misconfigured deploy fails
// loudly here rather than crash-looping the runtime.
//
// Exit 0 on green, exit 1 on red. Each red log is prefixed with the
// GitHub Actions `::error::` workflow command on its own line so the
// CI UI surfaces it as an annotation in addition to the structured
// JSON log emitted alongside.
//
// Invoked from .github/workflows/deploy-vps.yml via
//   docker compose run --rm --no-deps app node dist/scripts/preflight.js
// so the env inside the container exactly matches what the
// freshly-restarted app/workers will run with.

import process from 'node:process';

import { env } from '../src/config/env.js';
import { connectWithRedactedErrors } from '../src/lib/connect-with-redacted-errors.js';
import { createLogger } from '../src/lib/logger.js';

const log = createLogger('preflight');

/**
 * Emit a `::error::` workflow-command annotation to stderr so the
 * GitHub Actions UI surfaces a red annotation, AND emit the
 * structured JSON via the logger so the line is captured by
 * journalctl-style pipelines.
 *
 * The two-line emission is deliberate (advisor note 1):
 *   - GH Actions parses `::error::...` from raw stderr text and would
 *     NOT recognise it inside a JSON object.
 *   - The structured JSON line preserves component / level / fields
 *     for downstream log shipping.
 */
function failure(msg: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`::error::${msg}\n`);
  log.error(msg, fields);
}

interface CheckOutcome {
  ok: boolean;
  /** Reason text on failure; ignored on success. */
  reason?: string;
}

async function checkDatabaseUrl(): Promise<CheckOutcome> {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    return { ok: false, reason: 'DATABASE_URL is not set' };
  }
  try {
    const client = await connectWithRedactedErrors(raw);
    try {
      log.info('database reachable', { check: 'database_url' });
    } finally {
      await client.end({ timeout: 1 });
    }
    return { ok: true };
  } catch (err) {
    // The thrown Error from connectWithRedactedErrors is already
    // safe to log verbatim. Do NOT include `raw` or any field that
    // could re-expose the URI.
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }
}

function checkRequiredString(name: string, getter: () => string): CheckOutcome {
  try {
    const value = getter();
    if (!value) {
      return { ok: false, reason: `${name} is empty` };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg };
  }
}

function checkNumeric(name: string, getter: () => number): CheckOutcome {
  try {
    const value = getter();
    log.info(`${name} parsed`, { check: name, value });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg };
  }
}

async function main(): Promise<void> {
  log.info('starting preflight');

  // Order matters: each step short-circuits the rest on failure so
  // the operator sees the first thing wrong, not a cascade.
  const steps: Array<{ name: string; run: () => Promise<CheckOutcome> | CheckOutcome }> = [
    { name: 'database_url', run: () => checkDatabaseUrl() },
    { name: 'litellm_base_url', run: () => checkRequiredString('LITELLM_BASE_URL', env.litellmBaseUrl) },
    { name: 'litellm_api_key', run: () => checkRequiredString('LITELLM_API_KEY', env.litellmApiKey) },
    { name: 'openai_api_key', run: () => checkRequiredString('OPENAI_API_KEY', env.openaiApiKey) },
    { name: 'cost_ceiling_daily_usd', run: () => checkNumeric('COST_CEILING_DAILY_USD', env.costCeilingDailyUsd) },
    { name: 'cost_alert_threshold', run: () => checkNumeric('COST_ALERT_THRESHOLD', env.costAlertThreshold) },
    { name: 'public_host', run: () => checkRequiredString('PUBLIC_HOST', env.publicHost) },
  ];

  for (const step of steps) {
    const outcome = await step.run();
    if (!outcome.ok) {
      failure(`preflight failed at ${step.name}: ${outcome.reason ?? '(no reason)'}`, {
        step: step.name,
      });
      process.exit(1);
    }
    log.info(`preflight ${step.name} OK`, { step: step.name });
  }

  // Optional warnings — don't fail the gate, just surface them so the
  // operator sees the implications of partial config.
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN ?? '';
  const telegramChat = process.env.TELEGRAM_CHAT_ID ?? '';
  if (telegramToken && !telegramChat) {
    log.warn('TELEGRAM_BOT_TOKEN set but TELEGRAM_CHAT_ID empty — bot sends will no-op', {
      check: 'telegram',
    });
  }
  const mcpToken = process.env.SOCIALISN2_MCP_TOKEN ?? '';
  if (mcpToken) {
    log.info('MCP enabled (SOCIALISN2_MCP_TOKEN present)', { check: 'mcp' });
  }

  log.info('preflight OK');
}

await main();
