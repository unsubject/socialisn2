import { configDefaults, defineConfig } from 'vitest/config';

// Test files share a single Postgres database via DATABASE_URL and reset the
// `public` schema in `beforeAll`. Running them in parallel races the resets.
export default defineConfig({
  test: {
    fileParallelism: false,
    // oauth-worker/ is a separate Cloudflare Workers package with its own test
    // setup (Workers runtime + @cloudflare/workers-oauth-provider). It must not
    // be picked up by this root Node+Postgres run, where importing its
    // src/index.ts crashes on Workers globals.
    exclude: [...configDefaults.exclude, 'oauth-worker/**'],
    // Shim Duplex.prototype.destroySoon → destroy so @hono/node-server's
    // post-response 500ms forceClose timer doesn't throw a TypeError when
    // it fires against Fastify inject's mock socket. See the helper file
    // for the full rationale.
    setupFiles: ['./tests/helpers/destroy-soon-shim.ts'],
  },
});
