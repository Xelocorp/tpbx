-- 0011_webrtc_stun_urls.sql
--
-- Allow explicit STUN server URLs (e.g. an external fallback like Google's
-- public STUN) instead of only deriving stun:<host>:3478. Without this, admins
-- put a full "host:port" STUN address into the host field, which the deriver
-- then double-ported into an invalid URL (stun:host:19302:3478).

ALTER TABLE tpbx_webrtc_settings
    ADD COLUMN IF NOT EXISTS stun_urls text NOT NULL DEFAULT '';
