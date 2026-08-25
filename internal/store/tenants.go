package store

import (
	"context"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Tenants manages the organizations that partition the API surface. A tenant
// owns extensions by number prefix and, optionally, a set of queues.
type Tenants struct {
	pool *pgxpool.Pool
}

// NewTenants returns a Tenants store bound to a connection pool.
func NewTenants(pool *pgxpool.Pool) *Tenants {
	return &Tenants{pool: pool}
}

// Tenant is one organization.
type Tenant struct {
	ID          int64     `json:"id"`
	Name        string    `json:"name"`
	Slug        string    `json:"slug"`
	ExtPrefixes string    `json:"extPrefixes"` // CSV of number prefixes, e.g. "20,21"
	Queues      string    `json:"queues"`      // CSV of queue names
	CreatedBy   string    `json:"createdBy"`
	CreatedAt   time.Time `json:"createdAt"`
}

// PrefixList splits the CSV of extension prefixes into a trimmed slice.
func (t Tenant) PrefixList() []string { return csvList(t.ExtPrefixes) }

// QueueList splits the CSV of queue names into a trimmed slice.
func (t Tenant) QueueList() []string { return csvList(t.Queues) }

// Matches reports whether an extension belongs to this tenant. With no prefixes
// configured a tenant owns nothing (fail-closed), so a misconfigured scope can
// never accidentally expose every extension.
func (t Tenant) Matches(ext string) bool {
	for _, p := range t.PrefixList() {
		if strings.HasPrefix(ext, p) {
			return true
		}
	}
	return false
}

func csvList(s string) []string {
	out := []string{}
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func slugify(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	prevDash := false
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			prevDash = false
		default:
			if !prevDash && b.Len() > 0 {
				b.WriteByte('-')
				prevDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

// Create inserts a tenant, deriving a slug from the name when none is given.
func (s *Tenants) Create(ctx context.Context, t Tenant, createdBy string) (Tenant, error) {
	if strings.TrimSpace(t.Slug) == "" {
		t.Slug = slugify(t.Name)
	}
	if t.Slug == "" {
		t.Slug = "tenant"
	}
	err := s.pool.QueryRow(ctx, `
		INSERT INTO tpbx_tenants (name, slug, ext_prefixes, queues, created_by)
		VALUES ($1,$2,$3,$4,$5)
		RETURNING id, created_at`,
		t.Name, t.Slug, t.ExtPrefixes, t.Queues, createdBy).
		Scan(&t.ID, &t.CreatedAt)
	if err != nil {
		return Tenant{}, err
	}
	t.CreatedBy = createdBy
	return t, nil
}

// Update changes a tenant's editable fields.
func (s *Tenants) Update(ctx context.Context, t Tenant) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE tpbx_tenants SET name=$2, ext_prefixes=$3, queues=$4 WHERE id=$1`,
		t.ID, t.Name, t.ExtPrefixes, t.Queues)
	return err
}

// List returns all tenants (newest first).
func (s *Tenants) List(ctx context.Context) ([]Tenant, error) {
	out := []Tenant{}
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, slug, ext_prefixes, queues, created_by, created_at
		  FROM tpbx_tenants ORDER BY created_at DESC`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var t Tenant
		if err := rows.Scan(&t.ID, &t.Name, &t.Slug, &t.ExtPrefixes, &t.Queues, &t.CreatedBy, &t.CreatedAt); err != nil {
			return out, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// Get returns one tenant by id.
func (s *Tenants) Get(ctx context.Context, id int64) (Tenant, error) {
	var t Tenant
	err := s.pool.QueryRow(ctx, `
		SELECT id, name, slug, ext_prefixes, queues, created_by, created_at
		  FROM tpbx_tenants WHERE id=$1`, id).
		Scan(&t.ID, &t.Name, &t.Slug, &t.ExtPrefixes, &t.Queues, &t.CreatedBy, &t.CreatedAt)
	if err != nil {
		return Tenant{}, err
	}
	return t, nil
}

// Delete removes a tenant. Tokens/webhooks bound to it revert to global scope
// (ON DELETE SET NULL), so deleting a tenant does not silently disable them.
func (s *Tenants) Delete(ctx context.Context, id int64) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM tpbx_tenants WHERE id=$1`, id)
	return err
}
