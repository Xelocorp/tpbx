package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ApiTokens manages the bearer tokens that authenticate the machine-to-machine
// /api/v1 surface. Only a SHA-256 hash of each token is stored; the plaintext is
// returned exactly once, at creation.
type ApiTokens struct {
	pool *pgxpool.Pool
}

// NewApiTokens returns an ApiTokens store bound to a connection pool.
func NewApiTokens(pool *pgxpool.Pool) *ApiTokens {
	return &ApiTokens{pool: pool}
}

// ApiToken is the safe (no-secret) representation shown in the UI/API.
type ApiToken struct {
	ID         int64      `json:"id"`
	Name       string     `json:"name"`
	Prefix     string     `json:"prefix"` // first chars, for display
	CreatedBy  string     `json:"createdBy"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt"`
	Revoked    bool       `json:"revoked"`
}

const tokenAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

// newToken returns a 48-char URL-safe random token.
func newToken() string {
	b := make([]byte, 48)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand should never fail; fall back to time-seeded bytes.
		for i := range b {
			b[i] = byte(time.Now().UnixNano() >> (i % 8))
		}
	}
	for i := range b {
		b[i] = tokenAlphabet[int(b[i])%len(tokenAlphabet)]
	}
	return string(b)
}

func hashToken(t string) string {
	sum := sha256.Sum256([]byte(t))
	return hex.EncodeToString(sum[:])
}

// Create generates a new token, stores its hash, and returns the plaintext
// (shown once) alongside the stored metadata.
func (s *ApiTokens) Create(ctx context.Context, name, createdBy string) (string, ApiToken, error) {
	tok := newToken()
	meta := ApiToken{Name: name, Prefix: tok[:8], CreatedBy: createdBy}
	err := s.pool.QueryRow(ctx, `
		INSERT INTO tpbx_api_tokens (name, prefix, token_hash, created_by)
		VALUES ($1,$2,$3,$4)
		RETURNING id, created_at`, name, meta.Prefix, hashToken(tok), createdBy).
		Scan(&meta.ID, &meta.CreatedAt)
	if err != nil {
		return "", ApiToken{}, err
	}
	return tok, meta, nil
}

// List returns all tokens (metadata only, newest first).
func (s *ApiTokens) List(ctx context.Context) ([]ApiToken, error) {
	out := []ApiToken{}
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, prefix, created_by, created_at, last_used_at, revoked
		  FROM tpbx_api_tokens ORDER BY created_at DESC`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var t ApiToken
		if err := rows.Scan(&t.ID, &t.Name, &t.Prefix, &t.CreatedBy, &t.CreatedAt, &t.LastUsedAt, &t.Revoked); err != nil {
			return out, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// Revoke disables a token (permanent; the caller can create a new one).
func (s *ApiTokens) Revoke(ctx context.Context, id int64) error {
	_, err := s.pool.Exec(ctx, `UPDATE tpbx_api_tokens SET revoked=true WHERE id=$1`, id)
	return err
}

// Delete removes a token row entirely.
func (s *ApiTokens) Delete(ctx context.Context, id int64) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM tpbx_api_tokens WHERE id=$1`, id)
	return err
}

// Authenticate validates a plaintext token. On success it returns the token
// metadata and records last-used (best-effort). Revoked tokens fail.
func (s *ApiTokens) Authenticate(ctx context.Context, token string) (ApiToken, bool) {
	if token == "" {
		return ApiToken{}, false
	}
	var t ApiToken
	err := s.pool.QueryRow(ctx, `
		SELECT id, name, prefix, created_by, created_at, last_used_at, revoked
		  FROM tpbx_api_tokens WHERE token_hash=$1`, hashToken(token)).
		Scan(&t.ID, &t.Name, &t.Prefix, &t.CreatedBy, &t.CreatedAt, &t.LastUsedAt, &t.Revoked)
	if err != nil || t.Revoked {
		return ApiToken{}, false
	}
	_, _ = s.pool.Exec(ctx, `UPDATE tpbx_api_tokens SET last_used_at=now() WHERE id=$1`, t.ID)
	return t, true
}
