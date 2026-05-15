// Daily cluster compaction (SPEC §7.4 step 4). Run manually with
// `tsx scripts/compact-clusters.ts`; Phase 4 PR 4 wires the cron at
// 03:00 ET. Exits 0 on success, 1 on error.
//
// Reads DATABASE_URL from the environment via the standard `src/db/client`
// factory; no flags. Logs one summary line + one line per merged pair.

import process from 'node:process';

import { createDb } from '../src/db/client.js';
import { compactClusters } from '../src/scoring/cluster.js';

async function main(): Promise<void> {
  const handle = createDb();
  try {
    const start = Date.now();
    const result = await compactClusters(handle.db);
    const dt = Date.now() - start;
    console.log(
      `compact-clusters: merged ${result.merges} pair(s) in ${dt}ms`,
    );
    for (const p of result.pairs) {
      console.log(`  ${p.source} -> ${p.target}  d=${p.distance.toFixed(4)}`);
    }
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  console.error('compact-clusters failed:', err);
  process.exit(1);
});
