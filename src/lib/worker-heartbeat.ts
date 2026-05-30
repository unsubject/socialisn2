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
}

/**
 * Start a periodic "I'm alive" tick. The tick writes the current
 * mtime to the heartbeat file; the healthcheck script (or docker
 * healthcheck command) checks the file's age and considers the
 * process unhealthy once it exceeds `maxAgeMs`.
 *
 * Default tick: 30s. Default maxAgeMs in the matching healthcheck:
 * 120s — 4× the tick rate, so a momentary delay won't false-fail.
 */
export function startHeartbeat(
  name: string,
  opts: { intervalMs?: number; dir?: string } = {},
): HeartbeatHandle {
  const intervalMs = opts.intervalMs ?? 30_000;
  const dir = opts.dir ?? tmpdir();
  const path = join(dir, `${FILE_PREFIX}-${name}.heartbeat`);

  const touch = (): void => {
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
      // Don't crash the worker on a transient /tmp filesystem error —
      // docker healthcheck failing N consecutive times will recreate
      // the container, which is the right escalation.
      console.error(`[heartbeat ${name}] touch failed:`, err);
    }
  };

  // Initial touch BEFORE the first interval so docker's start_period
  // sees a fresh file immediately, not (interval ms) later. Without
  // this, a container with start_period=30s and intervalMs=30000 has a
  // race where the first healthcheck probe runs at ~30s but the
  // heartbeat hasn't fired yet → unhealthy → restart → loop.
  touch();
  const timer = setInterval(touch, intervalMs);
  // Don't keep the Node event loop alive just for the heartbeat
  // interval. `setInterval(...).unref()` so SIGTERM can shut the
  // process down even without an explicit stop() call.
  timer.unref();

  return {
    path,
    stop: () => clearInterval(timer),
  };
}
