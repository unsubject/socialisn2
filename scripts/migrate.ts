// State-tracked migration runner. Records each applied filename in
// `_socialisn2_migrations`; subsequent runs skip files already there.
// Each migration runs inside a single transaction so a failed file does
// not leave a half-applied schema.
//
// Baseline detection: if the tracker table is fresh but the schema from
// `001_init.sql` is already in place (because an earlier PR-2-era runner
// applied it without state tracking), record 001 as applied so the loop
// skips it. This is a one-shot upgrade path; future migrations don't need
// it because PR #4 (which introduced the tracker) merged before any
// migration past 001 was written.
//
// Phase 5 PR 2 (deploy) may swap this for something fancier, but the
// contract — idempotent re-runs against a persistent DB — stays the same.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const dir = resolve(process.cwd(), 'migrations');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const client = postgres(DATABASE_URL);

try {
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS _socialisn2_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const appliedRows = await client<{ filename: string }[]>`
    SELECT filename FROM _socialisn2_migrations
  `;
  const applied = new Set(appliedRows.map((r) => r.filename));

  if (applied.size === 0) {
    const baseline = await client<{ exists: string | null }[]>`
      SELECT to_regclass('public.sources')::text AS exists
    `;
    if (baseline[0]?.exists) {
      console.log(
        'Detected pre-tracker baseline (public.sources exists); recording 001_init.sql as applied without re-running it.',
      );
      await client`
        INSERT INTO _socialisn2_migrations (filename) VALUES ('001_init.sql')
        ON CONFLICT (filename) DO NOTHING
      `;
      applied.add('001_init.sql');
    }
  }

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`Skipping ${file} (already applied)`);
      continue;
    }
    const sql = readFileSync(join(dir, file), 'utf-8');
    console.log(`Running ${file}…`);
    await client.begin(async (tx) => {
      await tx.unsafe(sql);
      await tx`INSERT INTO _socialisn2_migrations (filename) VALUES (${file})`;
    });
  }
  console.log('Migrations complete.');
} finally {
  await client.end();
}
