-- 0005_routes.sql
--
-- Call routing, owned by the GUI (tpbx_ prefix). Unlike PJSIP objects these are
-- NOT read by Asterisk from realtime -- the backend compiles them into a
-- generated dialplan file (/var/lib/tpbx/extensions_tpbx.conf) that Asterisk
-- #includes, and reloads the dialplan after any change.

CREATE TABLE IF NOT EXISTS tpbx_outbound_routes (
    id         BIGSERIAL PRIMARY KEY,
    name       VARCHAR(64)  NOT NULL,
    pattern    VARCHAR(64)  NOT NULL,           -- Asterisk pattern, e.g. _9. or _NXXXXXXXXXX
    trunk      VARCHAR(255) NOT NULL,           -- ps_endpoints.id of the trunk to use
    strip      INTEGER      NOT NULL DEFAULT 0, -- leading digits to strip from dialed number
    prepend    VARCHAR(32)  NOT NULL DEFAULT '',-- digits to prepend after stripping
    caller_id  VARCHAR(64)  NOT NULL DEFAULT '',-- override outbound caller id (optional)
    position   INTEGER      NOT NULL DEFAULT 100, -- lower = evaluated first
    enabled    BOOLEAN      NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tpbx_inbound_routes (
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(64)  NOT NULL,
    did         VARCHAR(64)  NOT NULL,          -- matched exten in from-trunk (DID); use _. for any
    destination VARCHAR(64)  NOT NULL,          -- extension number to ring
    enabled     BOOLEAN      NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
