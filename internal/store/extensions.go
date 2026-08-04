// Package store contains the database-backed domain logic for objects the GUI
// provisions into Asterisk's realtime tables.
//
// An "extension" is the user-facing concept for a SIP account. In PJSIP realtime
// it is actually three linked sorcery objects sharing one id:
//
//	ps_auths     -- credentials (username/password)
//	ps_aors      -- where/how the device registers (max_contacts, ...)
//	ps_endpoints -- the endpoint tying auth + aor together with a context,
//	                transport and codecs
//
// Creating/updating/deleting must touch all three atomically, which is what
// this layer guarantees via a single transaction per operation.
package store

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is returned when an extension id does not exist.
var ErrNotFound = errors.New("extension not found")

// ErrConflict is returned when creating an extension whose id already exists.
var ErrConflict = errors.New("extension already exists")

// Extensions is the store for SIP extensions.
type Extensions struct {
	pool *pgxpool.Pool
}

// NewExtensions returns an Extensions store bound to a connection pool.
func NewExtensions(pool *pgxpool.Pool) *Extensions {
	return &Extensions{pool: pool}
}

// Extension is the flattened, GUI-friendly view of the three underlying objects.
type Extension struct {
	ID          string `json:"id"`                 // the extension number, e.g. "1001"
	Password    string `json:"password,omitempty"` // omitted from list responses
	Context     string `json:"context"`
	Transport   string `json:"transport"`
	Codecs      string `json:"codecs"` // maps to ps_endpoints.allow, e.g. "ulaw,alaw"
	CallerID    string `json:"callerId"`
	MaxContacts int    `json:"maxContacts"`
	WebRTC      bool   `json:"webrtc"`
	DTMFMode    string `json:"dtmfMode"`
}

// withDefaults fills unset fields with sensible values and normalises the
// transport when WebRTC is requested.
func (e *Extension) withDefaults() {
	if e.Context == "" {
		e.Context = "from-internal"
	}
	if e.Codecs == "" {
		e.Codecs = "ulaw,alaw"
	}
	if e.MaxContacts <= 0 {
		e.MaxContacts = 1
	}
	if e.DTMFMode == "" {
		e.DTMFMode = "rfc4733"
	}
	if e.WebRTC {
		// WebRTC clients must use the secure WebSocket transport.
		e.Transport = "transport-wss"
	} else if e.Transport == "" {
		e.Transport = "transport-udp"
	}
}

// List returns all extensions without passwords, ordered by id.
func (s *Extensions) List(ctx context.Context) ([]Extension, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT e.id,
		       COALESCE(e.context,''),
		       COALESCE(e.transport,''),
		       COALESCE(e.allow,''),
		       COALESCE(e.callerid,''),
		       COALESCE(e.webrtc,''),
		       COALESCE(a.max_contacts, 1)
		  FROM ps_endpoints e
		  LEFT JOIN ps_aors a ON a.id = e.aors
		 ORDER BY e.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Extension{}
	for rows.Next() {
		var e Extension
		var webrtc string
		if err := rows.Scan(&e.ID, &e.Context, &e.Transport, &e.Codecs,
			&e.CallerID, &webrtc, &e.MaxContacts); err != nil {
			return nil, err
		}
		e.WebRTC = strings.EqualFold(webrtc, "yes")
		out = append(out, e)
	}
	return out, rows.Err()
}

// Get returns a single extension including its password.
func (s *Extensions) Get(ctx context.Context, id string) (Extension, error) {
	var e Extension
	var webrtc string
	err := s.pool.QueryRow(ctx, `
		SELECT e.id,
		       COALESCE(e.context,''),
		       COALESCE(e.transport,''),
		       COALESCE(e.allow,''),
		       COALESCE(e.callerid,''),
		       COALESCE(e.webrtc,''),
		       COALESCE(e.dtmf_mode,''),
		       COALESCE(a.max_contacts, 1),
		       COALESCE(au.password,'')
		  FROM ps_endpoints e
		  LEFT JOIN ps_aors  a  ON a.id  = e.aors
		  LEFT JOIN ps_auths au ON au.id = e.auth
		 WHERE e.id = $1`, id).
		Scan(&e.ID, &e.Context, &e.Transport, &e.Codecs, &e.CallerID,
			&webrtc, &e.DTMFMode, &e.MaxContacts, &e.Password)
	if errors.Is(err, pgx.ErrNoRows) {
		return e, ErrNotFound
	}
	if err != nil {
		return e, err
	}
	e.WebRTC = strings.EqualFold(webrtc, "yes")
	return e, nil
}

// Create inserts a new extension (all three objects) atomically.
func (s *Extensions) Create(ctx context.Context, e Extension) error {
	if err := validateID(e.ID); err != nil {
		return err
	}
	if e.Password == "" {
		return errors.New("password is required")
	}
	e.withDefaults()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM ps_endpoints WHERE id=$1)`, e.ID).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return ErrConflict
	}
	if err := writeObjects(ctx, tx, e); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Update rewrites an existing extension's three objects atomically. A blank
// password leaves the stored credential untouched.
func (s *Extensions) Update(ctx context.Context, e Extension) error {
	if err := validateID(e.ID); err != nil {
		return err
	}
	e.withDefaults()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM ps_endpoints WHERE id=$1)`, e.ID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	if e.Password == "" {
		// Preserve the existing password.
		if err := tx.QueryRow(ctx, `SELECT COALESCE(password,'') FROM ps_auths WHERE id=$1`, e.ID).Scan(&e.Password); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	if err := writeObjects(ctx, tx, e); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Delete removes an extension's three objects plus any dynamic contacts.
func (s *Extensions) Delete(ctx context.Context, id string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	tag, err := tx.Exec(ctx, `DELETE FROM ps_endpoints WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	for _, q := range []string{
		`DELETE FROM ps_auths    WHERE id=$1`,
		`DELETE FROM ps_aors     WHERE id=$1`,
		`DELETE FROM ps_contacts WHERE endpoint=$1`,
	} {
		if _, err := tx.Exec(ctx, q, id); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// writeObjects upserts the auth, aor and endpoint rows for e within tx.
func writeObjects(ctx context.Context, tx pgx.Tx, e Extension) error {
	// Auth
	if _, err := tx.Exec(ctx, `
		INSERT INTO ps_auths (id, auth_type, username, password)
		VALUES ($1, 'userpass', $1, $2)
		ON CONFLICT (id) DO UPDATE SET auth_type='userpass', username=EXCLUDED.username, password=EXCLUDED.password`,
		e.ID, e.Password); err != nil {
		return fmt.Errorf("write auth: %w", err)
	}

	// AOR
	if _, err := tx.Exec(ctx, `
		INSERT INTO ps_aors (id, max_contacts, remove_existing)
		VALUES ($1, $2, 'yes')
		ON CONFLICT (id) DO UPDATE SET max_contacts=EXCLUDED.max_contacts, remove_existing='yes'`,
		e.ID, e.MaxContacts); err != nil {
		return fmt.Errorf("write aor: %w", err)
	}

	// Endpoint
	webrtc := ""
	if e.WebRTC {
		webrtc = "yes"
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO ps_endpoints
		    (id, transport, aors, auth, context, disallow, allow, callerid,
		     dtmf_mode, webrtc, rtp_symmetric, force_rport, rewrite_contact, direct_media)
		VALUES ($1, $2, $1, $1, $3, 'all', $4, $5, $6, $7, 'yes', 'yes', 'yes', 'no')
		ON CONFLICT (id) DO UPDATE SET
		    transport=EXCLUDED.transport,
		    aors=EXCLUDED.aors,
		    auth=EXCLUDED.auth,
		    context=EXCLUDED.context,
		    disallow='all',
		    allow=EXCLUDED.allow,
		    callerid=EXCLUDED.callerid,
		    dtmf_mode=EXCLUDED.dtmf_mode,
		    webrtc=EXCLUDED.webrtc`,
		e.ID, e.Transport, e.Context, e.Codecs, e.CallerID, e.DTMFMode, webrtc); err != nil {
		return fmt.Errorf("write endpoint: %w", err)
	}
	return nil
}

// validateID keeps ids safe as SIP identifiers and dialplan tokens.
func validateID(id string) error {
	if id == "" {
		return errors.New("id is required")
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' || r == '.') {
			return fmt.Errorf("id %q contains invalid characters (allowed: letters, digits, _ - .)", id)
		}
	}
	return nil
}
