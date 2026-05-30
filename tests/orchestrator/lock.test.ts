// Real-PG test for src/orchestrator/lock.ts. The lock semantics are
// only meaningful against actual Postgres — postgres-js's
// `raw.reserve()` plus pg_try_advisory_lock are what we need to verify.
//
// The load-bearing assertion is "two concurrent withRunLock calls
// against the SAME key: one acquires + runs the work, the other
// returns acquired=false + does NOT run the work". A unit-level test
// with a mocked raw wouldn't catch the connection-pinning bug that
// motivated this file (advisory lock attached to the wrong session
// would silently let both pass).

import process from 'node:process';

import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  RUN_LOCK_KEY,
  withRunLock,
} from '../../src/orchestrator/lock.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('withRunLock (real PG)', () => {
  // Two separate postgres-js clients — same as having two separate
  // Node processes hitting the DB. Required because postgres-js
  // multiplexes a single client's queries over its pool; .reserve() on
  // one client wouldn't contend with .reserve() on the same client's
  // OTHER reserved connection (the pool just gives each its own).
  // The contention we actually need to verify happens across CLIENTS.
  let clientA: ReturnType<typeof postgres>;
  let clientB: ReturnType<typeof postgres>;

  // Use a key OFFSET FROM the production key so a parallel CI lane
  // running the real orchestrator (none today, but future-proof) can't
  // false-positive contend.
  const TEST_KEY = RUN_LOCK_KEY + 1;

  beforeAll(() => {
    assertDestructiveAllowed(DATABASE_URL!);
    clientA = postgres(DATABASE_URL!);
    clientB = postgres(DATABASE_URL!);
  });

  afterAll(async () => {
    await clientA.end();
    await clientB.end();
  });

  beforeEach(async () => {
    // Belt-and-braces: explicitly release the test key on both clients
    // so a previous failure that left the lock held doesn't poison the
    // next run.
    await clientA`SELECT pg_advisory_unlock_all()`;
    await clientB`SELECT pg_advisory_unlock_all()`;
  });

  async function probeLocked(
    client: ReturnType<typeof postgres>,
  ): Promise<boolean> {
    const rows = await client<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${TEST_KEY}) AS locked
    `;
    return rows[0]?.locked === true;
  }

  it('acquires the lock and runs the work block', async () => {
    let ran = false;
    const outcome = await withRunLock(
      clientA,
      async () => {
        ran = true;
        return 'ok' as const;
      },
      TEST_KEY,
    );

    expect(ran).toBe(true);
    expect(outcome).toEqual({ acquired: true, result: 'ok' });

    // Lock must be released after the work finishes. Probe via clientB
    // — it should be able to acquire and immediately release the same key.
    const acquired = await probeLocked(clientB);
    expect(acquired).toBe(true);
    await clientB`SELECT pg_advisory_unlock(${TEST_KEY})`;
  });

  it('returns acquired=false WITHOUT running the work when the lock is already held by another session', async () => {
    // Hold the lock from clientA on a reserved connection, then call
    // withRunLock via clientB — it should fail to acquire and return
    // {acquired:false} without invoking the work callback.
    const holder = await clientA.reserve();
    const holderRows = await holder<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${TEST_KEY}) AS locked
    `;
    expect(holderRows[0]?.locked).toBe(true);

    try {
      let ran = false;
      const outcome = await withRunLock(
        clientB,
        async () => {
          ran = true;
          return 'should-not-run';
        },
        TEST_KEY,
      );

      expect(ran).toBe(false);
      expect(outcome).toEqual({ acquired: false });
    } finally {
      await holder`SELECT pg_advisory_unlock(${TEST_KEY})`;
      holder.release();
    }
  });

  it('releases the lock even when the work block throws', async () => {
    const err = new Error('boom inside work');
    await expect(
      withRunLock(
        clientA,
        async () => {
          throw err;
        },
        TEST_KEY,
      ),
    ).rejects.toBe(err);

    // After the throw, the lock must NOT be held — otherwise the next
    // orchestrator tick would be permanently skipped. Verify by
    // acquiring + releasing on clientB.
    const acquired = await probeLocked(clientB);
    expect(acquired).toBe(true);
    await clientB`SELECT pg_advisory_unlock(${TEST_KEY})`;
  });
});
