-- 0014_ext_presence.sql
--
-- Track the last time each extension was seen registered, so the Extensions
-- page can show "last connected" for devices that are currently offline.
--
-- Asterisk deletes an extension's ps_contacts row the moment its registration
-- expires or the device unregisters, so ps_contacts alone can only answer "is
-- it online right now?" -- it has no memory of the past. Every time the API
-- observes a live contact it upserts a row here, giving us a durable
-- last-seen timestamp (plus the address/user-agent last used) that survives the
-- device going away.

CREATE TABLE IF NOT EXISTS tpbx_ext_presence (
    extension  VARCHAR(255) PRIMARY KEY,
    last_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_ip    VARCHAR(64),
    last_port  INTEGER,
    user_agent VARCHAR(255)
);
