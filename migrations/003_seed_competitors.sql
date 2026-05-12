-- 003_seed_competitors.sql — placeholder per BUILD-PHASES.
--
-- Competitor rows are populated by Simon on first run via the MCP tool
-- `add_competitor(platform, external_id, name, language, priority_tier)`.
-- This file exists to consume the slot in the migration sequence so the
-- numbering stays stable; the migration runner records it as applied and
-- subsequent files run as expected.
SELECT 1;
