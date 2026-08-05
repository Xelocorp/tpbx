-- 0009_webrtc_settings.sql
--
-- WebRTC/TURN parameters vary per deployment (LAN Proxmox, public VPS, Oracle
-- behind 1:1 NAT, external TURN provider), so they must be configurable at
-- runtime from the dashboard rather than baked into install.sh. This single-row
-- table holds the admin-editable settings; the agent /config endpoint reads it
-- and falls back to derive-from-request when a field is blank.
--
-- The built-in coturn shared secret is NOT stored here -- it stays an install
-- secret in the env file. "builtin" TURN mode uses it server-side; "static"
-- mode uses the username/password entered below for an external TURN service.

CREATE TABLE IF NOT EXISTS tpbx_webrtc_settings (
    id                   smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    public_host          text    NOT NULL DEFAULT '',   -- '' = derive from request host
    wss_port             text    NOT NULL DEFAULT '8089',
    stun_enabled         boolean NOT NULL DEFAULT true,
    turn_enabled         boolean NOT NULL DEFAULT true,
    turn_mode            text    NOT NULL DEFAULT 'builtin', -- builtin | static | none
    turn_host            text    NOT NULL DEFAULT '',   -- '' = same as public_host
    turn_urls            text    NOT NULL DEFAULT '',   -- explicit comma-separated URLs (static)
    turn_static_user     text    NOT NULL DEFAULT '',
    turn_static_password text    NOT NULL DEFAULT '',
    turn_tls             boolean NOT NULL DEFAULT true, -- also offer turns:5349
    ice_transport_policy text    NOT NULL DEFAULT 'all', -- all | relay
    updated_at           timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tpbx_webrtc_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
