// Migrations are hand-authored in `migrations/NNN_*.sql`. drizzle-kit is wired
// here for `introspect` (verify schema.ts matches the deployed DB) and `diff`.
// Do NOT run `drizzle-kit generate` without reviewing the output — the hand-
// authored migrations are canonical.

import type { Config } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  // drizzle-kit reads this config at CLI start; an empty-string fallback
  // would let it connect to a useless URL and surface a confusing error
  // deep in the introspect / diff path. Fail clear, fail early.
  throw new Error(
    'drizzle.config.ts: DATABASE_URL must be set in the env before running drizzle-kit',
  );
}

export default {
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl,
  },
} satisfies Config;
