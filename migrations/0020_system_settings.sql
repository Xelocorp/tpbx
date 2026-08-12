-- 0020_system_settings.sql
--
-- Global system / branding settings, editable from the console's Settings page
-- (System and Branding tabs) so a deployment can change its public domain,
-- brand name and default theme without editing the env file and reinstalling.
--
-- The public domain in particular used to be install-time only (TPBX_DOMAIN),
-- which made a domain change silently break the WebRTC softphone. It now lives
-- here: the backend prefers this value and falls back to the env only when it
-- is blank, so the env stays a first-boot seed rather than the source of truth.
--
-- A single row (id = 1) holds the whole set; the store seeds it on first read
-- and main() seeds public_domain from TPBX_DOMAIN on first boot when empty.

CREATE TABLE IF NOT EXISTS tpbx_system_settings (
    id            SMALLINT PRIMARY KEY DEFAULT 1,
    public_domain VARCHAR(255) NOT NULL DEFAULT '',
    brand_name    VARCHAR(64)  NOT NULL DEFAULT 'XeloVoice',
    default_theme VARCHAR(8)   NOT NULL DEFAULT 'dark',
    timezone      VARCHAR(64)  NOT NULL DEFAULT 'UTC',
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT tpbx_system_settings_singleton CHECK (id = 1)
);

INSERT INTO tpbx_system_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
