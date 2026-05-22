// Unit test for src/lib/logger.ts. No DB. Spies on
// process.stdout.write / process.stderr.write to capture emitted lines.

import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '../../src/lib/logger.js';

interface CapturedLine {
  stream: 'stdout' | 'stderr';
  record: Record<string, unknown>;
}

function spyStreams(): {
  lines: CapturedLine[];
  restore: () => void;
} {
  const lines: CapturedLine[] = [];
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      for (const raw of s.split('\n').filter(Boolean)) {
        lines.push({ stream: 'stdout', record: JSON.parse(raw) });
      }
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      for (const raw of s.split('\n').filter(Boolean)) {
        lines.push({ stream: 'stderr', record: JSON.parse(raw) });
      }
      return true;
    });
  return {
    lines,
    restore: () => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  };
}

describe('createLogger', () => {
  let originalLevel: string | undefined;

  beforeEach(() => {
    originalLevel = process.env.LOG_LEVEL;
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    if (originalLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLevel;
  });

  it('emits info and debug to stdout (when level allows), warn/error to stderr', () => {
    process.env.LOG_LEVEL = 'debug';
    const cap = spyStreams();
    try {
      const log = createLogger('test');
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');
    } finally {
      cap.restore();
    }
    expect(cap.lines.map((l) => `${l.stream}:${l.record.msg}`)).toEqual([
      'stdout:d',
      'stdout:i',
      'stderr:w',
      'stderr:e',
    ]);
  });

  it('records carry ts / level / component / msg', () => {
    const cap = spyStreams();
    try {
      createLogger('alpha').info('hello');
    } finally {
      cap.restore();
    }
    expect(cap.lines).toHaveLength(1);
    const rec = cap.lines[0]!.record;
    expect(rec.level).toBe('info');
    expect(rec.component).toBe('alpha');
    expect(rec.msg).toBe('hello');
    expect(typeof rec.ts).toBe('string');
    expect(() => new Date(rec.ts as string).toISOString()).not.toThrow();
  });

  it('merges call-site fields into the record (shallow)', () => {
    const cap = spyStreams();
    try {
      createLogger('alpha').info('m', { run_id: 'r1', count: 7 });
    } finally {
      cap.restore();
    }
    const rec = cap.lines[0]!.record;
    expect(rec.run_id).toBe('r1');
    expect(rec.count).toBe(7);
  });

  it('filters debug when LOG_LEVEL=info (default)', () => {
    const cap = spyStreams();
    try {
      const log = createLogger('alpha');
      log.debug('hidden');
      log.info('shown');
    } finally {
      cap.restore();
    }
    expect(cap.lines.map((l) => l.record.msg)).toEqual(['shown']);
  });

  it('filters info when LOG_LEVEL=warn', () => {
    process.env.LOG_LEVEL = 'warn';
    const cap = spyStreams();
    try {
      const log = createLogger('alpha');
      log.info('hidden');
      log.warn('shown');
      log.error('also-shown');
    } finally {
      cap.restore();
    }
    expect(cap.lines.map((l) => l.record.msg)).toEqual(['shown', 'also-shown']);
  });

  it('falls back to info when LOG_LEVEL is unknown', () => {
    process.env.LOG_LEVEL = 'nonsense';
    const cap = spyStreams();
    try {
      const log = createLogger('alpha');
      log.debug('hidden');
      log.info('shown');
    } finally {
      cap.restore();
    }
    expect(cap.lines.map((l) => l.record.msg)).toEqual(['shown']);
  });

  it('child() binds extra fields into every emitted record', () => {
    const cap = spyStreams();
    try {
      const log = createLogger('alpha').child({ run_id: 'r99' });
      log.info('a');
      log.info('b', { extra: 'x' });
    } finally {
      cap.restore();
    }
    expect(cap.lines.map((l) => l.record)).toEqual([
      expect.objectContaining({ msg: 'a', run_id: 'r99' }),
      expect.objectContaining({ msg: 'b', run_id: 'r99', extra: 'x' }),
    ]);
  });

  it('call-site fields override child-bound fields with the same key', () => {
    const cap = spyStreams();
    try {
      createLogger('alpha').child({ run_id: 'r99' }).info('m', { run_id: 'r-override' });
    } finally {
      cap.restore();
    }
    expect(cap.lines[0]!.record.run_id).toBe('r-override');
  });
});
