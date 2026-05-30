// Explicit schema-drift check.
//
// Closes audit item (4) from the 2026-05-16 Phase 0-2 deferred list:
// previously the only thing pinning src/db/schema.ts against
// migrations/ was the seeds + integration tests indirectly inserting
// rows. That catches the worst kind of drift — schema.ts declaring a
// column the migration doesn't have — only when a test happens to
// exercise that column. This file makes the check explicit and
// exhaustive: walk every pgTable export, walk every declared column,
// assert each one exists in the live DB.
//
// What this catches:
//   - schema.ts declares a column that no migration creates
//   - schema.ts declares a table that no migration creates
//   - schema.ts column has a different SQL name than the DB column
//     (e.g. wrong snake_case conversion)
//
// What this does NOT catch:
//   - DB column has a different SQL TYPE than schema.ts expects
//     (drizzle queries surface this at runtime; type checking
//     covers most cases)
//   - DB column exists but schema.ts doesn't declare it
//     (NOT actually drift — schema.ts is allowed to be a subset)
//   - CHECK / FK constraint shape (the existing migrations smoke test
//     covers a couple of these explicitly; full constraint coverage
//     would require expressing every CHECK in TS, which drizzle's
//     type surface can't do)

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { getTableColumns, getTableName, type Table } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schemaModule from '../../src/db/schema.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

/** Type-guard: is this exported binding a drizzle pgTable handle? */
function isPgTable(v: unknown): v is Table {
  if (!v || typeof v !== 'object') return false;
  // Drizzle stamps its table objects with a Symbol-keyed internal struct
  // that includes `name` (the SQL table name). The safest cheap probe is
  // try{ getTableName(...) } — it throws on non-tables and returns the
  // SQL name otherwise. No public predicate exists in the drizzle-orm
  // surface as of v0.45.
  try {
    return typeof getTableName(v as Table) === 'string';
  } catch {
    return false;
  }
}

describe.skipIf(!DATABASE_URL)('schema drift', () => {
  let client: ReturnType<typeof postgres>;
  /** All { tableName, declaredColumns } pairs harvested from schema.ts. */
  const tables: Array<{ name: string; columns: Record<string, { name: string }> }> = [];

  beforeAll(async () => {
    assertDestructiveAllowed(DATABASE_URL!);
    client = postgres(DATABASE_URL!);
    // Independent reset + reapply so this test doesn't depend on
    // execution order vs migrations smoke test. The two land on the
    // same DB but vitest fileParallelism:false serializes them.
    await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const dir = resolve(process.cwd(), 'migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      await client.unsafe(readFileSync(join(dir, file), 'utf-8'));
    }

    for (const exported of Object.values(schemaModule)) {
      if (!isPgTable(exported)) continue;
      tables.push({
        name: getTableName(exported),
        columns: getTableColumns(exported) as Record<string, { name: string }>,
      });
    }
  });

  afterAll(async () => {
    await client?.end();
  });

  it('discovers at least one pgTable export from schema.ts', () => {
    // Guard against a refactor that breaks the export shape — without
    // this the per-column assertions would all vacuously pass and
    // the test would silently stop catching drift.
    expect(tables.length).toBeGreaterThan(5);
  });

  it('every schema.ts table corresponds to a real public-schema table', async () => {
    const dbTables = await client<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    const dbTableNames = new Set(dbTables.map((r) => r.table_name));
    const missing: string[] = [];
    for (const t of tables) {
      if (!dbTableNames.has(t.name)) missing.push(t.name);
    }
    expect(missing, `schema.ts tables not present in DB: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('every schema.ts column corresponds to a real DB column', async () => {
    const dbCols = await client<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
    `;
    /** lookup: table -> set of column names */
    const dbColsByTable = new Map<string, Set<string>>();
    for (const r of dbCols) {
      let set = dbColsByTable.get(r.table_name);
      if (!set) {
        set = new Set<string>();
        dbColsByTable.set(r.table_name, set);
      }
      set.add(r.column_name);
    }

    const missing: string[] = [];
    for (const t of tables) {
      const dbColSet = dbColsByTable.get(t.name);
      if (!dbColSet) continue; // table-level miss already reported by the prior test
      for (const [tsKey, col] of Object.entries(t.columns)) {
        if (!dbColSet.has(col.name)) {
          missing.push(`${t.name}.${col.name} (TS: ${tsKey})`);
        }
      }
    }
    expect(missing, `columns declared in schema.ts but missing from DB:\n  ${missing.join('\n  ')}`).toEqual(
      [],
    );
  });
});
