// Unit + real-PG tests for the stuck-runs watchdog + boot reaper.
//
// The unit test exercises the schedule wiring + tick dispatch via the
// injectable scheduleFn (same shape as orchestrator-cron.test.ts).
// The real-PG test exercises the reaper SQL — it's the load-bearing
// piece (the watchdog is meaningless if the UPDATE doesn't actually
// flip stuck rows).

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { ScheduledTask } from 'node-cron';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema.js';
import type { Db } from '../../src/db/client.js';
import type { Logger } from '../../src/lib/logger.js';
import {
  reapOrphanedRunsOnBoot,
  startStuckRunsWatchdog,
} from '../../src/scheduler/stuck-runs-watchdog.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

type FakeTask = { stop: ReturnType<typeof vi.fn> };
function fakeTask(): FakeTask {
  return { stop: vi.fn() };
}

type LoggerWithMocks = Logger & {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
};
function makeLogger(): LoggerWithMocks {
  const log = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: (): LoggerWithMocks => log as unknown as LoggerWithMocks,
  };
  return log as unknown as LoggerWithMocks;
}

describe('startStuckRunsWatchdog (unit)', () => {
  const fakeDb = {} as Db;

  it('registers a cron at */5 * * * * by default and exposes stop()', () => {
    const task = fakeTask();
    const scheduleFn = vi
      .fn<
        (
          pattern: string,
          fn: () => void,
          options?: { scheduled?: boolean; timezone?: string },
        ) => ScheduledTask
      >()
      .mockReturnValue(task as unknown as ScheduledTask);

    const handle = startStuckRunsWatchdog(fakeDb, {
      scheduleFn,
      logger: makeLogger(),
    });

    expect(scheduleFn).toHaveBeenCalledTimes(1);
    const [pattern] = scheduleFn.mock.calls[0]!;
    expect(pattern).toBe('*/5 * * * *');

    handle.stop();
    expect(task.stop).toHaveBeenCalledTimes(1);
  });

  it('logs a warn line only when reapNow returns reaped > 0', async () => {
    const callbacks: Array<() => void> = [];
    const scheduleFn = vi.fn(
      (_pattern: string, fn: () => void): ScheduledTask => {
        callbacks.push(fn);
        return fakeTask() as unknown as ScheduledTask;
      },
    );

    // Stub db.execute to return 0 then 2 rows.
    let callCount = 0;
    const stubDb = {
      execute: vi.fn(async () => {
        callCount += 1;
        return callCount === 1 ? [] : [{ id: 'a' }, { id: 'b' }];
      }),
    } as unknown as Db;

    const logger = makeLogger();
    startStuckRunsWatchdog(stubDb, {
      scheduleFn,
      logger,
    });

    // First tick: 0 reaped → no warn log.
    callbacks[0]!();
    await vi.waitFor(() => {
      expect(stubDb.execute).toHaveBeenCalledTimes(1);
    });
    expect(logger.warn).not.toHaveBeenCalled();

    // Second tick: 2 reaped → warn log with reaped count.
    callbacks[0]!();
    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalled();
    });
    const warnCall = logger.warn.mock.calls.find(
      ([msg]) => typeof msg === 'string' && msg.includes('reaped'),
    );
    expect(warnCall).toBeDefined();
    expect(warnCall![1]).toMatchObject({ reaped: 2, max_age_minutes: 90 });
  });
});

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('stuck-runs-watchdog (real PG)', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    assertDestructiveAllowed(DATABASE_URL!);
    client = postgres(DATABASE_URL!);
    db = drizzle(client, { schema });
    await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    for (const f of readdirSync(resolve(process.cwd(), 'migrations'))
      .filter((x) => x.endsWith('.sql'))
      .sort()) {
      await client.unsafe(
        readFileSync(join(resolve(process.cwd(), 'migrations'), f), 'utf-8'),
      );
    }
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.unsafe('TRUNCATE TABLE runs CASCADE');
  });

  it('reapNow flips only runs.status=running older than maxAgeMinutes', async () => {
    // Two stuck runs (old enough), one running but recent, one completed.
    const stuckOld1 = uuidv7();
    const stuckOld2 = uuidv7();
    const recent = uuidv7();
    const done = uuidv7();
    await client`
      INSERT INTO runs (id, kind, status, started_at, completed_at)
      VALUES
        (${stuckOld1}, 'morning',  'running',   NOW() - INTERVAL '120 minutes', NULL),
        (${stuckOld2}, 'manual',   'running',   NOW() - INTERVAL '95 minutes',  NULL),
        (${recent},    'manual',   'running',   NOW() - INTERVAL '30 minutes',  NULL),
        (${done},      'morning',  'completed', NOW() - INTERVAL '120 minutes', NOW())
    `;

    const handle = startStuckRunsWatchdog(db, {
      scheduleFn: vi.fn().mockReturnValue({ stop: vi.fn() } as unknown as ScheduledTask),
      logger: makeLogger(),
      maxAgeMinutes: 90,
    });

    const result = await handle.reapNow();
    expect(result.reaped).toBe(2);

    const rows = await client<{ id: string; status: string; error: string | null }[]>`
      SELECT id, status, error FROM runs ORDER BY id
    `;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[stuckOld1]!.status).toBe('failed');
    expect(byId[stuckOld1]!.error).toContain('stuck_run_watchdog');
    expect(byId[stuckOld2]!.status).toBe('failed');
    expect(byId[recent]!.status).toBe('running'); // not yet stuck
    expect(byId[done]!.status).toBe('completed');

    handle.stop();
  });

  it('reapOrphanedRunsOnBoot flips ALL running rows regardless of age', async () => {
    // The boot reaper is unconditional — restart is the signal, so age
    // doesn't matter. Even a 5-second-old running row is orphaned if
    // the only process that could touch it just restarted.
    const a = uuidv7();
    const b = uuidv7();
    const c = uuidv7();
    await client`
      INSERT INTO runs (id, kind, status, started_at)
      VALUES
        (${a}, 'morning', 'running',   NOW() - INTERVAL '1 second'),
        (${b}, 'manual',  'running',   NOW() - INTERVAL '2 hours'),
        (${c}, 'morning', 'completed', NOW() - INTERVAL '10 minutes')
    `;

    const result = await reapOrphanedRunsOnBoot(db);
    expect(result.reaped).toBe(2);

    const rows = await client<{ id: string; status: string; error: string | null }[]>`
      SELECT id, status, error FROM runs ORDER BY id
    `;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[a]!.status).toBe('failed');
    expect(byId[a]!.error).toContain('process_restart');
    expect(byId[b]!.status).toBe('failed');
    expect(byId[c]!.status).toBe('completed');
  });
});
