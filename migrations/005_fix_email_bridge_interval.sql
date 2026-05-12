-- 005_fix_email_bridge_interval.sql — correct editorial email-bridge cadence.
--
-- SPEC §7.1 specifies email-bridge feeds run every 30 minutes ("cheap call,
-- near-instant detection of new newsletter arrivals"). 004_seed_email_bridges
-- inserted them at 60 by mistake. This UPDATE corrects the editorial bridges
-- (§6.9 newsletters + §6.1 / §6.2 outlets bridged via §6.9) while leaving
-- §6.4 academic digests at 1440 (their per-§7.1 daily cadence).

UPDATE sources
SET fetch_interval_min = 30
WHERE kind = 'email_bridge'
  AND fetch_interval_min = 60;
