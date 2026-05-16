// Empty config — exists solely to anchor vitest's config discovery here
// so it doesn't walk up to the repo-root vitest.config.ts (whose deps
// are unrelated to this package and would fail to resolve).
import { defineConfig } from 'vitest/config';

export default defineConfig({});
