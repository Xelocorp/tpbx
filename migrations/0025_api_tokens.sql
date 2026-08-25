-- API tokens for the machine-to-machine /api/v1 surface. The plaintext token is
-- shown once at creation; only its SHA-256 hash is stored. A short prefix is
-- kept for display ("dy7Adq8S…"). Tokens can be named, revoked, and their last
-- use is tracked. See internal/api/apiv1.go.
CREATE TABLE IF NOT EXISTS tpbx_api_tokens (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT        NOT NULL DEFAULT '',
    prefix       TEXT        NOT NULL,
    token_hash   TEXT        NOT NULL,
    created_by   TEXT        NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked      BOOLEAN     NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX IF NOT EXISTS tpbx_api_tokens_hash_idx ON tpbx_api_tokens (token_hash);
