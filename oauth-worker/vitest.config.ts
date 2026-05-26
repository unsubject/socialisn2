// Anchors vitest's config discovery here (so it doesn't walk up to the
// repo-root vitest.config.ts whose deps are unrelated to this package).
//
// We run plain Node vitest to match the sibling email-worker / feed-worker
// convention (no @cloudflare/vitest-pool-workers). @cloudflare/workers-oauth-
// provider imports `WorkerEntrypoint` from the runtime-only `cloudflare:workers`
// virtual module, which Node's ESM loader can't resolve — so we alias it to a
// no-op stub. Our handlers are plain `{ fetch }` objects and never instantiate
// WorkerEntrypoint, so the stub is behaviorally equivalent for these tests.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': new URL('./tests/stubs/cloudflare-workers.ts', import.meta.url)
        .pathname,
    },
  },
  // The provider package is ESM-externalized by default, so Node's loader
  // sees the bare `cloudflare:workers` import before our alias can rewrite it.
  // Force vitest to transform the package inline so the alias applies.
  ssr: {
    noExternal: ['@cloudflare/workers-oauth-provider'],
  },
});
