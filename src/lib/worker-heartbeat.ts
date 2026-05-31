// Worker heartbeat. Periodically touches a file under /tmp whose
// mtime docker-compose's healthcheck inspects to decide whether the
// worker process is alive AND its main loop is making progress.
//
// Why not just `pgrep`: a Node process can survive a BullMQ Worker
// crash, an internal exception that's swallowed somewhere, or a
// connection-pool hang — the process keeps running but doesn't tick.
// `restart: unless-stopped` only restarts on exit, so a hung but
// process-alive worker would be stuck indefinitely. The heartbeat file
// gets stale, and docker-compose marks the service unhealthy → which
// (because we also wire `restart: on-failure` for the workers below)
// triggers a recreate.
//
// Why the timer alone isn't enough — issue #122: a standalone
// setInterval keeps touching the file even if the worker's BullMQ job
// handler or cron callback is wedged (infinite loop, deadlocked DB
// call, hung Redis call). The event loop is still free, the timer
// still fires, healthcheck stays green forever. To catch wedged-but-
// process-alive workers, the timer is GATED on a `markProgress()`
// signal that the caller invokes from real worker activity (BullMQ
// `worker.on('completed' | 'drained')`, each cron tick). If no
// progress signal has fired within `progressStaleMs`, the timer stops
// touching the file → mtime ages past the healthcheck threshold →
// docker marks the container unhealthy.
//
// Detection latency = progressStaleMs + healthcheck maxAge.
// With defaults (120s + 120s) that's ≤ 4 min from wedge to restart,
// vs. never with the standalone-timer design.
//
// The file lives in /tmp (container-local; not on the feeds_data
// volume, not on the host) so two co-deployed worker containers can
// each have their own without colliding. Name = `${prefix}-${name}`
// to keep the filename self-describing in case an operator catting
// /tmp inside a container needs to identify it.

import { closeSync, openSync, futimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FILE_PREFIX = 'socialisn2';

export interface HeartbeatHandle {
  /** Absolute path to the touched file. Exposed for the healthcheck CLI. */
  path: string;
  /** Stop the periodic tick. Does NOT remove the file — docker
   *  healthcheck checks staleness, not existence. */
  stop: () => void;
  /**
   * Call from real worker activity (BullMQ events, cron tick callbacks)
   * to signal "the work loop is making progress." Updates the internal
   * progress timestamp AND touches the heartbeat file immediately so a
   * job completing right after a near-stall makes the healthcheck go
   * green at the next probe rather than waiting for the next interval.
   *
   * Idempotent and cheap — safe to call from every BullMQ event.
   */
  markProgress: () => void;
}

/**
 * Start a periodic "I'm alive AND making progress" tick. Two clocks
 * cooperate:
 *   1. setInterval, every `intervalMs` (default 30s) — would-touch
 *   2. `markProgress()`, called from the worker's real activity path —
 *      updates an internal `lastProgressAt` timestamp.
 *
 * On each interval tick, the timer touches the file ONLY if
 * `Date.now() - lastProgressAt <= progressStaleMs`. Otherwise it
 * skips the touch and the file ages out into the unhealthy range.
 *
 * `progressStaleMs` default = 4 × intervalMs (120s). Both ingestion's
 * scheduler tick and the scoring worker's tick cron fire every minute
 * by default, so 4 missed ticks is the wedge signal.
 *
 * Default tick: 30s. Default maxAgeMs in the matching healthcheck:
 * 120s — 4× the tick rate, so a momentary delay won't false-fail.
 */
export function startHeartbeat(
  name: string,
  opts: {
    intervalMs?: number;
    dir?: string;
    /** ms since last `markProgress()` after which the timer stops
     *  touching the file. Default: 4 × intervalMs. */
    progressStaleMs?: number;
  } = {},
): HeartbeatHandle {
  const intervalMs = opts.intervalMs ?? 30_000;
  const progressStaleMs = opts.progressStaleMs ?? 4 * intervalMs;
  const dir = opts.dir ?? tmpdir();
  const path = join(dir, `${FILE_PREFIX}-${name}.heartbeat`);

  const touch = (initial: boolean): void => {
    try {
      // Create the file if missing (O_CREAT semantics via openSync 'a'),
      // then futimes to NOW. fs.utimesSync would also work but the
      // open/futimes pair avoids one stat() syscall when the file
      // already exists, which is the steady state.
      const fd = openSync(path, 'a');
      try {
        const now = Date.now() / 1000;
        futimesSync(fd, now, now);
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      console.error(`[heartbeat ${name}] touch failed:`, err);
      // Initial vs steady-state error policy:
      //   - Initial touch failures (read-only /tmp, EPERM, missing dir)
      //     are non-recoverable — every subsequent touch will fail the
      //     same way and the healthcheck CLI will see ENOENT forever.
      //     Re-throw so the process exits and docker's `restart: ...`
      //     policy applies. With autoheal absent (Phase 2.c #1 follow-
      //     up), this is the ONLY way the worker can recover from a
      //     mounted-volume / perms misconfiguration.
      //   - Steady-state touch failures (transient ENOSPC, EBUSY) are
      //     swallowed: a healthy worker shouldn't crash on a flake; if
      //     it persists for N consecutive ticks the healthcheck will
      //     mark the container unhealthy.
      if (initial) {
        throw err;
      }
    }
  };

  // Boot grace: seed lastProgressAt = now so the start_period window
  // sees a fresh "progress" signal even before the worker's first
  // real activity. Without this, a slow boot (cold DB connect,
  // BullMQ Redis handshake, scheduler register) could elapse
  // progressStaleMs before markProgress() is first called, and the
  // healthcheck would false-positive-fail the first container start.
  let lastProgressAt = Date.now();
  // Once the timer detects a stall, log it ONCE (not every tick) so
  // the operator gets a clean signal in the worker log right when the
  // file stops advancing. Re-armed when markProgress() recovers.
  let stalledLogged = false;

  // Initial touch BEFORE the first interval so docker's start_period
  // sees a fresh file immediately, not (interval ms) later. Without
  // this, a container with start_period=30s and intervalMs=30000 has a
  // race where the first healthcheck probe runs at ~30s but the
  // heartbeat hasn't fired yet → unhealthy → restart → loop.
  touch(true);

  const timer = setInterval(() => {
    const ageMs = Date.now() - lastProgressAt;
    if (ageMs <= progressStaleMs) {
      touch(false);
      if (stalledLogged) {
        console.warn(
          `[heartbeat ${name}] progress resumed after stall (last age=${ageMs}ms)`,
        );
        stalledLogged = false;
      }
    } else if (!stalledLogged) {
      console.warn(
        `[heartbeat ${name}] progress stalled: last markProgress() ${ageMs}ms ago (threshold=${progressStaleMs}ms); healthcheck will fail`,
      );
      stalledLogged = true;
    }
  }, intervalMs);
  // Don't keep the Node event loop alive just for the heartbeat
  // interval. `setInterval(...).unref()` so SIGTERM can shut the
  // process down even without an explicit stop() call.
  timer.unref();

  const markProgress = (): void => {
    lastProgressAt = Date.now();
    // Touch immediately too so a job completing right after a stall
    // bumps mtime now rather than waiting up to `intervalMs` for the
    // next timer tick. Steady-state cost: ~1 extra syscall per real
    // worker activity event, which is cron-driven and bounded.
    touch(false);
  };

  return {
    path,
    stop: () => clearInterval(timer),
    markProgress,
  };
}
