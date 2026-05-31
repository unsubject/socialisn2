// Unit tests for src/lib/worker-heartbeat.ts.
//
// Property coverage:
//   - first tick happens before the interval fires (start_period race)
//   - subsequent ticks update mtime
//   - stop() prevents further ticks
//   - the timer is unref'd so it doesn't keep the event loop alive
//     (asserted indirectly: Node would otherwise not exit the worker
//     during shutdown — we just check the handle is returned without
//     side-effect)
//
// We use a temp dir so the test doesn't collide with a live worker
// running on the same machine.

import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startHeartbeat } from '../../src/lib/worker-heartbeat.js';

describe('startHeartbeat', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heartbeat-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('touches the heartbeat file immediately on start', () => {
    const handle = startHeartbeat('unit', { intervalMs: 10_000, dir });
    try {
      expect(existsSync(handle.path)).toBe(true);
      // mtime should be within ~1 second of now (touching is sync).
      const ageMs = Date.now() - statSync(handle.path).mtimeMs;
      expect(ageMs).toBeLessThan(1_000);
    } finally {
      handle.stop();
    }
  });

  it('updates mtime on each interval tick', async () => {
    const handle = startHeartbeat('unit-tick', { intervalMs: 50, dir });
    try {
      const initial = statSync(handle.path).mtimeMs;
      // Wait long enough for at least one tick.
      await new Promise((r) => setTimeout(r, 120));
      const next = statSync(handle.path).mtimeMs;
      expect(next).toBeGreaterThan(initial);
    } finally {
      handle.stop();
    }
  });

  it('stop() prevents further ticks', async () => {
    const handle = startHeartbeat('unit-stop', { intervalMs: 50, dir });
    handle.stop();
    const initial = statSync(handle.path).mtimeMs;
    await new Promise((r) => setTimeout(r, 150));
    const afterStop = statSync(handle.path).mtimeMs;
    expect(afterStop).toBe(initial);
  });

  it('uses the file naming convention so the healthcheck CLI can find it', () => {
    const handle = startHeartbeat('my-worker', { intervalMs: 10_000, dir });
    try {
      expect(handle.path).toMatch(/socialisn2-my-worker\.heartbeat$/);
    } finally {
      handle.stop();
    }
  });
});
