package store

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Trunks is the store for SIP trunks (connections to an upstream provider/ITSP).
//
// A trunk, like an extension, is several linked PJSIP realtime objects sharing
// one id, but it involves more of them:
//
//	ps_endpoints        -- the trunk endpoint (context from-trunk, codecs, NAT)
//	ps_aors             -- a STATIC contact pointing at the provider host
//	ps_auths            -- outbound credentials              (register mode only)
//	ps_registrations    -- outbound registration to the provider (register mode only)
//	ps_endpoint_id_ips  -- identify: match inbound traffic from the provider IP
//
// Two modes:
//   - "register": authenticate + register to the provider (username/password).
//   - "ip":       trusted peer identified purely by IP, no auth/registration.
type Trunks struct {
	pool *pgxpool.Pool
}

// NewTrunks returns a Trunks store bound to a connection pool.
func NewTrunks(pool *pgxpool.Pool) *Trunks {
	return &Trunks{pool: pool}
}

// Trunk is the flattened, GUI-friendly view of the underlying objects.
type Trunk struct {
	Name       string `json:"name"`               // trunk id, e.g. "myprovider"
	Mode       string `json:"mode"`               // "register" | "ip"
	Host       string `json:"host"`               // provider host/IP
	Port       int    `json:"port"`               // provider port (default 5060)
	Username   string `json:"username"`           // provider auth user (register mode)
	Password   string `json:"password,omitempty"` // omitted from list responses
	FromUser   string `json:"fromUser"`           // From: user (caller-id presentation)
	FromDomain string `json:"fromDomain"`         // From: domain
	Context    string `json:"context"`            // inbound dialplan context
	Transport  string `json:"transport"`
	Codecs     string `json:"codecs"`

	// State is live reachability from Asterisk (online/offline/unknown). It is
	// populated by the API from ARI, not stored in the database.
	State string `json:"state,omitempty"`
}

func (t *Trunk) withDefaults() {
	if t.Mode == "" {
		t.Mode = "register"
	}
	if t.Port <= 0 {
		t.Port = 5060
	}
	if t.Context == "" {
		t.Context = "from-trunk"
	}
	if t.Transport == "" {
		t.Transport = "transport-udp"
	}
	if t.Codecs == "" {
		t.Codecs = "ulaw,alaw"
	}
	if t.FromUser == "" {
		t.FromUser = t.Username
	}
	if t.FromDomain == "" {
		t.FromDomain = t.Host
	}
}

// List returns all trunks (without passwords), ordered by name.
func (s *Trunks) List(ctx context.Context) ([]Trunk, error) {
	// A row is a trunk if an identify exists for it (both modes create one).
	rows, err := s.pool.Query(ctx, `
		SELECT e.id,
		       COALESCE(e.context,''),
		       COALESCE(e.transport,''),
		       COALESCE(e.allow,''),
		       COALESCE(e.from_user,''),
		       COALESCE(e.from_domain,''),
		       COALESCE(i.match,''),
		       CASE WHEN r.id IS NULL THEN 'ip' ELSE 'register' END AS mode,
		       COALESCE(au.username,'')
		  FROM ps_endpoint_id_ips i
		  JOIN ps_endpoints e   ON e.id = i.endpoint
		  LEFT JOIN ps_registrations r ON r.id = e.id
		  LEFT JOIN ps_auths au ON au.id = e.outbound_auth
		 ORDER BY e.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Trunk{}
	for rows.Next() {
		var t Trunk
		var match string
		if err := rows.Scan(&t.Name, &t.Context, &t.Transport, &t.Codecs,
			&t.FromUser, &t.FromDomain, &match, &t.Mode, &t.Username); err != nil {
			return nil, err
		}
		t.Host, t.Port = splitHostPort(match)
		out = append(out, t)
	}
	return out, rows.Err()
}

// Get returns a single trunk including its password.
func (s *Trunks) Get(ctx context.Context, name string) (Trunk, error) {
	var t Trunk
	var match string
	err := s.pool.QueryRow(ctx, `
		SELECT e.id,
		       COALESCE(e.context,''),
		       COALESCE(e.transport,''),
		       COALESCE(e.allow,''),
		       COALESCE(e.from_user,''),
		       COALESCE(e.from_domain,''),
		       COALESCE(i.match,''),
		       CASE WHEN r.id IS NULL THEN 'ip' ELSE 'register' END AS mode,
		       COALESCE(au.username,''),
		       COALESCE(au.password,'')
		  FROM ps_endpoints e
		  LEFT JOIN ps_endpoint_id_ips i ON i.endpoint = e.id
		  LEFT JOIN ps_registrations r   ON r.id = e.id
		  LEFT JOIN ps_auths au          ON au.id = e.outbound_auth
		 WHERE e.id = $1`, name).
		Scan(&t.Name, &t.Context, &t.Transport, &t.Codecs, &t.FromUser,
			&t.FromDomain, &match, &t.Mode, &t.Username, &t.Password)
	if errors.Is(err, pgx.ErrNoRows) {
		return t, ErrNotFound
	}
	if err != nil {
		return t, err
	}
	t.Host, t.Port = splitHostPort(match)
	return t, nil
}

// Create inserts a new trunk atomically.
func (s *Trunks) Create(ctx context.Context, t Trunk) error {
	if err := validateID(t.Name); err != nil {
		return err
	}
	if t.Host == "" {
		return errors.New("host is required")
	}
	t.withDefaults()
	if t.Mode == "register" && (t.Username == "" || t.Password == "") {
		return errors.New("username and password are required for a register trunk")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM ps_endpoints WHERE id=$1)`, t.Name).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return ErrConflict
	}
	if err := writeTrunk(ctx, tx, t); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Update rewrites an existing trunk atomically. A blank password is preserved.
func (s *Trunks) Update(ctx context.Context, t Trunk) error {
	if err := validateID(t.Name); err != nil {
		return err
	}
	if t.Host == "" {
		return errors.New("host is required")
	}
	t.withDefaults()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM ps_endpoints WHERE id=$1)`, t.Name).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	if t.Mode == "register" && t.Password == "" {
		if err := tx.QueryRow(ctx, `SELECT COALESCE(password,'') FROM ps_auths WHERE id=$1`, t.Name).Scan(&t.Password); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	// Clear the old objects first so a mode change (register<->ip) doesn't leave
	// stale auth/registration rows behind.
	if err := deleteTrunkRows(ctx, tx, t.Name); err != nil {
		return err
	}
	if err := writeTrunk(ctx, tx, t); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Delete removes all objects that make up a trunk.
func (s *Trunks) Delete(ctx context.Context, name string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM ps_endpoints WHERE id=$1)`, name).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	if err := deleteTrunkRows(ctx, tx, name); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func deleteTrunkRows(ctx context.Context, tx pgx.Tx, name string) error {
	for _, q := range []string{
		`DELETE FROM ps_endpoints        WHERE id=$1`,
		`DELETE FROM ps_auths            WHERE id=$1`,
		`DELETE FROM ps_aors             WHERE id=$1`,
		`DELETE FROM ps_registrations    WHERE id=$1`,
		`DELETE FROM ps_endpoint_id_ips  WHERE id=$1`,
	} {
		if _, err := tx.Exec(ctx, q, name); err != nil {
			return err
		}
	}
	return nil
}

// writeTrunk inserts the objects for a trunk within tx.
func writeTrunk(ctx context.Context, tx pgx.Tx, t Trunk) error {
	contact := fmt.Sprintf("sip:%s:%d", t.Host, t.Port)

	// AOR: static contact pointing at the provider, qualified so we can see it.
	if _, err := tx.Exec(ctx, `
		INSERT INTO ps_aors (id, contact, qualify_frequency)
		VALUES ($1, $2, 60)`, t.Name, contact); err != nil {
		return fmt.Errorf("write aor: %w", err)
	}

	// Identify: match inbound traffic from the provider host to this endpoint.
	if _, err := tx.Exec(ctx, `
		INSERT INTO ps_endpoint_id_ips (id, endpoint, match)
		VALUES ($1, $1, $2)`, t.Name, t.Host); err != nil {
		return fmt.Errorf("write identify: %w", err)
	}

	outboundAuth := ""
	if t.Mode == "register" {
		outboundAuth = t.Name
		if _, err := tx.Exec(ctx, `
			INSERT INTO ps_auths (id, auth_type, username, password)
			VALUES ($1, 'userpass', $2, $3)`, t.Name, t.Username, t.Password); err != nil {
			return fmt.Errorf("write auth: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO ps_registrations
			    (id, transport, outbound_auth, server_uri, client_uri,
			     retry_interval, max_retries, expiration, line, endpoint)
			VALUES ($1, $2, $1, $3, $4, 60, 10, 3600, 'yes', $1)`,
			t.Name, t.Transport,
			fmt.Sprintf("sip:%s:%d", t.Host, t.Port),
			fmt.Sprintf("sip:%s@%s:%d", t.Username, t.Host, t.Port)); err != nil {
			return fmt.Errorf("write registration: %w", err)
		}
	}

	// Endpoint.
	if _, err := tx.Exec(ctx, `
		INSERT INTO ps_endpoints
		    (id, transport, aors, outbound_auth, context, disallow, allow,
		     from_user, from_domain, direct_media, rtp_symmetric, force_rport,
		     rewrite_contact)
		VALUES ($1, $2, $1, NULLIF($3,''), $4, 'all', $5,
		        $6, $7, 'no', 'yes', 'yes', 'yes')`,
		t.Name, t.Transport, outboundAuth, t.Context, t.Codecs,
		t.FromUser, t.FromDomain); err != nil {
		return fmt.Errorf("write endpoint: %w", err)
	}
	return nil
}

// splitHostPort parses "host:port" (as stored in identify.match / aor contact),
// returning the host and port (defaulting to 5060).
func splitHostPort(s string) (string, int) {
	s = strings.TrimPrefix(s, "sip:")
	host := s
	port := 5060
	if i := strings.LastIndex(s, ":"); i >= 0 {
		host = s[:i]
		if p, err := strconv.Atoi(s[i+1:]); err == nil {
			port = p
		}
	}
	return host, port
}
