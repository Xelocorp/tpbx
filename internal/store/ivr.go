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

// soundBase/soundPrefix map an uploaded prompt reference (e.g. "tpbx/welcome")
// to its absolute path on disk. Set once at startup via SetSoundLocation.
var (
	soundBase   string
	soundPrefix string
)

// SetSoundLocation configures how uploaded-prompt references resolve to files.
// Referencing prompts by ABSOLUTE path in the dialplan bypasses Asterisk's
// per-language sounds lookup (sounds/<lang>/...), which otherwise silently
// fails to find a prompt when the channel language is unset or not "en".
func SetSoundLocation(dir, prefix string) {
	soundBase = strings.TrimRight(dir, "/")
	soundPrefix = strings.Trim(prefix, "/")
}

// resolveSound turns a prompt reference into a dialplan-safe sound token. Refs
// under the managed prefix become absolute paths (language-independent); any
// other value (a hand-typed Asterisk sound path) is passed through sanitized.
func resolveSound(ref string) string {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return ""
	}
	if soundBase != "" && soundPrefix != "" && strings.HasPrefix(ref, soundPrefix+"/") {
		return sanitizeSound(soundBase + "/" + strings.TrimPrefix(ref, soundPrefix+"/"))
	}
	return sanitizeSound(ref)
}

// IVROption maps a key press to a destination.
type IVROption struct {
	Digit     string `json:"digit"`     // 0-9 * #
	DestType  string `json:"destType"`  // extension|ivr|voicemail|playback|repeat|hangup
	DestValue string `json:"destValue"` // extension number / ivr name / mailbox / sound
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
	Layout      string      `json:"layout"` // opaque JSON: visual builder canvas positions
	Options     []IVROption `json:"options"`
}

// List returns all IVRs with their options.
func (s *IVRs) List(ctx context.Context) ([]IVR, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, greeting, timeout_sec, max_retries, invalid_dest, timeout_dest, COALESCE(layout,'')
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
			&v.InvalidDest, &v.TimeoutDest, &v.Layout); err != nil {
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
		SELECT id, name, greeting, timeout_sec, max_retries, invalid_dest, timeout_dest, COALESCE(layout,'')
		  FROM tpbx_ivrs WHERE id=$1`, id).
		Scan(&v.ID, &v.Name, &v.Greeting, &v.TimeoutSec, &v.MaxRetries, &v.InvalidDest, &v.TimeoutDest, &v.Layout)
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
		INSERT INTO tpbx_ivrs (name, greeting, timeout_sec, max_retries, invalid_dest, timeout_dest, layout)
		VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
		v.Name, v.Greeting, v.TimeoutSec, v.MaxRetries, v.InvalidDest, v.TimeoutDest, v.Layout).Scan(&id)
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
		    invalid_dest=$6, timeout_dest=$7, layout=$8 WHERE id=$1`,
		v.ID, v.Name, v.Greeting, v.TimeoutSec, v.MaxRetries, v.InvalidDest, v.TimeoutDest, v.Layout)
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
		if g := resolveSound(v.Greeting); g != "" {
			fmt.Fprintf(&b, " same => n(menu),Background(%s)\n", g)
		} else {
			b.WriteString(" same => n(menu),NoOp(no greeting)\n")
		}
		fmt.Fprintf(&b, " same => n,WaitExten(%d)\n", v.TimeoutSec)

		// Group a key's actions so one key can run several steps in sequence
		// (e.g. Play message, then Dial an extension). "playback" is an
		// intermediate step that continues to the next; any other action is
		// terminal and ends the chain.
		seenDigit := map[string]bool{}
		var digits []string
		byDigit := map[string][]IVROption{}
		for _, o := range v.Options {
			d := sanitizeDigit(o.Digit)
			if d == "" {
				continue
			}
			if !seenDigit[d] {
				seenDigit[d] = true
				digits = append(digits, d)
			}
			byDigit[d] = append(byDigit[d], o)
		}
		for _, d := range digits {
			fmt.Fprintf(&b, "exten => %s,1,NoOp(IVR %s key %s)\n", d, name, d)
			terminal := false
			for _, a := range byDigit[d] {
				if a.DestType == "playback" {
					fmt.Fprintf(&b, " same => n,Playback(%s)\n", resolveSound(a.DestValue))
					continue
				}
				for _, line := range ivrActionLines(a.DestType, a.DestValue, name) {
					fmt.Fprintf(&b, " same => n,%s\n", line)
				}
				terminal = true
				break
			}
			if !terminal {
				// A chain of only announcements ends the call.
				b.WriteString(" same => n,Hangup()\n")
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

// ivrActionLines renders an option destination (type/value pair). "repeat"
// jumps back to the menu label of the CURRENT IVR, so it needs the menu name.
func ivrActionLines(destType, destValue, menu string) []string {
	switch destType {
	case "ivr":
		return []string{fmt.Sprintf("Goto(tpbx-ivr-%s,s,1)", sanitizeField(destValue))}
	case "voicemail":
		return []string{fmt.Sprintf("VoiceMail(%s@default,u)", sanitizeField(destValue)), "Hangup()"}
	case "playback":
		return []string{fmt.Sprintf("Playback(%s)", resolveSound(destValue)), "Hangup()"}
	case "repeat":
		return []string{fmt.Sprintf("Goto(tpbx-ivr-%s,s,menu)", sanitizeField(menu))}
	case "external":
		return externalDialLines(destValue)
	case "hangup":
		return []string{"Hangup()"}
	default: // extension
		return []string{
			fmt.Sprintf("Dial(PJSIP/%s,30)", sanitizeField(destValue)),
			"Hangup()",
		}
	}
}

// externalDialLines dials an outside/GSM number through a trunk. The value is
// encoded "<number>@<trunk>"; a missing trunk falls back to a direct dial.
func externalDialLines(value string) []string {
	num, trunk := splitExternal(value)
	num = sanitizeField(num)
	trunk = sanitizeField(trunk)
	if num == "" {
		return []string{"Hangup()"}
	}
	if trunk == "" {
		return []string{fmt.Sprintf("Dial(PJSIP/%s,60)", num), "Hangup()"}
	}
	return []string{fmt.Sprintf("Dial(PJSIP/%s@%s,60)", num, trunk), "Hangup()"}
}

// splitExternal parses "<number>@<trunk>" into its parts (trunk optional).
func splitExternal(v string) (num, trunk string) {
	v = strings.TrimSpace(v)
	if i := strings.LastIndex(v, "@"); i >= 0 {
		return v[:i], v[i+1:]
	}
	return v, ""
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
	case "voicemail":
		return []string{fmt.Sprintf("VoiceMail(%s@default,u)", sanitizeField(v)), "Hangup()"}
	case "playback":
		return []string{fmt.Sprintf("Playback(%s)", resolveSound(v)), "Hangup()"}
	case "external":
		return externalDialLines(v)
	case "hangup":
		return []string{"Hangup()"}
	default:
		return []string{"Hangup()"}
	}
}

func destType(t string) string {
	switch t {
	case "ivr", "hangup", "extension", "voicemail", "playback", "repeat", "external":
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
