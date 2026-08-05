-- 0006_sessions.sql
--
-- GUI login sessions. tpbx_users already exists (migration 0003); this adds the
-- server-side session store so logins can be looked up and revoked. Tokens are
-- opaque random strings kept in an HttpOnly cookie.

CREATE TABLE IF NOT EXISTS tpbx_sessions (
    token      TEXT        PRIMARY KEY,
    username   VARCHAR(64) NOT NULL,
    role       VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS tpbx_sessions_expires_idx ON tpbx_sessions (expires_at);
