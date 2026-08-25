package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Webhooks manages the outbound webhook endpoints the /api/v1 event bus delivers
// to. Each hook has its own signing secret; XeloVoice signs every delivery with
// an HMAC-SHA256 of the body so the receiver can verify authenticity.
type Webhooks struct {
	pool *pgxpool.Pool
}

// NewWebhooks returns a Webhooks store bound to a connection pool.
func NewWebhooks(pool *pgxpool.Pool) *Webhooks {
	return &Webhooks{pool: pool}
}

// Webhook is one registered endpoint.
type Webhook struct {
	ID         int64      `json:"id"`
	URL        string     `json:"url"`
	Secret     string     `json:"secret,omitempty"` // returned on create; omitted from lists
	Events     string     `json:"events"`           // CSV filter; "" or "*" = all
	Enabled    bool       `json:"enabled"`
	CreatedBy  string     `json:"createdBy"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastStatus int        `json:"lastStatus"`
	LastError  string     `json:"lastError"`
	LastAt     *time.Time `json:"lastDeliveryAt"`
	TenantID   *int64     `json:"tenantId"`             // nil = all events (global)
	TenantName string     `json:"tenantName,omitempty"` // joined, for display

	// TenantPrefixes is the tenant's CSV extension prefixes, populated only for
	// delivery (EnabledWithSecret) so the bus can filter events by tenant.
	TenantPrefixes string `json:"-"`
}

func newSecret() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		for i := range b {
			b[i] = byte(time.Now().UnixNano() >> (i % 8))
		}
	}
	return "whsec_" + hex.EncodeToString(b)
}

// Create registers a webhook, generating a signing secret. tenantID scopes the
// hook so it only receives one organization's events; nil = all events.
func (s *Webhooks) Create(ctx context.Context, url, events, createdBy string, tenantID *int64) (Webhook, error) {
	wh := Webhook{URL: url, Events: events, Secret: newSecret(), Enabled: true, CreatedBy: createdBy, TenantID: tenantID}
	err := s.pool.QueryRow(ctx, `
		INSERT INTO tpbx_webhooks (url, secret, events, created_by, tenant_id)
		VALUES ($1,$2,$3,$4,$5)
		RETURNING id, created_at, enabled`, url, wh.Secret, events, createdBy, tenantID).
		Scan(&wh.ID, &wh.CreatedAt, &wh.Enabled)
	if err != nil {
		return Webhook{}, err
	}
	return wh, nil
}

// List returns all webhooks (secret omitted), with tenant names.
func (s *Webhooks) List(ctx context.Context) ([]Webhook, error) {
	out := []Webhook{}
	rows, err := s.pool.Query(ctx, `
		SELECT w.id, w.url, w.events, w.enabled, w.created_by, w.created_at,
		       w.last_status, w.last_error, w.last_delivery_at, w.tenant_id, COALESCE(t.name,'')
		  FROM tpbx_webhooks w
		  LEFT JOIN tpbx_tenants t ON t.id = w.tenant_id
		 ORDER BY w.created_at DESC`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var w Webhook
		if err := rows.Scan(&w.ID, &w.URL, &w.Events, &w.Enabled, &w.CreatedBy, &w.CreatedAt,
			&w.LastStatus, &w.LastError, &w.LastAt, &w.TenantID, &w.TenantName); err != nil {
			return out, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// EnabledWithSecret returns all enabled webhooks WITH their secrets and the
// tenant's extension prefixes, for delivery + tenant filtering.
func (s *Webhooks) EnabledWithSecret(ctx context.Context) ([]Webhook, error) {
	out := []Webhook{}
	rows, err := s.pool.Query(ctx, `
		SELECT w.id, w.url, w.secret, w.events, w.tenant_id, COALESCE(t.ext_prefixes,'')
		  FROM tpbx_webhooks w
		  LEFT JOIN tpbx_tenants t ON t.id = w.tenant_id
		 WHERE w.enabled = true`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var w Webhook
		if err := rows.Scan(&w.ID, &w.URL, &w.Secret, &w.Events, &w.TenantID, &w.TenantPrefixes); err != nil {
			return out, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// Get returns one webhook including its secret.
func (s *Webhooks) Get(ctx context.Context, id int64) (Webhook, error) {
	var w Webhook
	err := s.pool.QueryRow(ctx, `
		SELECT id, url, secret, events, enabled, created_by, created_at, last_status, last_error, last_delivery_at
		  FROM tpbx_webhooks WHERE id=$1`, id).
		Scan(&w.ID, &w.URL, &w.Secret, &w.Events, &w.Enabled, &w.CreatedBy, &w.CreatedAt,
			&w.LastStatus, &w.LastError, &w.LastAt)
	if err != nil {
		return Webhook{}, err
	}
	return w, nil
}

// SetEnabled toggles a webhook on or off.
func (s *Webhooks) SetEnabled(ctx context.Context, id int64, enabled bool) error {
	_, err := s.pool.Exec(ctx, `UPDATE tpbx_webhooks SET enabled=$2 WHERE id=$1`, id, enabled)
	return err
}

// Delete removes a webhook.
func (s *Webhooks) Delete(ctx context.Context, id int64) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM tpbx_webhooks WHERE id=$1`, id)
	return err
}

// RecordDelivery stores the outcome of the most recent delivery attempt.
func (s *Webhooks) RecordDelivery(ctx context.Context, id int64, status int, errMsg string) {
	_, _ = s.pool.Exec(ctx, `
		UPDATE tpbx_webhooks SET last_status=$2, last_error=$3, last_delivery_at=now() WHERE id=$1`,
		id, status, errMsg)
}
