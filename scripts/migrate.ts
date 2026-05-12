// Minimal sequential migration runner. Reads `migrations/*.sql`, sorts by
// filename (so `001_init.sql` runs before `002_…`), and executes each against
// DATABASE_URL. No state tracking yet — every run replays every file. Adequate
// for Phase 0; Phase 5 PR 2 swaps in a tracked-state migration runner.

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
  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf-8');
    console.log(`Running ${file}…`);
    await client.unsafe(sql);
  }
  console.log('Migrations complete.');
} finally {
  await client.end();
}
