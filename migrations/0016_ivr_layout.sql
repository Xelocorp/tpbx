-- 0016_ivr_layout.sql
--
-- Persist the visual IVR builder's canvas layout (node positions) alongside the
-- menu. It is opaque JSON owned by the frontend builder; the dialplan is still
-- generated from the options table, so an empty layout just means "no saved
-- canvas yet" and the builder auto-arranges nodes.

ALTER TABLE tpbx_ivrs ADD COLUMN IF NOT EXISTS layout TEXT NOT NULL DEFAULT '';
