// Single-user allow gate: both branches (allowed vs rejected) plus the
// id-takes-precedence-over-login rule and fail-closed when nothing is set.
// This is the pure decision that /callback/github maps to mint-token vs 403.

import { describe, expect, it } from 'vitest';
import { isAllowedUser, type GithubUser } from '../src/github';

const allowedUser: GithubUser = { id: 4242, login: 'simoncf', name: 'Simon Lee' };
const otherUser: GithubUser = { id: 9999, login: 'attacker', name: 'Mallory' };

describe('isAllowedUser', () => {
  it('accepts the allowed user by numeric id (id takes precedence)', () => {
    expect(isAllowedUser(allowedUser, { id: '4242', login: 'someoneelse' })).toBe(true);
  });

  it('rejects a non-allowed user even with a matching login when id is set', () => {
    // login matches but id does not → rejected (id wins, mutable login ignored).
    const impostor: GithubUser = { id: 1, login: 'simoncf', name: 'x' };
    expect(isAllowedUser(impostor, { id: '4242', login: 'simoncf' })).toBe(false);
  });

  it('falls back to case-insensitive login match when id is not configured', () => {
    expect(isAllowedUser(allowedUser, { id: undefined, login: 'SimonCF' })).toBe(true);
    expect(isAllowedUser(otherUser, { id: undefined, login: 'simoncf' })).toBe(false);
  });

  it('fails closed when neither id nor login is configured', () => {
    expect(isAllowedUser(allowedUser, { id: undefined, login: undefined })).toBe(false);
    expect(isAllowedUser(allowedUser, { id: '', login: '  ' })).toBe(false);
  });

  it('rejects the non-allowed user (403 branch)', () => {
    expect(isAllowedUser(otherUser, { id: '4242', login: 'simoncf' })).toBe(false);
  });
});
