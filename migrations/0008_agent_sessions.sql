-- 0008_agent_sessions.sql
--
-- The agent softphone is a separate app: agents authenticate with their SIP
-- extension + secret (verified against the PJSIP realtime auth table), not with
-- a GUI user account. Their sessions therefore live in their own table rather
-- than tpbx_sessions (which is keyed on tpbx_users).
--
-- A session gates the endpoints that hand out short-lived TURN credentials and
-- the SIP connection parameters the browser needs to register.

CREATE TABLE IF NOT EXISTS tpbx_agent_sessions (
    token      text PRIMARY KEY,
    extension  text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS tpbx_agent_sessions_expiry ON tpbx_agent_sessions (expires_at);
