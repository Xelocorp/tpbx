-- Service-level threshold (seconds) for the call-center dashboard: a call is
-- "within service level" if it was answered in <= this many seconds. Global,
-- admin-editable on the System settings tab. Default 20s (industry common).
ALTER TABLE tpbx_system_settings
    ADD COLUMN IF NOT EXISTS sla_seconds INTEGER NOT NULL DEFAULT 20;
