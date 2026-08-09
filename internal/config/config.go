// Package config loads TPBX runtime configuration from environment variables.
//
// Everything the GUI backend needs to reach Postgres, Asterisk ARI and
// Asterisk AMI is expressed as an environment variable so the same binary can
// run under systemd, in a container, or from a shell during development.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config is the fully-resolved runtime configuration.
type Config struct {
	// HTTP is the address the GUI/API server listens on, e.g. ":8080".
	HTTPAddr string

	// DatabaseURL is a libpq/pgx connection string for PostgreSQL. This is the
	// same database Asterisk reads its realtime configuration and writes its
	// CDR/CEL rows to.
	DatabaseURL string

	// ARI connection details (Asterisk REST Interface).
	ARI ARIConfig

	// AMI connection details (Asterisk Manager Interface).
	AMI AMIConfig

	// AsteriskConfDir is where the backend writes managed include files that
	// cannot live in realtime (pjsip transports, TLS, WebRTC). Typically
	// /etc/asterisk.
	AsteriskConfDir string

	// DialplanFile is the generated routing dialplan that Asterisk #includes.
	// It lives under the service's own writable state dir (not /etc), so the
	// unprivileged service can rewrite it without special permissions.
	DialplanFile string

	// TransportsFile is the generated PJSIP transports include that Asterisk
	// loads. Like the dialplan it lives under the writable state dir, because
	// systemd's ProtectSystem=full makes /etc read-only for the service.
	TransportsFile string

	// Domain is the public FQDN clients reach this PBX at (WSS signalling and
	// TURN). Empty means "derive from the request host", so a bare-IP install
	// still works; a real domain is needed for browser-trusted TLS.
	Domain string

	// SoundsDir is where the GUI stores uploaded IVR prompt files. It must sit
	// under Asterisk's sounds tree for a given language so that a prompt saved
	// here as "<name>.wav" can be played with Background(<SoundsPrefix>/<name>).
	// Default: /var/lib/asterisk/sounds/en/tpbx (language "en", prefix "tpbx").
	SoundsDir string

	// SoundsPrefix is the sub-path (relative to the language dir) that SoundsDir
	// maps to, used when referencing an uploaded prompt in the dialplan.
	SoundsPrefix string

	// WebRTC holds the parameters the agent softphone needs: the secure
	// WebSocket signalling endpoint and the ICE (STUN/TURN) configuration.
	WebRTC WebRTCConfig
}

// WebRTCConfig describes how browser softphones reach signalling and media.
type WebRTCConfig struct {
	// WSSPort is the port Asterisk's secure WebSocket (res_http_websocket)
	// listens on; the browser connects to wss://<host>:<WSSPort>/ws.
	WSSPort string

	// TURNSecret is coturn's static-auth-secret. The backend mints short-lived
	// HMAC credentials from it (TURN REST API) so the secret never leaves the
	// server. Empty disables TURN (STUN-only, which will not traverse strict NAT).
	TURNSecret string

	// TURNTTL is how long a minted TURN credential is valid.
	TURNTTL time.Duration
}

// ARIConfig describes how to reach the Asterisk REST Interface.
type ARIConfig struct {
	BaseURL  string // e.g. http://127.0.0.1:8088
	Username string
	Password string
	AppName  string // Stasis application name to subscribe to
}

// AMIConfig describes how to reach the Asterisk Manager Interface.
type AMIConfig struct {
	Addr     string // host:port, e.g. 127.0.0.1:5038
	Username string
	Password string
	Timeout  time.Duration
}

// Load reads configuration from the environment, applying sane defaults for
// a single-VM install where Asterisk and the GUI run on the same host.
func Load() (*Config, error) {
	cfg := &Config{
		HTTPAddr:        env("TPBX_HTTP_ADDR", ":8080"),
		DatabaseURL:     env("TPBX_DATABASE_URL", "postgres://tpbx:tpbx@127.0.0.1:5432/tpbx?sslmode=disable"),
		AsteriskConfDir: env("TPBX_ASTERISK_CONF_DIR", "/etc/asterisk"),
		DialplanFile:    env("TPBX_DIALPLAN_FILE", "/var/lib/tpbx/extensions_tpbx.conf"),
		TransportsFile:  env("TPBX_TRANSPORTS_FILE", "/var/lib/tpbx/pjsip_transports.conf"),
		Domain:          env("TPBX_DOMAIN", ""),
		SoundsDir:       env("TPBX_SOUNDS_DIR", "/var/lib/asterisk/sounds/en/tpbx"),
		SoundsPrefix:    env("TPBX_SOUNDS_PREFIX", "tpbx"),
		WebRTC: WebRTCConfig{
			WSSPort:    env("TPBX_SIP_WSS_PORT", "8089"),
			TURNSecret: env("TPBX_TURN_SECRET", ""),
			TURNTTL:    envDuration("TPBX_TURN_TTL", time.Hour),
		},
		ARI: ARIConfig{
			BaseURL:  env("TPBX_ARI_URL", "http://127.0.0.1:8088"),
			Username: env("TPBX_ARI_USER", "tpbx"),
			Password: env("TPBX_ARI_PASS", "tpbx"),
			AppName:  env("TPBX_ARI_APP", "tpbx"),
		},
		AMI: AMIConfig{
			Addr:     env("TPBX_AMI_ADDR", "127.0.0.1:5038"),
			Username: env("TPBX_AMI_USER", "tpbx"),
			Password: env("TPBX_AMI_PASS", "tpbx"),
			Timeout:  envDuration("TPBX_AMI_TIMEOUT", 10*time.Second),
		},
	}
	if cfg.DatabaseURL == "" {
		return nil, fmt.Errorf("TPBX_DATABASE_URL must be set")
	}
	return cfg, nil
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
		// Allow a bare integer to mean seconds.
		if n, err := strconv.Atoi(v); err == nil {
			return time.Duration(n) * time.Second
		}
	}
	return def
}
