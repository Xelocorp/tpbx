-- 0022_call_dispositions.sql
--
-- Call disposition captured by the softphone's post-call wrap-up: what the call
-- was about (nature), whether it was resolved, why it ended (hangup cause), and
-- a free-text note. These power the Nature-of-Calls, Hangup-Causes and
-- Resolution-Rate panels of the analytics dashboard, which cannot be derived
-- from CDR alone. They hang off the existing 'call' telemetry row.

ALTER TABLE tpbx_softphone_events
    ADD COLUMN IF NOT EXISTS nature       VARCHAR(24) NOT NULL DEFAULT '', -- technical | billing | sales | other
    ADD COLUMN IF NOT EXISTS resolution   VARCHAR(16) NOT NULL DEFAULT '', -- resolved | unresolved
    ADD COLUMN IF NOT EXISTS hangup_cause VARCHAR(24) NOT NULL DEFAULT '', -- user_frustration | technical_drop | other
    ADD COLUMN IF NOT EXISTS note         TEXT        NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS tpbx_softphone_events_nature_at
    ON tpbx_softphone_events (nature, at) WHERE event = 'call';
