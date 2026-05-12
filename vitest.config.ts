import { defineConfig } from 'vitest/config';

// Test files share a single Postgres database via DATABASE_URL and reset the
// `public` schema in `beforeAll`. Running them in parallel races the resets.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
