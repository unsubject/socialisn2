-- 008_disable_anthropic_email_bridge.sql
--
-- The PR #1 source-catalogue research flagged "Anthropic newsletter"
-- as an unverified assumption ("anthropic.com may only have product /
-- safety updates"). Empirical confirmation on 2026-05-14 — Simon
-- could not find a public email-signup form for Anthropic news, only
-- the website news listing. There's currently no path for inbox@
-- subscription, so the row would just sit dormant in the bridge
-- consuming a feed slot.
--
-- Disable rather than DELETE so the row + slug is reserved if
-- Anthropic later launches a public newsletter. Re-enable via
-- `UPDATE sources SET enabled = true WHERE …` if/when that happens.

UPDATE sources
   SET enabled    = false,
       updated_at = NOW()
 WHERE kind = 'email_bridge'
   AND name = 'Anthropic news';
