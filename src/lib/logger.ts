// Structured JSON logger. Hand-rolled (no deps) for parity with the rest
// of the codebase. Emits one JSON object per line, suitable for journalctl
// + future stdout-shipping. Fields:
//
//   ts        — ISO-8601 timestamp
//   level     — 'debug' | 'info' | 'warn' | 'error'
//   component — caller-supplied tag (e.g. 'ingestion-worker', 'app')
//   msg       — short message
//   ...       — arbitrary fields passed at the call site, merged shallow
//
// Stdout vs stderr split:
//   debug, info → stdout
//   warn, error → stderr
//
// Level filter via LOG_LEVEL env (default 'info'). Setting LOG_LEVEL=debug
// re-enables debug lines in prod for a tail; default keeps debug muted.

import process from 'node:process';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function currentLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return 'info';
}

export interface LogFields {
  [key: string]: unknown;
}

function emit(
  level: LogLevel,
  component: string,
  msg: string,
  fields?: LogFields,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;
  const record: LogFields = {
    ts: new Date().toISOString(),
    level,
    component,
    msg,
    ...fields,
  };
  const line = JSON.stringify(record) + '\n';
  if (level === 'warn' || level === 'error') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

export interface Logger {
  debug: (msg: string, fields?: LogFields) => void;
  info: (msg: string, fields?: LogFields) => void;
  warn: (msg: string, fields?: LogFields) => void;
  error: (msg: string, fields?: LogFields) => void;
  /**
   * Return a logger that always merges the given fields into emitted records.
   * Useful for binding a run_id / correlation_id once at scope entry.
   */
  child: (extraFields: LogFields) => Logger;
}

export function createLogger(component: string, baseFields: LogFields = {}): Logger {
  const wrap =
    (level: LogLevel) =>
    (msg: string, fields?: LogFields): void =>
      emit(level, component, msg, { ...baseFields, ...fields });
  return {
    debug: wrap('debug'),
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error'),
    child: (extra) => createLogger(component, { ...baseFields, ...extra }),
  };
}
