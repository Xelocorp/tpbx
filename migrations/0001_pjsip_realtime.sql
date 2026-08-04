-- 0001_pjsip_realtime.sql
--
-- PJSIP realtime (sorcery) schema for Asterisk.
--
-- These tables back res_pjsip when Asterisk is configured to read PJSIP objects
-- from the database (see asterisk/sorcery.conf and asterisk/extconfig.conf).
-- The GUI performs CRUD against these tables and Asterisk picks the changes up
-- on the next `pjsip reload` (or immediately for objects that support it).
--
-- Column sets are a practical subset of Asterisk's upstream alembic schema
-- (contrib/ast-db-manage/config). yes/no fields are stored as VARCHAR because
-- res_config_odbc reads them as plain strings. Add columns as features need
-- them -- extra columns Asterisk does not know about are simply ignored.
--
-- NOTE: PJSIP *transports* are deliberately NOT stored here. Transports are
-- loaded once at module start and are managed by the GUI as a static include
-- file (asterisk/pjsip_transports.conf). See docs/ARCHITECTURE.md.


-- Address of Record: where an endpoint can be reached / how it registers.
CREATE TABLE IF NOT EXISTS ps_aors (
    id                     VARCHAR(255) PRIMARY KEY,
    contact                VARCHAR(255),
    default_expiration     INTEGER,
    mailboxes              VARCHAR(255),
    max_contacts           INTEGER,
    minimum_expiration     INTEGER,
    remove_existing        VARCHAR(5),
    qualify_frequency      INTEGER,
    authenticate_qualify   VARCHAR(5),
    maximum_expiration     INTEGER,
    outbound_proxy         VARCHAR(255),
    support_path           VARCHAR(5)
);

-- Authentication objects (username/password used by endpoints and trunks).
CREATE TABLE IF NOT EXISTS ps_auths (
    id                 VARCHAR(255) PRIMARY KEY,
    auth_type          VARCHAR(16),         -- userpass | md5
    nonce_lifetime     INTEGER,
    md5_cred           VARCHAR(40),
    password           VARCHAR(255),
    realm              VARCHAR(255),
    username           VARCHAR(255)
);

-- Endpoints: the core object for an extension, a device, or a trunk side.
CREATE TABLE IF NOT EXISTS ps_endpoints (
    id                        VARCHAR(255) PRIMARY KEY,
    transport                 VARCHAR(40),
    aors                      VARCHAR(255),
    auth                      VARCHAR(255),
    context                   VARCHAR(40),
    disallow                  VARCHAR(200),
    allow                     VARCHAR(200),
    direct_media              VARCHAR(5),
    mailboxes                 VARCHAR(40),
    outbound_auth             VARCHAR(255),
    callerid                  VARCHAR(255),
    from_user                 VARCHAR(255),
    from_domain               VARCHAR(255),
    dtmf_mode                 VARCHAR(16),   -- rfc4733 | inband | info | auto
    rtp_symmetric             VARCHAR(5),
    force_rport               VARCHAR(5),
    rewrite_contact           VARCHAR(5),
    ice_support               VARCHAR(5),    -- required for WebRTC
    use_avpf                  VARCHAR(5),    -- required for WebRTC
    media_encryption          VARCHAR(16),   -- no | sdes | dtls
    dtls_verify               VARCHAR(16),
    dtls_cert_file            VARCHAR(255),
    dtls_private_key          VARCHAR(255),
    dtls_setup                VARCHAR(16),
    webrtc                    VARCHAR(5),    -- yes => sets ICE/DTLS/AVPF/rtcp-mux
    media_use_received_transport VARCHAR(5),
    rtcp_mux                  VARCHAR(5),
    context_out               VARCHAR(40)
);

-- Identify: match inbound traffic (e.g. from a trunk) to an endpoint by IP.
CREATE TABLE IF NOT EXISTS ps_endpoint_id_ips (
    id           VARCHAR(255) PRIMARY KEY,
    endpoint     VARCHAR(255),
    match        VARCHAR(80),
    srv_lookups  VARCHAR(5),
    match_header VARCHAR(255)
);

-- Outbound registrations (e.g. registering to an ITSP trunk).
CREATE TABLE IF NOT EXISTS ps_registrations (
    id                       VARCHAR(255) PRIMARY KEY,
    transport                VARCHAR(40),
    outbound_auth            VARCHAR(255),
    server_uri               VARCHAR(255),
    client_uri               VARCHAR(255),
    contact_user             VARCHAR(255),
    retry_interval           INTEGER,
    max_retries              INTEGER,
    expiration               INTEGER,
    line                     VARCHAR(5),
    endpoint                 VARCHAR(255)
);

-- Dynamic contacts: Asterisk WRITES these when endpoints register. The GUI
-- reads them to show live registration state alongside AMI events.
CREATE TABLE IF NOT EXISTS ps_contacts (
    id                  VARCHAR(255) PRIMARY KEY,
    uri                 VARCHAR(255),
    expiration_time     BIGINT,
    qualify_frequency   INTEGER,
    outbound_proxy      VARCHAR(255),
    user_agent          VARCHAR(255),
    endpoint            VARCHAR(255),
    reg_server          VARCHAR(255),
    via_addr            VARCHAR(40),
    via_port            INTEGER,
    call_id             VARCHAR(255)
);

