-- 0021_softphone_events.sql
--
-- Telemetry from the desktop/Windows softphone: DND toggles, registration, and
-- per-call outcomes. The softphone connects straight to Asterisk for media, so
-- these client-side facts (especially DND, and answered-vs-rejected-vs-missed
-- from the agent's point of view) are not in CDR/CEL. The agent reports them to
-- the backend, which stores them here for the admin Analytics page.
--
-- One row per event. A completed call is a single 'call' row carrying its
-- direction, peer, outcome and duration; DND and registration are their own
-- events, so pairing on/off gives DND periods.

CREATE TABLE IF NOT EXISTS tpbx_softphone_events (
    id           BIGSERIAL PRIMARY KEY,
    extension    VARCHAR(64)  NOT NULL,
    event        VARCHAR(24)  NOT NULL,  -- call | dnd_on | dnd_off | registered | unregistered
    direction    VARCHAR(8)   NOT NULL DEFAULT '', -- in | out (for call)
    peer         VARCHAR(128) NOT NULL DEFAULT '', -- the other party (for call)
    outcome      VARCHAR(16)  NOT NULL DEFAULT '', -- answered | rejected | missed | failed (for call)
    duration_sec INTEGER      NOT NULL DEFAULT 0,  -- talk time in seconds (for call)
    transport    VARCHAR(8)   NOT NULL DEFAULT '', -- wss | tls | tcp | udp
    at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tpbx_softphone_events_ext_at ON tpbx_softphone_events (extension, at);
CREATE INDEX IF NOT EXISTS tpbx_softphone_events_at ON tpbx_softphone_events (at);
CREATE INDEX IF NOT EXISTS tpbx_softphone_events_event_at ON tpbx_softphone_events (event, at);
