-- 0013_ivr.sql
--
-- IVR (auto-attendant) menus. Like routing, IVRs are not realtime objects; they
-- are compiled into generated dialplan contexts (tpbx-ivr-<name>) that Asterisk
-- #includes. An inbound route can send a DID to an IVR (destination "ivr:name"),
-- and IVR keys can dial an extension, jump to another IVR, or hang up.

CREATE TABLE IF NOT EXISTS tpbx_ivrs (
    id           BIGSERIAL PRIMARY KEY,
    name         text UNIQUE NOT NULL,          -- identifier -> context tpbx-ivr-<name>
    greeting     text    NOT NULL DEFAULT '',   -- sound file, e.g. custom/welcome
    timeout_sec  integer NOT NULL DEFAULT 5,    -- WaitExten seconds
    max_retries  integer NOT NULL DEFAULT 3,    -- replays before giving up
    invalid_dest text    NOT NULL DEFAULT '',   -- fallback destination (type:value) or ''
    timeout_dest text    NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tpbx_ivr_options (
    id         BIGSERIAL PRIMARY KEY,
    ivr_id     bigint  NOT NULL REFERENCES tpbx_ivrs(id) ON DELETE CASCADE,
    digit      text    NOT NULL,                 -- 0-9 * #
    dest_type  text    NOT NULL DEFAULT 'extension', -- extension | ivr | hangup
    dest_value text    NOT NULL DEFAULT '',
    label      text    NOT NULL DEFAULT '',
    position   integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tpbx_ivr_options_ivr ON tpbx_ivr_options (ivr_id);
