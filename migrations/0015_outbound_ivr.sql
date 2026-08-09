-- 0015_outbound_ivr.sql
--
-- Allow an outbound route to deliver a matched call into an IVR menu instead of
-- dialing a trunk. dest_type selects the behaviour ("trunk" keeps the existing
-- Dial-via-trunk; "ivr" sends the caller to the named auto-attendant), and ivr
-- holds the target menu name when dest_type='ivr'. Existing rows default to the
-- trunk behaviour, so nothing changes for current routes.

ALTER TABLE tpbx_outbound_routes ADD COLUMN IF NOT EXISTS dest_type VARCHAR(16) NOT NULL DEFAULT 'trunk';
ALTER TABLE tpbx_outbound_routes ADD COLUMN IF NOT EXISTS ivr       VARCHAR(128) NOT NULL DEFAULT '';
