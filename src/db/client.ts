// Shared Postgres + Drizzle factory. Tests open their own postgres-js client
// per-suite so they can reset the schema and run serially — do not import
// this module from tests/.

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { env } from '../config/env.js';
import * as schema from './schema.js';

export function createDb(connectionString: string = env.databaseUrl()) {
  const queryClient = postgres(connectionString);
  return {
    db: drizzle(queryClient, { schema }),
    raw: queryClient,
    close: () => queryClient.end(),
  };
}

export type DbHandle = ReturnType<typeof createDb>;
export type Db = DbHandle['db'];
