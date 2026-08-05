-- 0007_transports.sql
--
-- PJSIP transports are load-time objects: res_pjsip reads them once at module
-- start and they CANNOT live in realtime. The GUI therefore keeps the desired
-- transport set here and generates a static #include file from it
-- (/var/lib/tpbx/pjsip_transports.conf). Bind changes still require a full
-- Asterisk restart to re-bind the sockets, which the console offers explicitly.
--
-- The four rows seeded below mirror the defaults the installer used to ship as
-- a static file, so an upgrade lands on an identical transport set.

CREATE TABLE IF NOT EXISTS tpbx_transports (
    name                       text PRIMARY KEY,
    protocol                   text    NOT NULL DEFAULT 'udp',   -- udp | tcp | tls | wss
    bind_addr                  text    NOT NULL DEFAULT '0.0.0.0',
    bind_port                  integer NOT NULL DEFAULT 5060,
    tls_cert_file              text    NOT NULL DEFAULT '',
    tls_priv_key_file          text    NOT NULL DEFAULT '',
    tls_ca_list_file           text    NOT NULL DEFAULT '',
    tls_method                 text    NOT NULL DEFAULT 'tlsv1_2',
    external_media_address     text    NOT NULL DEFAULT '',
    external_signaling_address text    NOT NULL DEFAULT '',
    local_net                  text    NOT NULL DEFAULT '',       -- comma-separated CIDRs
    enabled                    boolean NOT NULL DEFAULT true,
    position                   integer NOT NULL DEFAULT 0
);

INSERT INTO tpbx_transports
    (name, protocol, bind_addr, bind_port, tls_cert_file, tls_priv_key_file, tls_method, position)
VALUES
    ('transport-udp', 'udp', '0.0.0.0', 5060, '', '', 'tlsv1_2', 1),
    ('transport-tcp', 'tcp', '0.0.0.0', 5060, '', '', 'tlsv1_2', 2),
    ('transport-tls', 'tls', '0.0.0.0', 5061,
        '/etc/asterisk/keys/tpbx.crt', '/etc/asterisk/keys/tpbx.key', 'tlsv1_2', 3),
    ('transport-wss', 'wss', '0.0.0.0', 0, '', '', 'tlsv1_2', 4)
ON CONFLICT (name) DO NOTHING;
