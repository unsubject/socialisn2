// Shared guard for tests that destroy schema state. Refuses to run unless the
// database name in DATABASE_URL ends with `_test` OR the caller opts in via
// `SOCIALISN2_ALLOW_DESTRUCTIVE_TESTS=1`.

import process from 'node:process';

export function assertDestructiveAllowed(url: string): void {
  const dbName = new URL(url).pathname.replace(/^\//, '');
  const looksLikeTestDb = dbName.endsWith('_test');
  const explicitOptIn = process.env.SOCIALISN2_ALLOW_DESTRUCTIVE_TESTS === '1';
  if (!looksLikeTestDb && !explicitOptIn) {
    throw new Error(
      `Refusing to run destructive test against database "${dbName}". ` +
        'Point DATABASE_URL at a database whose name ends with `_test`, or set ' +
        'SOCIALISN2_ALLOW_DESTRUCTIVE_TESTS=1 to override.',
    );
  }
}
