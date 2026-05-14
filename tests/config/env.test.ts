// Regression tests for the env helpers (Finding 4). The defaults are
// hit on every worker boot; bad values should fail fast, not silently
// degrade to NaN-driven behaviour in BullMQ or AbortSignal.timeout.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '../../src/config/env.js';

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('env.ingestionConcurrency', () => {
  const KEY = 'INGESTION_CONCURRENCY';
  let original: string | undefined;
  beforeEach(() => {
    original = process.env[KEY];
  });
  afterEach(() => {
    setEnv(KEY, original);
  });

  it('returns the fallback when unset', () => {
    setEnv(KEY, undefined);
    expect(env.ingestionConcurrency()).toBe(8);
  });

  it('returns the fallback when set to empty string', () => {
    setEnv(KEY, '');
    expect(env.ingestionConcurrency()).toBe(8);
  });

  it('parses a positive integer', () => {
    setEnv(KEY, '16');
    expect(env.ingestionConcurrency()).toBe(16);
  });

  it('throws on NaN-producing input', () => {
    setEnv(KEY, 'not-a-number');
    expect(() => env.ingestionConcurrency()).toThrow(/positive integer/);
  });

  it('throws on zero', () => {
    setEnv(KEY, '0');
    expect(() => env.ingestionConcurrency()).toThrow(/positive integer/);
  });

  it('throws on negative', () => {
    setEnv(KEY, '-1');
    expect(() => env.ingestionConcurrency()).toThrow(/positive integer/);
  });

  it('throws on non-integer', () => {
    setEnv(KEY, '4.5');
    expect(() => env.ingestionConcurrency()).toThrow(/positive integer/);
  });
});

describe('env.httpTimeoutMs', () => {
  const KEY = 'HTTP_TIMEOUT_MS';
  let original: string | undefined;
  beforeEach(() => {
    original = process.env[KEY];
  });
  afterEach(() => {
    setEnv(KEY, original);
  });

  it('returns the fallback when unset', () => {
    setEnv(KEY, undefined);
    expect(env.httpTimeoutMs()).toBe(30_000);
  });

  it('throws on bogus input', () => {
    setEnv(KEY, 'soon');
    expect(() => env.httpTimeoutMs()).toThrow(/positive integer/);
  });
});
