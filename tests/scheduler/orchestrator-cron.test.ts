// Unit test for src/scheduler/orchestrator-cron.ts.
//
// Pure dep-injection — no DB, no real cron registration. We hand the
// module:
//   - a stub `runScoring` so we can assert it's called with the right kind
//     and observe what happens when it throws
//   - a stub `scheduleFn` standing in for cron.schedule so we can capture
//     the registered patterns + timezone option AND invoke the wrapped
//     callback synchronously to verify the dispatch
//   - a silent logger so errors don't pollute test stdout (and so we can
//     spy on error/info to confirm the swallow-on-throw path)
//
// Time-bomb-free: no calendar literals anywhere. The fact that the default
// patterns are '0 5 * * *' and '0 14 * * *' is asserted via equality, but
// nothing in this test resolves those patterns against wall-clock time.

import type { ScheduledTask } from 'node-cron';
import { describe, expect, it, vi } from 'vitest';

import type { Db } from '../../src/db/client.js';
import type { RunOptions, RunResult } from '../../src/orchestrator/run.js';
import {
  startOrchestratorCron,
  type ScheduleFn,
} from '../../src/scheduler/orchestrator-cron.js';

/** Minimal stand-in for node-cron's ScheduledTask. Cast via `as unknown as
 *  ScheduledTask` at the boundary — we only ever read `stop`. */
type FakeTask = { stop: ReturnType<typeof vi.fn> };

function fakeTask(): FakeTask {
  return { stop: vi.fn() };
}

/** Silent logger that records error/info calls for the swallow assertion.
 *  Implements just enough of Logger to satisfy the dep contract. */
function makeLogger(): {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  child: () => ReturnType<typeof makeLogger>;
} {
  const log = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: (): ReturnType<typeof makeLogger> => log,
  };
  return log;
}

/** Build a successful RunResult — runScoring's full return shape, all
 *  counters zeroed. Used so the .then() info-log path doesn't NPE. */
function okResult(kind: RunOptions['kind']): RunResult {
  return {
    runId: `run-${kind}-fake`,
    clustersConsidered: 0,
    clustersAdvancedToStage4: 0,
    clustersDroppedByArchive: 0,
    clustersFlaggedRelatedToRecentWork: 0,
    clustersBelowCutoff: 0,
    candidatesPersisted: 0,
    totalCostUsd: 0,
    status: 'completed',
  };
}

describe('startOrchestratorCron', () => {
  // The Db type is structural; passing an empty object cast to Db is fine
  // because nothing in the cron layer actually touches it — it's only
  // forwarded to runScoring, which is stubbed.
  const fakeDb = {} as Db;

  it('registers two cron tasks with the default morning + afternoon patterns and pinned timezone', () => {
    const morning = fakeTask();
    const afternoon = fakeTask();
    const scheduleFn: ScheduleFn = vi
      .fn()
      .mockReturnValueOnce(morning as unknown as ScheduledTask)
      .mockReturnValueOnce(afternoon as unknown as ScheduledTask);

    const handle = startOrchestratorCron(fakeDb, {
      runScoring: vi.fn(),
      scheduleFn,
      logger: makeLogger(),
    });

    const mock = vi.mocked(scheduleFn);
    expect(mock).toHaveBeenCalledTimes(2);

    const firstCall = mock.mock.calls[0]!;
    const secondCall = mock.mock.calls[1]!;

    expect(firstCall[0]).toBe('0 5 * * *');
    expect(secondCall[0]).toBe('0 14 * * *');

    // CRITICAL: both schedules must be pinned to America/New_York so the
    // morning/afternoon fire times don't drift if the host TZ changes.
    expect(firstCall[2]).toMatchObject({ scheduled: true, timezone: 'America/New_York' });
    expect(secondCall[2]).toMatchObject({ scheduled: true, timezone: 'America/New_York' });

    expect(handle.morning).toBe(morning as unknown as ScheduledTask);
    expect(handle.afternoon).toBe(afternoon as unknown as ScheduledTask);
  });

  it('stop() stops both registered tasks', () => {
    const morning = fakeTask();
    const afternoon = fakeTask();
    const scheduleFn: ScheduleFn = vi
      .fn()
      .mockReturnValueOnce(morning as unknown as ScheduledTask)
      .mockReturnValueOnce(afternoon as unknown as ScheduledTask);

    const handle = startOrchestratorCron(fakeDb, {
      runScoring: vi.fn(),
      scheduleFn,
      logger: makeLogger(),
    });

    handle.stop();

    expect(morning.stop).toHaveBeenCalledTimes(1);
    expect(afternoon.stop).toHaveBeenCalledTimes(1);
  });

  it('dispatches runScoring with kind=morning on the first tick and kind=afternoon on the second', async () => {
    const callbacks: Array<() => void> = [];
    const scheduleFn: ScheduleFn = vi.fn(
      (_pattern: string, func: () => void) => {
        callbacks.push(func);
        return fakeTask() as unknown as ScheduledTask;
      },
    );

    const runScoring = vi
      .fn<(db: Db, opts: RunOptions) => Promise<RunResult>>()
      .mockImplementation((_db, opts) => Promise.resolve(okResult(opts.kind)));

    startOrchestratorCron(fakeDb, {
      runScoring,
      scheduleFn,
      logger: makeLogger(),
    });

    // Fire each tick synchronously.
    callbacks[0]!();
    callbacks[1]!();

    // Wait for the promise chains inside the callback to settle so the
    // assertions below see the runScoring calls (the cron callback is
    // sync and starts the promise but doesn't await it).
    await vi.waitFor(() => {
      expect(runScoring).toHaveBeenCalledTimes(2);
    });

    expect(runScoring.mock.calls[0]![1]).toEqual({ kind: 'morning' });
    expect(runScoring.mock.calls[1]![1]).toEqual({ kind: 'afternoon' });
  });

  it('logs and swallows errors from runScoring (cron tick must not throw)', async () => {
    const callbacks: Array<() => void> = [];
    const scheduleFn: ScheduleFn = vi.fn(
      (_pattern: string, func: () => void) => {
        callbacks.push(func);
        return fakeTask() as unknown as ScheduledTask;
      },
    );

    const boom = new Error('runScoring blew up');
    const runScoring = vi
      .fn<(db: Db, opts: RunOptions) => Promise<RunResult>>()
      .mockRejectedValue(boom);
    const logger = makeLogger();

    startOrchestratorCron(fakeDb, {
      runScoring,
      scheduleFn,
      logger,
    });

    // The tick callback itself must NOT throw — the cron framework would
    // otherwise treat it as a fatal task crash. Wrap in expect().not.toThrow
    // to make the contract explicit.
    expect(() => callbacks[0]!()).not.toThrow();

    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalled();
    });

    const errCall = logger.error.mock.calls.find(
      ([msg]) => msg === 'orchestrator cron tick threw',
    );
    expect(errCall).toBeDefined();
    expect(errCall![1]).toMatchObject({
      kind: 'morning',
      error: 'runScoring blew up',
    });
  });

  it('respects env overrides for cron patterns and timezone', () => {
    const previousMorning = process.env.ORCHESTRATOR_MORNING_CRON;
    const previousAfternoon = process.env.ORCHESTRATOR_AFTERNOON_CRON;
    const previousTz = process.env.ORCHESTRATOR_TIMEZONE;

    process.env.ORCHESTRATOR_MORNING_CRON = '15 6 * * *';
    process.env.ORCHESTRATOR_AFTERNOON_CRON = '45 15 * * *';
    process.env.ORCHESTRATOR_TIMEZONE = 'UTC';

    try {
      const scheduleFn: ScheduleFn = vi
        .fn()
        .mockReturnValueOnce(fakeTask() as unknown as ScheduledTask)
        .mockReturnValueOnce(fakeTask() as unknown as ScheduledTask);

      startOrchestratorCron(fakeDb, {
        runScoring: vi.fn(),
        scheduleFn,
        logger: makeLogger(),
      });

      const mock = vi.mocked(scheduleFn);
      expect(mock.mock.calls[0]![0]).toBe('15 6 * * *');
      expect(mock.mock.calls[1]![0]).toBe('45 15 * * *');
      expect(mock.mock.calls[0]![2]).toMatchObject({ timezone: 'UTC' });
      expect(mock.mock.calls[1]![2]).toMatchObject({ timezone: 'UTC' });
    } finally {
      // Restore env so this test doesn't leak into other test files in
      // the run (vitest reuses the Node process).
      if (previousMorning === undefined) delete process.env.ORCHESTRATOR_MORNING_CRON;
      else process.env.ORCHESTRATOR_MORNING_CRON = previousMorning;
      if (previousAfternoon === undefined) delete process.env.ORCHESTRATOR_AFTERNOON_CRON;
      else process.env.ORCHESTRATOR_AFTERNOON_CRON = previousAfternoon;
      if (previousTz === undefined) delete process.env.ORCHESTRATOR_TIMEZONE;
      else process.env.ORCHESTRATOR_TIMEZONE = previousTz;
    }
  });
});
