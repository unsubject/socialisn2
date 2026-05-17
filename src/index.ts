// Application entry. Boots the Fastify HTTP server (src/app.ts) and
// installs SIG handlers for graceful shutdown.
//
// docker-compose `app` service runs `node dist/index.js`; this file is
// the resolved target. The Phase 0 placeholder export that used to
// live here is gone — the Dockerfile's build stage still produces
// dist/ from src/, the file just no longer needs to exist as a stub.

import process from 'node:process';

import { buildApp } from './app.js';
import { createDb } from './db/client.js';

async function main(): Promise<void> {
  const { db, close } = createDb();
  const app = buildApp(db);

  const port = Number(process.env.PORT ?? '3000');
  const host = process.env.HOST ?? '0.0.0.0';
  // Listening on 0.0.0.0 inside the container so Caddy/nginx can reach
  // the port; in compose the `app` service maps 3000:3000.
  await app.listen({ port, host });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[app] ${signal} received; shutting down`);
    await app.close();
    await close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log(`[app] listening on ${host}:${port}`);
}

main().catch((err: unknown) => {
  console.error('[app] fatal:', err);
  process.exit(1);
});
