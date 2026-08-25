-- Outbound webhooks for the /api/v1 event bus. XeloVoice POSTs a JSON event to
-- each enabled endpoint, signed with an HMAC-SHA256 of the raw body under the
-- per-hook secret (header X-XeloVoice-Signature: sha256=<hex>). The `events`
-- column is a CSV filter ("" or "*" = all event types). Delivery outcome of the
-- most recent attempt is recorded for the console. See internal/events.
CREATE TABLE IF NOT EXISTS tpbx_webhooks (
    id               BIGSERIAL PRIMARY KEY,
    url              TEXT        NOT NULL,
    secret           TEXT        NOT NULL,
    events           TEXT        NOT NULL DEFAULT '',
    enabled          BOOLEAN     NOT NULL DEFAULT true,
    created_by       TEXT        NOT NULL DEFAULT '',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_status      INTEGER     NOT NULL DEFAULT 0,
    last_error       TEXT        NOT NULL DEFAULT '',
    last_delivery_at TIMESTAMPTZ
);
