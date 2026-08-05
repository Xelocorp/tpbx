package store

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Transports is the store for PJSIP transports.
//
// Transports are load-time objects (res_pjsip reads them once at module start),
// so they cannot live in realtime. The desired set is kept in tpbx_transports
// and compiled by GenerateConfig into a static #include file that Asterisk
// loads. A bind change only takes effect after a full Asterisk restart.
type Transports struct {
	pool *pgxpool.Pool
}

// NewTransports returns a Transports store bound to a connection pool.
func NewTransports(pool *pgxpool.Pool) *Transports {
	return &Transports{pool: pool}
}

// Transport is the GUI-friendly view of one PJSIP transport.
type Transport struct {
	Name                     string `json:"name"`     // e.g. "transport-udp"
	Protocol                 string `json:"protocol"` // udp | tcp | tls | wss
	BindAddr                 string `json:"bindAddr"`
	BindPort                 int    `json:"bindPort"`
	TLSCertFile              string `json:"tlsCertFile"`
	TLSPrivKeyFile           string `json:"tlsPrivKeyFile"`
	TLSCaListFile            string `json:"tlsCaListFile"`
	TLSMethod                string `json:"tlsMethod"`
	ExternalMediaAddress     string `json:"externalMediaAddress"`
	ExternalSignalingAddress string `json:"externalSignalingAddress"`
	LocalNet                 string `json:"localNet"` // comma-separated CIDRs
	Enabled                  bool   `json:"enabled"`
	Position                 int    `json:"position"`
}

var validProtocols = map[string]bool{"udp": true, "tcp": true, "tls": true, "wss": true}

func (t *Transport) withDefaults() {
	if t.Protocol == "" {
		t.Protocol = "udp"
	}
	if t.BindAddr == "" {
		t.BindAddr = "0.0.0.0"
	}
	if t.TLSMethod == "" {
		t.TLSMethod = "tlsv1_2"
	}
	if t.BindPort <= 0 && t.Protocol != "wss" {
		switch t.Protocol {
		case "tls":
			t.BindPort = 5061
		default:
			t.BindPort = 5060
		}
	}
}

func (t *Transport) validate() error {
	if err := validateID(t.Name); err != nil {
		return err
	}
	if !validProtocols[t.Protocol] {
		return fmt.Errorf("protocol %q is not one of udp, tcp, tls, wss", t.Protocol)
	}
	if t.Protocol == "tls" && (t.TLSCertFile == "" || t.TLSPrivKeyFile == "") {
		return errors.New("a tls transport needs a certificate and private key")
	}
	return nil
}

const transportCols = `name, protocol, bind_addr, bind_port, tls_cert_file,
	tls_priv_key_file, tls_ca_list_file, tls_method, external_media_address,
	external_signaling_address, local_net, enabled, position`

func scanTransport(row pgx.Row) (Transport, error) {
	var t Transport
	err := row.Scan(&t.Name, &t.Protocol, &t.BindAddr, &t.BindPort, &t.TLSCertFile,
		&t.TLSPrivKeyFile, &t.TLSCaListFile, &t.TLSMethod, &t.ExternalMediaAddress,
		&t.ExternalSignalingAddress, &t.LocalNet, &t.Enabled, &t.Position)
	return t, err
}

// List returns all transports ordered by position then name.
func (s *Transports) List(ctx context.Context) ([]Transport, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+transportCols+`
		  FROM tpbx_transports ORDER BY position, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Transport{}
	for rows.Next() {
		t, err := scanTransport(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// Get returns a single transport by name.
func (s *Transports) Get(ctx context.Context, name string) (Transport, error) {
	t, err := scanTransport(s.pool.QueryRow(ctx, `SELECT `+transportCols+`
		  FROM tpbx_transports WHERE name=$1`, name))
	if errors.Is(err, pgx.ErrNoRows) {
		return t, ErrNotFound
	}
	return t, err
}

// Create inserts a new transport.
func (s *Transports) Create(ctx context.Context, t Transport) error {
	t.withDefaults()
	if err := t.validate(); err != nil {
		return err
	}
	var exists bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tpbx_transports WHERE name=$1)`, t.Name).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return ErrConflict
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO tpbx_transports (`+transportCols+`)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
		t.Name, t.Protocol, t.BindAddr, t.BindPort, t.TLSCertFile,
		t.TLSPrivKeyFile, t.TLSCaListFile, t.TLSMethod, t.ExternalMediaAddress,
		t.ExternalSignalingAddress, t.LocalNet, t.Enabled, t.Position)
	return err
}

// Update rewrites an existing transport.
func (s *Transports) Update(ctx context.Context, t Transport) error {
	t.withDefaults()
	if err := t.validate(); err != nil {
		return err
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE tpbx_transports SET
		    protocol=$2, bind_addr=$3, bind_port=$4, tls_cert_file=$5,
		    tls_priv_key_file=$6, tls_ca_list_file=$7, tls_method=$8,
		    external_media_address=$9, external_signaling_address=$10,
		    local_net=$11, enabled=$12, position=$13
		 WHERE name=$1`,
		t.Name, t.Protocol, t.BindAddr, t.BindPort, t.TLSCertFile,
		t.TLSPrivKeyFile, t.TLSCaListFile, t.TLSMethod, t.ExternalMediaAddress,
		t.ExternalSignalingAddress, t.LocalNet, t.Enabled, t.Position)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// Delete removes a transport by name.
func (s *Transports) Delete(ctx context.Context, name string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM tpbx_transports WHERE name=$1`, name)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// GenerateConfig renders the enabled transports into a PJSIP config file that
// Asterisk #includes. A ws/wss transport must NOT declare a bind: the WebSocket
// rides on Asterisk's built-in HTTP(S) listener (http.conf), and adding a bind
// here collides with it and breaks res_pjsip transport loading.
func (s *Transports) GenerateConfig(ctx context.Context) (string, error) {
	list, err := s.List(ctx)
	if err != nil {
		return "", err
	}

	var b strings.Builder
	b.WriteString("; pjsip_transports.conf -- GENERATED BY TPBX. Do not edit by hand.\n")
	b.WriteString("; Managed from the console (Transports / TLS page): regenerated on every\n")
	b.WriteString("; change and on service start. Bind changes need an Asterisk restart to\n")
	b.WriteString("; re-bind the listening sockets.\n")

	for _, t := range list {
		if !t.Enabled {
			continue
		}
		fmt.Fprintf(&b, "\n[%s]\ntype=transport\nprotocol=%s\n", t.Name, t.Protocol)

		// ws/wss ride on the HTTP(S) server -- never bind them here.
		if t.Protocol != "ws" && t.Protocol != "wss" {
			fmt.Fprintf(&b, "bind=%s:%d\n", t.BindAddr, t.BindPort)
		}
		if t.Protocol == "tls" {
			fmt.Fprintf(&b, "cert_file=%s\n", t.TLSCertFile)
			fmt.Fprintf(&b, "priv_key_file=%s\n", t.TLSPrivKeyFile)
			if t.TLSCaListFile != "" {
				fmt.Fprintf(&b, "ca_list_file=%s\n", t.TLSCaListFile)
			}
			if t.TLSMethod != "" {
				fmt.Fprintf(&b, "method=%s\n", t.TLSMethod)
			}
		}
		if t.ExternalMediaAddress != "" {
			fmt.Fprintf(&b, "external_media_address=%s\n", t.ExternalMediaAddress)
		}
		if t.ExternalSignalingAddress != "" {
			fmt.Fprintf(&b, "external_signaling_address=%s\n", t.ExternalSignalingAddress)
		}
		for _, cidr := range strings.Split(t.LocalNet, ",") {
			if cidr = strings.TrimSpace(cidr); cidr != "" {
				fmt.Fprintf(&b, "local_net=%s\n", cidr)
			}
		}
	}
	return b.String(), nil
}
