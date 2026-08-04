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
