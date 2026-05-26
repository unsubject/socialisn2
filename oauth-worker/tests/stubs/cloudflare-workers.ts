// Test stub for the `cloudflare:workers` virtual module.
//
// @cloudflare/workers-oauth-provider imports `WorkerEntrypoint` from
// `cloudflare:workers`, a module that only exists inside the workers runtime.
// The repo's convention is plain Node vitest (no @cloudflare/vitest-pool-workers),
// so we alias the import to this stub. The provider uses WorkerEntrypoint only
// for subclass/instanceof checks on the apiHandler; our handlers are plain
// `{ fetch }` objects, so a no-op class is sufficient.

export class WorkerEntrypoint {
  ctx: unknown;
  env: unknown;
  constructor(ctx?: unknown, env?: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}
