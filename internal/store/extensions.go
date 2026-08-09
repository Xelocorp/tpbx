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
	"time"

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
		// A ws/wss transport is created dynamically per connection by
		// res_pjsip_transport_websocket -- it is NOT a named, selectable
		// transport. Pinning transport=transport-wss on the endpoint makes
		// Asterisk fail with "Unable to retrieve PJSIP transport 'transport-wss'"
		// and breaks call setup. Leave transport unset so Asterisk routes over
		// the client's own WebSocket flow; webrtc=yes handles the media setup.
		e.Transport = ""
	} else if e.Transport == "" {
		e.Transport = "transport-udp"
	}
}

// List returns all extensions without passwords, ordered by id.
//
// Trunks live in the same ps_endpoints table, so we exclude any endpoint that
// has an identify (ps_endpoint_id_ips) row -- that is what makes a row a trunk,
// not an extension.
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
		 WHERE NOT EXISTS (SELECT 1 FROM ps_endpoint_id_ips i WHERE i.endpoint = e.id)
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

// ExtStatus is the live registration state of one extension, derived from the
// dynamic contact Asterisk writes on REGISTER plus our own last-seen memory.
type ExtStatus struct {
	Online    bool   `json:"online"`
	IP        string `json:"ip,omitempty"`
	Port      int    `json:"port,omitempty"`
	UserAgent string `json:"userAgent,omitempty"`
	Device    string `json:"device"`             // "mobile" | "web" | "desk" | "none"
	LastSeen  string `json:"lastSeen,omitempty"` // RFC3339; when it last registered
}

// Status returns the live registration state for every extension. It reads the
// current dynamic contacts, records a last-seen row for any that are online,
// and back-fills last-seen for the offline ones from that memory.
func (s *Extensions) Status(ctx context.Context) (map[string]ExtStatus, error) {
	// One contact per extension: the one that lives longest (latest expiry).
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT ON (e.id)
		       e.id,
		       COALESCE(c.uri,''),
		       COALESCE(c.via_addr,''),
		       COALESCE(c.via_port,0),
		       COALESCE(c.user_agent,''),
		       COALESCE(c.expiration_time,0)
		  FROM ps_endpoints e
		  LEFT JOIN ps_contacts c ON c.endpoint = e.id
		 WHERE NOT EXISTS (SELECT 1 FROM ps_endpoint_id_ips i WHERE i.endpoint = e.id)
		 ORDER BY e.id, c.expiration_time DESC NULLS LAST`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	now := time.Now().Unix()
	out := map[string]ExtStatus{}
	type live struct {
		ip string
		pt int
		ua string
	}
	online := map[string]live{}
	for rows.Next() {
		var id, uri, viaAddr, ua string
		var viaPort int
		var exp int64
		if err := rows.Scan(&id, &uri, &viaAddr, &viaPort, &ua, &exp); err != nil {
			return nil, err
		}
		st := ExtStatus{Device: "none", UserAgent: ua}
		// A contact is a live registration while its expiry is still in the
		// future; Asterisk removes the row on unregister, so presence == a row.
		if uri != "" && exp > now {
			st.Online = true
			st.IP = viaAddr
			st.Port = viaPort
			if st.IP == "" {
				st.IP, st.Port = ipFromContactURI(uri)
			}
			st.Device = classifyDevice(ua)
			online[id] = live{st.IP, st.Port, ua}
		}
		out[id] = st
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Remember the ones we saw online so we can show "last connected" later.
	for id, l := range online {
		_, _ = s.pool.Exec(ctx, `
			INSERT INTO tpbx_ext_presence (extension, last_seen, last_ip, last_port, user_agent)
			VALUES ($1, now(), NULLIF($2,''), NULLIF($3,0), NULLIF($4,''))
			ON CONFLICT (extension) DO UPDATE SET
			    last_seen=now(), last_ip=EXCLUDED.last_ip,
			    last_port=EXCLUDED.last_port, user_agent=EXCLUDED.user_agent`,
			id, l.ip, l.pt, l.ua)
	}

	// Back-fill last-seen (and a best-effort device guess) for offline ones.
	pr, err := s.pool.Query(ctx, `SELECT extension, last_seen, COALESCE(user_agent,'') FROM tpbx_ext_presence`)
	if err == nil {
		defer pr.Close()
		for pr.Next() {
			var id, ua string
			var seen time.Time
			if err := pr.Scan(&id, &seen, &ua); err != nil {
				continue
			}
			st, ok := out[id]
			if !ok || st.Online {
				continue
			}
			st.LastSeen = seen.UTC().Format(time.RFC3339)
			if st.Device == "none" && ua != "" {
				st.Device = classifyDevice(ua)
			}
			out[id] = st
		}
	}
	return out, nil
}

// SetPassword changes an extension's SIP secret without touching anything else.
// It is used by the "reset password" action.
func (s *Extensions) SetPassword(ctx context.Context, id, password string) error {
	if password == "" {
		return errors.New("password is required")
	}
	var exists bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM ps_endpoints WHERE id=$1)`, id).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO ps_auths (id, auth_type, username, password)
		VALUES ($1, 'userpass', $1, $2)
		ON CONFLICT (id) DO UPDATE SET auth_type='userpass', username=$1, password=EXCLUDED.password`,
		id, password)
	return err
}

// classifyDevice guesses the device class from a SIP User-Agent string so the
// UI can show a phone/mobile/browser illustration.
func classifyDevice(ua string) string {
	u := strings.ToLower(ua)
	if u == "" {
		return "desk"
	}
	for _, m := range []string{"iphone", "ipad", "android", "mobile", "ios", "groundwire", "acrobits", "zoiper for", "linphone"} {
		if strings.Contains(u, m) {
			return "mobile"
		}
	}
	for _, w := range []string{"sip.js", "sipjs", "webrtc", "chrome", "firefox", "safari", "edge", "mozilla", "jssip", "tpbx"} {
		if strings.Contains(u, w) {
			return "web"
		}
	}
	return "desk"
}

// ipFromContactURI pulls the host:port out of a contact URI such as
// "sip:1001@203.0.113.4:5060;transport=udp" when via_addr is unavailable.
func ipFromContactURI(uri string) (string, int) {
	s := uri
	if i := strings.Index(s, "@"); i >= 0 {
		s = s[i+1:]
	} else {
		s = strings.TrimPrefix(strings.TrimPrefix(s, "sip:"), "sips:")
	}
	if i := strings.IndexAny(s, ";>"); i >= 0 {
		s = s[:i]
	}
	return splitHostPort(s)
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
		     dtmf_mode, webrtc, rtp_symmetric, force_rport, rewrite_contact, direct_media,
		     rtp_timeout, rtp_timeout_hold)
		VALUES ($1, NULLIF($2,''), $1, $1, $3, 'all', $4, $5, $6, $7, 'yes', 'yes', 'yes', 'no',
		        '30', '300')
		ON CONFLICT (id) DO UPDATE SET
		    transport=EXCLUDED.transport,
		    aors=EXCLUDED.aors,
		    auth=EXCLUDED.auth,
		    context=EXCLUDED.context,
		    disallow='all',
		    allow=EXCLUDED.allow,
		    callerid=EXCLUDED.callerid,
		    dtmf_mode=EXCLUDED.dtmf_mode,
		    webrtc=EXCLUDED.webrtc,
		    rtp_timeout='30',
		    rtp_timeout_hold='300'`,
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
