-- 0003_unmatched_raw_headers.sql — capture transport-provider context.
--
-- When a publisher delegates delivery to Mailchimp / Amazon SES /
-- SendGrid / etc., the From: header is the transport, not the
-- publisher. The actual publisher identity lives in List-Post,
-- List-Unsubscribe, Reply-To, Sender, or Feedback-ID. The current
-- unmatched schema only stores list_id / from_addr / subject, so the
-- classifier can't see those signals.
--
-- Add a single JSON column rather than one column per header — keeps
-- the schema stable as we extend the set, and the classifier reads
-- it via JSON parse on the application side.

ALTER TABLE unmatched ADD COLUMN raw_headers TEXT;
