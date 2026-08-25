-- Tenants (organizations) for multi-tenant API scoping. A tenant owns a set of
-- extensions identified by number prefixes (CSV, e.g. "20,21" => 20xx and 21xx)
-- and, optionally, a set of ACD queues. An API token or webhook may be bound to
-- a tenant; when it is, the /api/v1 surface only lists/controls that tenant's
-- resources and only its events are delivered. A NULL tenant = global (full)
-- access, so existing tokens keep working unchanged. See internal/store/tenants.go.
CREATE TABLE IF NOT EXISTS tpbx_tenants (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT        NOT NULL,
    slug         TEXT        NOT NULL,
    ext_prefixes TEXT        NOT NULL DEFAULT '',
    queues       TEXT        NOT NULL DEFAULT '',
    created_by   TEXT        NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tpbx_tenants_slug_idx ON tpbx_tenants (slug);

ALTER TABLE tpbx_api_tokens ADD COLUMN IF NOT EXISTS tenant_id BIGINT REFERENCES tpbx_tenants (id) ON DELETE SET NULL;
ALTER TABLE tpbx_webhooks   ADD COLUMN IF NOT EXISTS tenant_id BIGINT REFERENCES tpbx_tenants (id) ON DELETE SET NULL;
