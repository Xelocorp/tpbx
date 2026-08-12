-- 0019_pjsip_settings.sql
--
-- Global PJSIP / TLS settings (the "Misc PJSip Settings" and "TLS/SSL/SRTP
-- Settings" panels). These are the res_pjsip [global] and [system] options plus
-- the TLS defaults applied to TLS transports. They cannot live in realtime, so
-- like transports they are compiled into a generated #include file.
--
-- A single row (id = 1) holds the whole set; the store seeds it on first read.

CREATE TABLE IF NOT EXISTS tpbx_pjsip_settings (
    id                             SMALLINT PRIMARY KEY DEFAULT 1,
    allow_transports_reload        BOOLEAN     NOT NULL DEFAULT false,
    enable_debug                   BOOLEAN     NOT NULL DEFAULT false,
    keep_alive_interval            INTEGER     NOT NULL DEFAULT 90,
    contact_caller_id              BOOLEAN     NOT NULL DEFAULT false,
    taskprocessor_overload_trigger VARCHAR(16) NOT NULL DEFAULT 'pjsip_only',
    endpoint_identifier_order      VARCHAR(128) NOT NULL DEFAULT 'ip,username,anonymous',
    -- TLS/SSL/SRTP defaults for TLS transports.
    cert_name                      VARCHAR(128) NOT NULL DEFAULT '',
    tls_method                     VARCHAR(16) NOT NULL DEFAULT 'tlsv1_2',
    verify_client                  BOOLEAN     NOT NULL DEFAULT false,
    verify_server                  BOOLEAN     NOT NULL DEFAULT false,
    CONSTRAINT tpbx_pjsip_settings_singleton CHECK (id = 1)
);

INSERT INTO tpbx_pjsip_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
