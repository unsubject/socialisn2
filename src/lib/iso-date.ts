// Strict YYYY-MM-DD validation (codex review on PR #157): a regex
// shape-check alone lets '2026-13-99' through to a PG `::date` cast,
// which raises an out-of-range error → surfaces as a 500 instead of
// the intended 404 / validation error. JS's ISO parser is strict about
// out-of-range components (no rollover), so parse + round-trip is a
// complete validity check.

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
