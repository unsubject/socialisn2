// Strict 8-4-4-4-12 hex UUID matcher used as a pre-filter on user-
// supplied id strings (Fastify `/c/:id` route, /cand command,
// /pick|/pass|/defer commands, callback-query data). Rejects anything
// PG's UUID cast would also reject — keeps a PG "invalid input syntax
// for type uuid" error from surfacing as a 500 / unhandled bot error.
//
// Centralised here so the four call sites don't drift; lower-case 'a-f'
// matches what `uuidv7()` emits, but accepts upper-case too in case a
// user pastes a UUID copied from somewhere case-mangled.

export const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Convenience predicate. Same semantics as `UUID_RE.test(id)`. */
export function isUuid(id: string): boolean {
  return UUID_RE.test(id);
}
