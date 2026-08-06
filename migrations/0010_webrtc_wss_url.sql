-- 0010_webrtc_wss_url.sql
--
-- Deployments that terminate TLS at a reverse proxy (nginx in front of the PBX)
-- must not point the browser at Asterisk's own :8089 listener (self-signed,
-- and a different path than the proxy exposes). This adds an explicit WSS URL
-- override: when set, the agent /config returns it verbatim instead of deriving
-- wss://<host>:<port>/ws, so the softphone connects through the proxy's
-- trusted certificate.

ALTER TABLE tpbx_webrtc_settings
    ADD COLUMN IF NOT EXISTS wss_url text NOT NULL DEFAULT '';
