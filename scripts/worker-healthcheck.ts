// Docker-compose healthcheck for the BullMQ workers.
//
// Invoked as `node dist/scripts/worker-healthcheck.js <name>` where
// <name> matches the name passed to startHeartbeat() in the worker
// process. Exits 0 if the heartbeat file's mtime is within MAX_AGE_MS
// of now; exits 1 otherwise (= docker marks the container unhealthy).
//
// MAX_AGE_MS is 4× the worker's default 30s tick: 120s. Tunable via
// WORKER_HEARTBEAT_MAX_AGE_MS so an operator can loosen it for a
// known-slow environment without rebuilding the image.

import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const DEFAULT_MAX_AGE_MS = 120_000;

function main(): void {
  const name = process.argv[2];
  if (!name) {
    process.stderr.write('usage: worker-healthcheck <name>\n');
    process.exit(2);
  }

  const maxAgeMs = Number(
    process.env.WORKER_HEARTBEAT_MAX_AGE_MS ?? DEFAULT_MAX_AGE_MS,
  );
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    process.stderr.write(
      `WORKER_HEARTBEAT_MAX_AGE_MS must be a positive number; got ${process.env.WORKER_HEARTBEAT_MAX_AGE_MS}\n`,
    );
    process.exit(2);
  }

  const path = join(tmpdir(), `socialisn2-${name}.heartbeat`);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch (err) {
    process.stderr.write(`heartbeat missing: ${path} (${(err as Error).message})\n`);
    process.exit(1);
  }
  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs > maxAgeMs) {
    process.stderr.write(
      `heartbeat stale: ${path} age=${ageMs}ms threshold=${maxAgeMs}ms\n`,
    );
    process.exit(1);
  }
  // Quiet on success — docker only cares about the exit code, and a
  // noisy healthcheck would pollute the container log every 30s.
  process.exit(0);
}

main();
