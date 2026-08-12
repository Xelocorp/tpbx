package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PJSIPSettings holds the global res_pjsip options and TLS defaults managed from
// the console's PJSIP Settings panel. The Asterisk-supported [global]/[system]
// keys are compiled into a generated include; the remaining fields are honoured
// by the backend (e.g. TLS defaults applied to TLS transports).
type PJSIPSettings struct {
	AllowTransportsReload        bool   `json:"allowTransportsReload"`
	EnableDebug                  bool   `json:"enableDebug"`
	KeepAliveInterval            int    `json:"keepAliveInterval"`
	ContactCallerID              bool   `json:"contactCallerId"`
	TaskprocessorOverloadTrigger string `json:"taskprocessorOverloadTrigger"` // global | pjsip_only | none
	EndpointIdentifierOrder      string `json:"endpointIdentifierOrder"`      // csv, e.g. "ip,username,anonymous"

	CertName     string `json:"certName"`  // label of the certificate to use (informational)
	TLSMethod    string `json:"tlsMethod"` // sslv23 | tlsv1 | tlsv1_1 | tlsv1_2 | tlsv1_3
	VerifyClient bool   `json:"verifyClient"`
	VerifyServer bool   `json:"verifyServer"`
}

// TLSDefaults is the subset of PJSIP settings the transports generator applies
// to TLS transports that do not override them.
type TLSDefaults struct {
	Method       string
	VerifyClient bool
	VerifyServer bool
}

var validOverloadTriggers = map[string]bool{"global": true, "pjsip_only": true, "none": true}
var validTLSMethods = map[string]bool{
	"unspecified": true, "tlsv1": true, "tlsv1_1": true, "tlsv1_2": true, "tlsv1_3": true, "sslv23": true,
}

// PJSIPSettingsStore reads and writes the single global settings row.
type PJSIPSettingsStore struct {
	pool *pgxpool.Pool
}

// NewPJSIPSettings returns a store bound to a connection pool.
func NewPJSIPSettings(pool *pgxpool.Pool) *PJSIPSettingsStore {
	return &PJSIPSettingsStore{pool: pool}
}

const pjsipSettingsCols = `allow_transports_reload, enable_debug, keep_alive_interval,
	contact_caller_id, taskprocessor_overload_trigger, endpoint_identifier_order,
	cert_name, tls_method, verify_client, verify_server`

// Get returns the current settings, seeding the singleton row if absent.
func (s *PJSIPSettingsStore) Get(ctx context.Context) (PJSIPSettings, error) {
	var p PJSIPSettings
	err := s.pool.QueryRow(ctx, `SELECT `+pjsipSettingsCols+` FROM tpbx_pjsip_settings WHERE id=1`).
		Scan(&p.AllowTransportsReload, &p.EnableDebug, &p.KeepAliveInterval,
			&p.ContactCallerID, &p.TaskprocessorOverloadTrigger, &p.EndpointIdentifierOrder,
			&p.CertName, &p.TLSMethod, &p.VerifyClient, &p.VerifyServer)
	if err != nil {
		// Row missing (fresh DB race) — insert defaults and retry once.
		if _, ierr := s.pool.Exec(ctx, `INSERT INTO tpbx_pjsip_settings (id) VALUES (1) ON CONFLICT DO NOTHING`); ierr == nil {
			return s.get(ctx)
		}
		return p, err
	}
	return p, nil
}

func (s *PJSIPSettingsStore) get(ctx context.Context) (PJSIPSettings, error) {
	var p PJSIPSettings
	err := s.pool.QueryRow(ctx, `SELECT `+pjsipSettingsCols+` FROM tpbx_pjsip_settings WHERE id=1`).
		Scan(&p.AllowTransportsReload, &p.EnableDebug, &p.KeepAliveInterval,
			&p.ContactCallerID, &p.TaskprocessorOverloadTrigger, &p.EndpointIdentifierOrder,
			&p.CertName, &p.TLSMethod, &p.VerifyClient, &p.VerifyServer)
	return p, err
}

// Save validates and persists the settings.
func (s *PJSIPSettingsStore) Save(ctx context.Context, p PJSIPSettings) error {
	if p.KeepAliveInterval < 0 || p.KeepAliveInterval > 3600 {
		return fmt.Errorf("keep-alive interval must be between 0 and 3600 seconds")
	}
	if p.TaskprocessorOverloadTrigger == "" {
		p.TaskprocessorOverloadTrigger = "pjsip_only"
	}
	if !validOverloadTriggers[p.TaskprocessorOverloadTrigger] {
		return fmt.Errorf("taskprocessor overload trigger must be global, pjsip_only or none")
	}
	if p.TLSMethod == "" {
		p.TLSMethod = "tlsv1_2"
	}
	if !validTLSMethods[p.TLSMethod] {
		return fmt.Errorf("unknown TLS method %q", p.TLSMethod)
	}
	if p.EndpointIdentifierOrder == "" {
		p.EndpointIdentifierOrder = "ip,username,anonymous"
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE tpbx_pjsip_settings SET
			allow_transports_reload=$1, enable_debug=$2, keep_alive_interval=$3,
			contact_caller_id=$4, taskprocessor_overload_trigger=$5,
			endpoint_identifier_order=$6, cert_name=$7, tls_method=$8,
			verify_client=$9, verify_server=$10
		 WHERE id=1`,
		p.AllowTransportsReload, p.EnableDebug, p.KeepAliveInterval,
		p.ContactCallerID, p.TaskprocessorOverloadTrigger, p.EndpointIdentifierOrder,
		p.CertName, p.TLSMethod, p.VerifyClient, p.VerifyServer)
	return err
}

// TLSDefaults returns the TLS transport defaults derived from the settings.
func (s *PJSIPSettingsStore) TLSDefaults(ctx context.Context) TLSDefaults {
	p, err := s.Get(ctx)
	if err != nil {
		return TLSDefaults{Method: "tlsv1_2"}
	}
	return TLSDefaults{Method: p.TLSMethod, VerifyClient: p.VerifyClient, VerifyServer: p.VerifyServer}
}

func yesno(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

// GenerateConfig renders the res_pjsip [global] and [system] sections into the
// include file Asterisk loads. Only options Asterisk actually accepts in those
// sections are emitted; the remaining UI settings (TLS defaults, contact caller
// ID) are applied elsewhere and noted here for the reader.
func (s *PJSIPSettingsStore) GenerateConfig(ctx context.Context) (string, error) {
	p, err := s.Get(ctx)
	if err != nil {
		return "", err
	}

	var b strings.Builder
	b.WriteString("; pjsip_globals.conf -- GENERATED BY XeloVoice. Do not edit by hand.\n")
	b.WriteString("; Managed from the console (Settings -> PJSIP): regenerated on every change\n")
	b.WriteString("; and on service start.\n")
	b.WriteString(";\n")
	b.WriteString("; XeloVoice is designed and developed by Xelocorp, and is one of the products\n")
	b.WriteString("; of Xelocorp. Do not resell or modify this software without official\n")
	b.WriteString("; confirmation from Xelocorp.\n\n")

	b.WriteString("[global]\ntype=global\n")
	fmt.Fprintf(&b, "debug=%s\n", yesno(p.EnableDebug))
	fmt.Fprintf(&b, "keep_alive_interval=%d\n", p.KeepAliveInterval)
	if order := strings.TrimSpace(p.EndpointIdentifierOrder); order != "" {
		fmt.Fprintf(&b, "endpoint_identifier_order=%s\n", order)
	}
	fmt.Fprintf(&b, "taskprocessor_overload_trigger=%s\n", p.TaskprocessorOverloadTrigger)
	if p.ContactCallerID {
		b.WriteString("; contact caller-id is applied on endpoints (send_rpid), not [global].\n")
	}

	return b.String(), nil
}
