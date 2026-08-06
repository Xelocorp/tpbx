-- 0012_rtp_timeout.sql
--
-- When the far party vanishes without a clean BYE (a lost packet on a trunk
-- call, a browser tab killed, a network drop), the other leg can hang in a
-- "still on a call" state. rtp_timeout makes Asterisk hang up a channel after N
-- seconds with no RTP, which sends a BYE to the surviving leg and clears it.
--
-- Stored as text because res_config_pgsql/sorcery reads endpoint options as
-- strings. Applied to endpoints by the provisioning layer.

ALTER TABLE ps_endpoints ADD COLUMN IF NOT EXISTS rtp_timeout      VARCHAR(11);
ALTER TABLE ps_endpoints ADD COLUMN IF NOT EXISTS rtp_timeout_hold VARCHAR(11);
