package store

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// IVRs is the store for IVR (auto-attendant) menus. Like routes, IVRs compile
// into generated dialplan contexts (tpbx-ivr-<name>) that Asterisk #includes.
type IVRs struct {
	pool *pgxpool.Pool
}

// NewIVRs returns an IVRs store bound to a connection pool.
func NewIVRs(pool *pgxpool.Pool) *IVRs {
	return &IVRs{pool: pool}
}

// IVROption maps a key press to a destination.
type IVROption struct {
	Digit     string `json:"digit"`     // 0-9 * #
	DestType  string `json:"destType"`  // extension | ivr | hangup
	DestValue string `json:"destValue"` // extension number / ivr name
	Label     string `json:"label"`
}

// IVR is an auto-attendant menu.
type IVR struct {
	ID          int64       `json:"id"`
	Name        string      `json:"name"`
	Greeting    string      `json:"greeting"`
	TimeoutSec  int         `json:"timeoutSec"`
	MaxRetries  int         `json:"maxRetries"`
	InvalidDest string      `json:"invalidDest"` // "type:value" or ""
	TimeoutDest string      `json:"timeoutDest"`
	Options     []IVROption `json:"options"`
}

// List returns all IVRs with their options.
func (s *IVRs) List(ctx context.Context) ([]IVR, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, greeting, timeout_sec, max_retries, invalid_dest, timeout_dest
		  FROM tpbx_ivrs ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []IVR{}
	idx := map[int64]int{}
	for rows.Next() {
		var v IVR
		if err := rows.Scan(&v.ID, &v.Name, &v.Greeting, &v.TimeoutSec, &v.MaxRetries,
			&v.InvalidDest, &v.TimeoutDest); err != nil {
			return nil, err
		}
		v.Options = []IVROption{}
		idx[v.ID] = len(out)
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	orows, err := s.pool.Query(ctx, `
		SELECT ivr_id, digit, dest_type, dest_value, label
		  FROM tpbx_ivr_options ORDER BY ivr_id, position, digit`)
	if err != nil {
		return nil, err
	}
	defer orows.Close()
	for orows.Next() {
		var id int64
		var o IVROption
		if err := orows.Scan(&id, &o.Digit, &o.DestType, &o.DestValue, &o.Label); err != nil {
			return nil, err
		}
		if i, ok := idx[id]; ok {
			out[i].Options = append(out[i].Options, o)
		}
	}
	return out, orows.Err()
}

// Get returns one IVR with options.
func (s *IVRs) Get(ctx context.Context, id int64) (IVR, error) {
	var v IVR
	err := s.pool.QueryRow(ctx, `
		SELECT id, name, greeting, timeout_sec, max_retries, invalid_dest, timeout_dest
		  FROM tpbx_ivrs WHERE id=$1`, id).
		Scan(&v.ID, &v.Name, &v.Greeting, &v.TimeoutSec, &v.MaxRetries, &v.InvalidDest, &v.TimeoutDest)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, ErrNotFound
	}
	if err != nil {
		return v, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT digit, dest_type, dest_value, label FROM tpbx_ivr_options
		 WHERE ivr_id=$1 ORDER BY position, digit`, id)
	if err != nil {
		return v, err
	}
	defer rows.Close()
	v.Options = []IVROption{}
	for rows.Next() {
		var o IVROption
		if err := rows.Scan(&o.Digit, &o.DestType, &o.DestValue, &o.Label); err != nil {
			return v, err
		}
		v.Options = append(v.Options, o)
	}
	return v, rows.Err()
}

func (v *IVR) validate() error {
	if err := validateID(v.Name); err != nil {
		return err
	}
	if v.TimeoutSec <= 0 {
		v.TimeoutSec = 5
	}
	if v.MaxRetries <= 0 {
		v.MaxRetries = 3
	}
	return nil
}

// Create inserts an IVR and its options atomically.
func (s *IVRs) Create(ctx context.Context, v IVR) (int64, error) {
	if err := v.validate(); err != nil {
		return 0, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var id int64
	err = tx.QueryRow(ctx, `
		INSERT INTO tpbx_ivrs (name, greeting, timeout_sec, max_retries, invalid_dest, timeout_dest)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
		v.Name, v.Greeting, v.TimeoutSec, v.MaxRetries, v.InvalidDest, v.TimeoutDest).Scan(&id)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate key") {
			return 0, ErrConflict
		}
		return 0, err
	}
	if err := writeIVROptions(ctx, tx, id, v.Options); err != nil {
		return 0, err
	}
	return id, tx.Commit(ctx)
}

// Update rewrites an IVR and replaces its options atomically.
func (s *IVRs) Update(ctx context.Context, v IVR) error {
	if err := v.validate(); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	tag, err := tx.Exec(ctx, `
		UPDATE tpbx_ivrs SET name=$2, greeting=$3, timeout_sec=$4, max_retries=$5,
		    invalid_dest=$6, timeout_dest=$7 WHERE id=$1`,
		v.ID, v.Name, v.Greeting, v.TimeoutSec, v.MaxRetries, v.InvalidDest, v.TimeoutDest)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if _, err := tx.Exec(ctx, `DELETE FROM tpbx_ivr_options WHERE ivr_id=$1`, v.ID); err != nil {
		return err
	}
	if err := writeIVROptions(ctx, tx, v.ID, v.Options); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Delete removes an IVR (options cascade).
func (s *IVRs) Delete(ctx context.Context, id int64) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM tpbx_ivrs WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func writeIVROptions(ctx context.Context, tx pgx.Tx, ivrID int64, opts []IVROption) error {
	for i, o := range opts {
		if o.Digit == "" {
			continue
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO tpbx_ivr_options (ivr_id, digit, dest_type, dest_value, label, position)
			VALUES ($1,$2,$3,$4,$5,$6)`,
			ivrID, sanitizeDigit(o.Digit), destType(o.DestType), sanitizeField(o.DestValue), sanitizeField(o.Label), i); err != nil {
			return err
		}
	}
	return nil
}

// GenerateDialplan compiles every IVR into a [tpbx-ivr-<name>] context.
func (s *IVRs) GenerateDialplan(ctx context.Context) (string, error) {
	list, err := s.List(ctx)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	b.WriteString("\n; ---- IVR menus (generated) ----\n")
	for _, v := range list {
		name := sanitizeField(v.Name)
		fmt.Fprintf(&b, "\n[tpbx-ivr-%s]\n", name)
		b.WriteString("exten => s,1,Answer()\n")
		b.WriteString(" same => n,Set(TPBX_TRIES=0)\n")
		if g := sanitizeSound(v.Greeting); g != "" {
			fmt.Fprintf(&b, " same => n(menu),Background(%s)\n", g)
		} else {
			b.WriteString(" same => n(menu),NoOp(no greeting)\n")
		}
		fmt.Fprintf(&b, " same => n,WaitExten(%d)\n", v.TimeoutSec)

		for _, o := range v.Options {
			d := sanitizeDigit(o.Digit)
			if d == "" {
				continue
			}
			fmt.Fprintf(&b, "exten => %s,1,NoOp(IVR %s key %s)\n", d, name, d)
			for _, line := range ivrActionLines(o.DestType, o.DestValue) {
				fmt.Fprintf(&b, " same => n,%s\n", line)
			}
		}

		// Invalid input and timeout: replay up to max_retries, then go to the
		// configured fallback (or hang up).
		writeIVRFallback(&b, "i", name, v.MaxRetries, v.InvalidDest)
		writeIVRFallback(&b, "t", name, v.MaxRetries, v.TimeoutDest)
	}
	return b.String(), nil
}

func writeIVRFallback(b *strings.Builder, exten, name string, maxRetries int, dest string) {
	fmt.Fprintf(b, "exten => %s,1,Set(TPBX_TRIES=$[${TPBX_TRIES}+1])\n", exten)
	fmt.Fprintf(b, " same => n,GotoIf($[${TPBX_TRIES} < %d]?s,menu)\n", maxRetries)
	for _, line := range ivrDestLines(dest) {
		fmt.Fprintf(b, " same => n,%s\n", line)
	}
}

// ivrActionLines renders an option destination (type/value pair).
func ivrActionLines(destType, destValue string) []string {
	switch destType {
	case "ivr":
		return []string{fmt.Sprintf("Goto(tpbx-ivr-%s,s,1)", sanitizeField(destValue))}
	case "hangup":
		return []string{"Hangup()"}
	default: // extension
		return []string{
			fmt.Sprintf("Dial(PJSIP/%s,30)", sanitizeField(destValue)),
			"Hangup()",
		}
	}
}

// ivrDestLines renders a fallback destination encoded as "type:value" (used by
// invalid/timeout and by inbound routes). An empty/unknown value hangs up.
func ivrDestLines(dest string) []string {
	dest = strings.TrimSpace(dest)
	if dest == "" {
		return []string{"Hangup()"}
	}
	t, v, _ := strings.Cut(dest, ":")
	switch t {
	case "ivr":
		return []string{fmt.Sprintf("Goto(tpbx-ivr-%s,s,1)", sanitizeField(v))}
	case "extension", "ext":
		return []string{fmt.Sprintf("Dial(PJSIP/%s,30)", sanitizeField(v)), "Hangup()"}
	case "hangup":
		return []string{"Hangup()"}
	default:
		return []string{"Hangup()"}
	}
}

func destType(t string) string {
	switch t {
	case "ivr", "hangup", "extension":
		return t
	default:
		return "extension"
	}
}

func sanitizeDigit(s string) string {
	s = strings.TrimSpace(s)
	if len(s) != 1 {
		return ""
	}
	c := s[0]
	if (c >= '0' && c <= '9') || c == '*' || c == '#' {
		return s
	}
	return ""
}

// sanitizeSound keeps characters valid in an Asterisk sound-file reference.
func sanitizeSound(s string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '/' || r == '_' || r == '-' || r == '.':
			return r
		default:
			return -1
		}
	}, strings.TrimSpace(s))
}
