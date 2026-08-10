package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Routes is the store for call routing (outbound + inbound). Unlike PJSIP
// objects, routes are NOT read by Asterisk from realtime -- they are compiled
// into a generated dialplan file that Asterisk #includes. See GenerateDialplan.
type Routes struct {
	pool *pgxpool.Pool
}

// NewRoutes returns a Routes store bound to a connection pool.
func NewRoutes(pool *pgxpool.Pool) *Routes {
	return &Routes{pool: pool}
}

// OutboundRoute sends calls matching Pattern to a destination: either out
// through Trunk (dest_type "trunk", optionally stripping leading digits and
// prepending others before dialing) or into an IVR menu (dest_type "ivr").
type OutboundRoute struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Pattern  string `json:"pattern"`  // Asterisk pattern, e.g. _9. or _NXXXXXXXXXX
	DestType string `json:"destType"` // "trunk" (default) | "ivr"
	Trunk    string `json:"trunk"`    // used when destType == "trunk"
	IVR      string `json:"ivr"`      // menu name, used when destType == "ivr"
	Strip    int    `json:"strip"`
	Prepend  string `json:"prepend"`
	CallerID string `json:"callerId"`
	Position int    `json:"position"`
	Enabled  bool   `json:"enabled"`
}

func (r *OutboundRoute) withDefaults() {
	if r.DestType == "" {
		r.DestType = "trunk"
	}
}

// InboundRoute routes a call arriving on a trunk (DID) to a destination extension.
type InboundRoute struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	DID         string `json:"did"`         // matched exten in from-trunk; "_." for any
	Destination string `json:"destination"` // extension number to ring
	Enabled     bool   `json:"enabled"`
}

// --- Outbound CRUD ----------------------------------------------------------

func (s *Routes) ListOutbound(ctx context.Context) ([]OutboundRoute, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, pattern, dest_type, trunk, ivr, strip, prepend, caller_id, position, enabled
		  FROM tpbx_outbound_routes ORDER BY position, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []OutboundRoute{}
	for rows.Next() {
		var r OutboundRoute
		if err := rows.Scan(&r.ID, &r.Name, &r.Pattern, &r.DestType, &r.Trunk, &r.IVR,
			&r.Strip, &r.Prepend, &r.CallerID, &r.Position, &r.Enabled); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Routes) CreateOutbound(ctx context.Context, r OutboundRoute) (int64, error) {
	r.withDefaults()
	if err := validateOutbound(r); err != nil {
		return 0, err
	}
	var id int64
	err := s.pool.QueryRow(ctx, `
		INSERT INTO tpbx_outbound_routes (name, pattern, dest_type, trunk, ivr, strip, prepend, caller_id, position, enabled)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
		r.Name, r.Pattern, r.DestType, r.Trunk, r.IVR, r.Strip, r.Prepend, r.CallerID, r.Position, r.Enabled).Scan(&id)
	return id, err
}

func (s *Routes) UpdateOutbound(ctx context.Context, r OutboundRoute) error {
	r.withDefaults()
	if err := validateOutbound(r); err != nil {
		return err
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE tpbx_outbound_routes
		   SET name=$2, pattern=$3, dest_type=$4, trunk=$5, ivr=$6, strip=$7, prepend=$8, caller_id=$9, position=$10, enabled=$11
		 WHERE id=$1`,
		r.ID, r.Name, r.Pattern, r.DestType, r.Trunk, r.IVR, r.Strip, r.Prepend, r.CallerID, r.Position, r.Enabled)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Routes) DeleteOutbound(ctx context.Context, id int64) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM tpbx_outbound_routes WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// --- Inbound CRUD -----------------------------------------------------------

func (s *Routes) ListInbound(ctx context.Context) ([]InboundRoute, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, did, destination, enabled
		  FROM tpbx_inbound_routes ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []InboundRoute{}
	for rows.Next() {
		var r InboundRoute
		if err := rows.Scan(&r.ID, &r.Name, &r.DID, &r.Destination, &r.Enabled); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Routes) CreateInbound(ctx context.Context, r InboundRoute) (int64, error) {
	if err := validateRoute(r.Name, r.DID, ""); err != nil {
		return 0, err
	}
	if r.Destination == "" {
		return 0, fmt.Errorf("destination is required")
	}
	var id int64
	err := s.pool.QueryRow(ctx, `
		INSERT INTO tpbx_inbound_routes (name, did, destination, enabled)
		VALUES ($1,$2,$3,$4) RETURNING id`,
		r.Name, r.DID, r.Destination, r.Enabled).Scan(&id)
	return id, err
}

func (s *Routes) UpdateInbound(ctx context.Context, r InboundRoute) error {
	if err := validateRoute(r.Name, r.DID, ""); err != nil {
		return err
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE tpbx_inbound_routes SET name=$2, did=$3, destination=$4, enabled=$5 WHERE id=$1`,
		r.ID, r.Name, r.DID, r.Destination, r.Enabled)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Routes) DeleteInbound(ctx context.Context, id int64) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM tpbx_inbound_routes WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// GenerateDialplan compiles all enabled routes into the [tpbx-outbound] and
// [tpbx-inbound] contexts. from-internal includes tpbx-outbound; from-trunk
// includes tpbx-inbound (wired in extensions.conf by install.sh). Both contexts
// are always emitted (even if empty) so the include targets exist.
func (s *Routes) GenerateDialplan(ctx context.Context) (string, error) {
	out, err := s.ListOutbound(ctx)
	if err != nil {
		return "", err
	}
	in, err := s.ListInbound(ctx)
	if err != nil {
		return "", err
	}

	var b strings.Builder
	b.WriteString("; extensions_tpbx.conf -- GENERATED by XeloVoice from the routing tables.\n")
	b.WriteString("; DO NOT EDIT: this file is overwritten on every routing change.\n")
	b.WriteString(";\n")
	b.WriteString("; XeloVoice is designed and developed by Xelocorp, and is one of the products\n")
	b.WriteString("; of Xelocorp. Do not resell or modify this software without official\n")
	b.WriteString("; confirmation from Xelocorp.\n\n")

	b.WriteString("[tpbx-outbound]\n")
	for _, r := range out {
		if !r.Enabled {
			continue
		}
		if r.DestType == "ivr" {
			// Send the caller into the named auto-attendant. Goto transfers
			// control, so no trailing Dial/Hangup is needed.
			fmt.Fprintf(&b, "exten => %s,1,NoOp(TPBX out %s to IVR %s)\n",
				sanitizePattern(r.Pattern), sanitizeField(r.Name), sanitizeField(r.IVR))
			fmt.Fprintf(&b, " same => n,Goto(tpbx-ivr-%s,s,1)\n", sanitizeField(r.IVR))
			continue
		}
		num := "${EXTEN}"
		if r.Strip > 0 {
			num = fmt.Sprintf("${EXTEN:%d}", r.Strip)
		}
		num = sanitizeField(r.Prepend) + num
		fmt.Fprintf(&b, "exten => %s,1,NoOp(TPBX out %s via %s)\n",
			sanitizePattern(r.Pattern), sanitizeField(r.Name), sanitizeField(r.Trunk))
		if r.CallerID != "" {
			fmt.Fprintf(&b, " same => n,Set(CALLERID(num)=%s)\n", sanitizeField(r.CallerID))
		}
		fmt.Fprintf(&b, " same => n,Dial(PJSIP/%s@%s,60)\n", num, sanitizeField(r.Trunk))
		b.WriteString(" same => n,Hangup()\n")
	}
	b.WriteString("\n[tpbx-inbound]\n")
	for _, r := range in {
		if !r.Enabled {
			continue
		}
		fmt.Fprintf(&b, "exten => %s,1,NoOp(TPBX in %s)\n",
			sanitizePattern(r.DID), sanitizeField(r.Name))
		// A destination of the form "type:value" (e.g. ivr:main) -- or the bare
		// keyword "hangup" -- routes via ivrDestLines; any other bare value dials
		// the extension.
		if strings.Contains(r.Destination, ":") || r.Destination == "hangup" {
			for _, line := range ivrDestLines(r.Destination) {
				fmt.Fprintf(&b, " same => n,%s\n", line)
			}
		} else {
			fmt.Fprintf(&b, " same => n,Dial(PJSIP/%s,60)\n", sanitizeField(r.Destination))
			b.WriteString(" same => n,Hangup()\n")
		}
	}
	return b.String(), nil
}

// validateOutbound checks an outbound route according to its destination type:
// a trunk route needs a valid trunk; an IVR route needs a valid menu name.
func validateOutbound(r OutboundRoute) error {
	if strings.TrimSpace(r.Name) == "" {
		return fmt.Errorf("name is required")
	}
	if strings.TrimSpace(r.Pattern) == "" {
		return fmt.Errorf("pattern is required")
	}
	if strings.ContainsAny(r.Name, "\n\r,") {
		return fmt.Errorf("name contains invalid characters")
	}
	switch r.DestType {
	case "ivr":
		if strings.TrimSpace(r.IVR) == "" {
			return fmt.Errorf("an IVR menu is required for an IVR route")
		}
		return validateID(r.IVR)
	default: // trunk
		if strings.TrimSpace(r.Trunk) == "" {
			return fmt.Errorf("a trunk is required for a trunk route")
		}
		return validateID(r.Trunk)
	}
}

// validateRoute enforces a safe character set so generated dialplan can't be
// broken or injected. trunk may be empty (inbound routes).
func validateRoute(name, pattern, trunk string) error {
	if strings.TrimSpace(name) == "" {
		return fmt.Errorf("name is required")
	}
	if strings.TrimSpace(pattern) == "" {
		return fmt.Errorf("pattern/DID is required")
	}
	if strings.ContainsAny(name, "\n\r,") {
		return fmt.Errorf("name contains invalid characters")
	}
	if trunk != "" {
		if err := validateID(trunk); err != nil {
			return err
		}
	}
	return nil
}

// sanitizePattern keeps only characters valid in an Asterisk extension pattern.
func sanitizePattern(s string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= '0' && r <= '9',
			r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z',
			r == '_' || r == '.' || r == '!' || r == '[' || r == ']' || r == '-' || r == 'X' || r == 'N' || r == 'Z' || r == '+' || r == '*' || r == '#':
			return r
		default:
			return -1
		}
	}, s)
}

// sanitizeField strips characters that could break a dialplan line.
func sanitizeField(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == ',' || r == ')' || r == '(' {
			return -1
		}
		return r
	}, s)
}
