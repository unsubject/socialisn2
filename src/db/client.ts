import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema.js';

export function createDb(connectionString: string) {
  const queryClient = postgres(connectionString);
  return {
    db: drizzle(queryClient, { schema }),
    raw: queryClient,
    close: () => queryClient.end(),
  };
}

export type Db = ReturnType<typeof createDb>['db'];
