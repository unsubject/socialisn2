// Migrations are hand-authored in `migrations/NNN_*.sql`. drizzle-kit is wired
// here for `introspect` (verify schema.ts matches the deployed DB) and `diff`.
// Do NOT run `drizzle-kit generate` without reviewing the output — the hand-
// authored migrations are canonical.

import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
} satisfies Config;
