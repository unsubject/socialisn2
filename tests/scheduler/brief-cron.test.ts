// Unit tests for src/scheduler/brief-cron.ts (redesign P1). Mirrors
// orchestrator-cron.test.ts: scheduleFn spy, stubbed runWeeklyBrief,
// no real cron registration.

import type { ScheduledTask } from 'node-cron';
import { describe, expect, it, vi } from 'vitest';

import type { Db } from '../../src/db/client.js';
import type { Logger } from '../../src/lib/logger.js';
import type { BriefRunResult } from '../../src/orchestrator/brief.js';
import { startBriefCron } from '../../src/scheduler/brief-cron.js';
import type { ScheduleFn } from '../../src/scheduler/orchestrator-cron.js';

function fakeTask(): { stop: ReturnType<typeof vi.fn> } {
  return { stop: vi.fn() };
}

type LoggerWithMocks = {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  child: () => LoggerWithMocks;
};

function makeLogger(): LoggerWithMocks & Logger {
  const log: Partial<LoggerWithMocks> = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: (): LoggerWithMocks => log as LoggerWithMocks,
  };
  return log as unknown as LoggerWithMocks & Logger;
}

function okResult(): BriefRunResult {
  return {
    runId: 'run-brief-fake',
    briefId: 'brief-fake',
    weekOf: '2026-07-05',
    pitchCount: 4,
    totalCostUsd: 0.12,
    status: 'completed',
  };
}

describe('startBriefCron', () => {
  const fakeDb = {} as Db;

  it('registers the Sunday pattern pinned to the orchestrator timezone', () => {
    const task = fakeTask();
    const scheduleFn: ScheduleFn = vi
      .fn()
      .mockReturnValue(task as unknown as ScheduledTask);

    const handle = startBriefCron(fakeDb, {
      runWeeklyBrief: vi.fn(),
      scheduleFn,
      logger: makeLogger(),
    });

    const mock = vi.mocked(scheduleFn);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]![0]).toBe('0 18 * * 0');
    expect(mock.mock.calls[0]![2]).toMatchObject({ timezone: 'America/New_York' });

    handle.stop();
    expect(task.stop).toHaveBeenCalledTimes(1);
  });

  it('a tick runs the brief and logs completion; onTick fires before and after', async () => {
    let tickFn: (() => void) | undefined;
    const scheduleFn: ScheduleFn = vi.fn((_pattern, fn) => {
      tickFn = fn;
      return fakeTask() as unknown as ScheduledTask;
    });
    const runWeeklyBrief = vi.fn().mockResolvedValue(okResult());
    const onTick = vi.fn();
    const logger = makeLogger();

    startBriefCron(fakeDb, { runWeeklyBrief, scheduleFn, logger, onTick });
    tickFn!();
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalledTimes(1));

    expect(runWeeklyBrief).toHaveBeenCalledWith(fakeDb);
    expect(onTick).toHaveBeenCalledTimes(2);
    expect(logger.info.mock.calls[0]![1]).toMatchObject({
      week_of: '2026-07-05',
      pitch_count: 4,
      status: 'completed',
    });
  });

  it('a throwing tick is logged and swallowed — the cron survives', async () => {
    let tickFn: (() => void) | undefined;
    const scheduleFn: ScheduleFn = vi.fn((_pattern, fn) => {
      tickFn = fn;
      return fakeTask() as unknown as ScheduledTask;
    });
    const runWeeklyBrief = vi.fn().mockRejectedValue(new Error('boom'));
    const logger = makeLogger();

    startBriefCron(fakeDb, { runWeeklyBrief, scheduleFn, logger });
    expect(() => tickFn!()).not.toThrow();
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledTimes(1));
    expect(logger.error.mock.calls[0]![1]).toMatchObject({ error: 'boom' });
  });
});
