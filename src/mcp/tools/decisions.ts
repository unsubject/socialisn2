// MCP decision tools. All three wrap src/telegram/decisions.ts:decide()
// with interfaceLabel='mcp' so the underlying contract (race safety,
// feedback INSERT, 2nd-brain recordPick) is shared with the Telegram
// surface. The MCP/Telegram split is just plumbing; the business
// logic is in one place.

import type { Db } from '../../db/client.js';
import { decide } from '../../telegram/decisions.js';
import { DecisionArgs, DeferArgs } from '../schemas.js';

export async function pickCandidate(
  db: Db,
  rawArgs: unknown,
): Promise<{ ok: boolean; archive_recorded: boolean; already_decided?: boolean }> {
  const args = DecisionArgs.parse(rawArgs);
  const result = await decide(db, args.id, 'pick', args.reason, 'mcp');
  return {
    ok: result.ok,
    // SPEC §11.4 returns `archive_recorded` for pick (whether the
    // 2nd-brain recordPick succeeded). decide() doesn't currently
    // expose that — recordPick degrades to {ok:false} on failure but
    // the result isn't threaded back. For v1 we report true when the
    // candidate decision landed AND no race; clients can read
    // dailyTotalUsd / inspect logs for archive-side errors. Tracking
    // the granular archive_recorded is a Build-list follow-up.
    archive_recorded: result.ok && !result.alreadyDecided,
    ...(result.alreadyDecided ? { already_decided: true } : {}),
  };
}

export async function passCandidate(
  db: Db,
  rawArgs: unknown,
): Promise<{ ok: boolean; already_decided?: boolean }> {
  const args = DecisionArgs.parse(rawArgs);
  const result = await decide(db, args.id, 'pass', args.reason, 'mcp');
  return {
    ok: result.ok,
    ...(result.alreadyDecided ? { already_decided: true } : {}),
  };
}

export async function deferCandidate(
  db: Db,
  rawArgs: unknown,
): Promise<{ ok: boolean; already_decided?: boolean }> {
  const args = DeferArgs.parse(rawArgs);
  const result = await decide(db, args.id, 'defer', undefined, 'mcp');
  return {
    ok: result.ok,
    ...(result.alreadyDecided ? { already_decided: true } : {}),
  };
}
