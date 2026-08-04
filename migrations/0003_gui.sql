-- 0003_gui.sql
--
-- Tables owned entirely by the GUI (prefixed tpbx_ so they never collide with
-- Asterisk's realtime schema). These hold state Asterisk has no concept of:
-- who can log in to the console, and an audit trail of configuration changes.


CREATE TABLE IF NOT EXISTS tpbx_users (
    id            BIGSERIAL PRIMARY KEY,
    username      VARCHAR(64) UNIQUE NOT NULL,
    password_hash TEXT        NOT NULL,          -- bcrypt/argon2 hash
    role          VARCHAR(32) NOT NULL DEFAULT 'operator', -- admin | operator | viewer
    display_name  VARCHAR(128),
    disabled      BOOLEAN     NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
);

-- Append-only record of every change the GUI makes to Asterisk configuration,
-- for accountability and rollback investigation.
CREATE TABLE IF NOT EXISTS tpbx_audit_log (
    id         BIGSERIAL PRIMARY KEY,
    ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
    username   VARCHAR(64),
    action     VARCHAR(64) NOT NULL,   -- e.g. endpoint.create, trunk.update
    object_id  VARCHAR(255),
    detail     JSONB,
    remote_ip  VARCHAR(64)
);

CREATE INDEX IF NOT EXISTS tpbx_audit_ts_idx ON tpbx_audit_log (ts DESC);

