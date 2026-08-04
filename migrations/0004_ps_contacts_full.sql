-- 0004_ps_contacts_full.sql
--
-- Complete the ps_contacts schema. Asterisk WRITES a dynamic contact row on
-- every REGISTER, and the INSERT lists every contact column it knows about:
--
--   id, uri, expiration_time, qualify_frequency, outbound_proxy, path,
--   user_agent, qualify_timeout, reg_server, authenticate_qualify, via_addr,
--   via_port, call_id, endpoint, prune_on_boot
--
-- If any of those columns is missing, the whole INSERT fails
-- ("column ... does not exist") and the contact cannot bind to its AOR --
-- the phone appears permanently Unavailable. Migration 0001 shipped a subset;
-- add the remaining columns so registration succeeds.

ALTER TABLE ps_contacts ADD COLUMN IF NOT EXISTS path                 TEXT;
ALTER TABLE ps_contacts ADD COLUMN IF NOT EXISTS qualify_timeout      DOUBLE PRECISION;
ALTER TABLE ps_contacts ADD COLUMN IF NOT EXISTS authenticate_qualify VARCHAR(5);
ALTER TABLE ps_contacts ADD COLUMN IF NOT EXISTS prune_on_boot        VARCHAR(5);
