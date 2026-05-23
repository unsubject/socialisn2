-- Obs-2 — one-row-per-UTC-day persistence for the 80% cost-alert fire
-- path. The orchestrator calls maybeFireCostAlert(db, push) after every
-- successful assertWithinCeiling; the alert message is pushed exactly
-- once per UTC day. INSERT ... ON CONFLICT (alert_day) DO NOTHING is the
-- single-row guard; pct_at_fire snapshots pctOfCeiling so a later
-- /status surface can show "alerted at 84.3%" without re-reading the
-- ledger.
--
-- alert_day is DATE (not timestamptz). The application supplies
-- `current UTC date` at insert time, matching the dailyTotalUsd()
-- date_trunc('day', NOW(), 'UTC') boundary in src/cost/ledger.ts so the
-- two stay aligned through DST changes.

CREATE TABLE cost_alert_state (
  alert_day   DATE PRIMARY KEY,
  fired_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pct_at_fire NUMERIC(5,4) NOT NULL   -- snapshot of pctOfCeiling at fire time
);
