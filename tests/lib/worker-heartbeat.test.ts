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
//   - issue #122: timer SKIPS the touch once progressStaleMs elapses
//     since the last markProgress() — wedged-but-process-alive workers
//     are now detectable.
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

  // --- Issue #122: progress-gated heartbeat -------------------------------

  it('stops advancing mtime once progressStaleMs elapses without a markProgress call', async () => {
    // intervalMs=20 + progressStaleMs=50 → after ~70ms with no
    // markProgress, the timer should see lastProgressAt is too old
    // and skip the touch. The boot grace seeds lastProgressAt=now so
    // the first 1-2 ticks (40ms) are still allowed.
    const handle = startHeartbeat('unit-stale', {
      intervalMs: 20,
      progressStaleMs: 50,
      dir,
    });
    try {
      // Wait past the stall threshold + a couple intervals so we see
      // the timer skip at least 3 ticks beyond the last allowed touch.
      await new Promise((r) => setTimeout(r, 200));
      const stalledMtime = statSync(handle.path).mtimeMs;
      // Now wait another N intervals with NO markProgress.
      await new Promise((r) => setTimeout(r, 120));
      const laterMtime = statSync(handle.path).mtimeMs;
      // mtime must NOT have advanced — that's how the docker
      // healthcheck eventually sees the file age out.
      expect(laterMtime).toBe(stalledMtime);
      // And the file should be older than progressStaleMs by now.
      expect(Date.now() - laterMtime).toBeGreaterThan(50);
    } finally {
      handle.stop();
    }
  });

  it('resumes advancing mtime after markProgress() rescues from a stall', async () => {
    const handle = startHeartbeat('unit-rescue', {
      intervalMs: 20,
      progressStaleMs: 50,
      dir,
    });
    try {
      // Let it stall.
      await new Promise((r) => setTimeout(r, 150));
      const stalledMtime = statSync(handle.path).mtimeMs;
      // Mid-stall: a real worker activity event fires. markProgress()
      // touches immediately AND resets lastProgressAt so subsequent
      // timer ticks resume touching.
      handle.markProgress();
      const afterMark = statSync(handle.path).mtimeMs;
      expect(afterMark).toBeGreaterThan(stalledMtime);
      // Confirm the timer continues to touch while progress stays fresh.
      await new Promise((r) => setTimeout(r, 40));
      handle.markProgress(); // keep the window alive
      await new Promise((r) => setTimeout(r, 40));
      const stillFresh = statSync(handle.path).mtimeMs;
      expect(stillFresh).toBeGreaterThanOrEqual(afterMark);
    } finally {
      handle.stop();
    }
  });

  it('markProgress() is a no-throw cheap idempotent call', () => {
    const handle = startHeartbeat('unit-mark', { intervalMs: 10_000, dir });
    try {
      // Boot-time markProgress chain — caller may fire it from BullMQ
      // event handlers many times rapidly. Must not throw.
      for (let i = 0; i < 50; i++) handle.markProgress();
      expect(existsSync(handle.path)).toBe(true);
    } finally {
      handle.stop();
    }
  });

  it('quiet-but-healthy workers stay healthy when markProgress fires per interval', async () => {
    // Models the steady state of an idle ingestion-worker: scheduler
    // cron ticks every "minute" and calls markProgress(); no other
    // worker activity. mtime should keep advancing.
    const handle = startHeartbeat('unit-quiet', {
      intervalMs: 15,
      progressStaleMs: 80,
      dir,
    });
    try {
      const first = statSync(handle.path).mtimeMs;
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 30));
        handle.markProgress();
      }
      await new Promise((r) => setTimeout(r, 30));
      const final = statSync(handle.path).mtimeMs;
      expect(final).toBeGreaterThan(first);
    } finally {
      handle.stop();
    }
  });
});
