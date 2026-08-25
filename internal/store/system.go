package store

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// System holds global, admin-editable configuration that is not tied to a
// single subsystem: the public domain clients reach this PBX at, the brand
// name and default theme shown in the console. Keeping these in the database
// (rather than only in the installer's env file) means an operator can change
// the domain from the Settings page without an env edit + reinstall.
type System struct {
	pool *pgxpool.Pool
}

// NewSystem returns a System store bound to a connection pool.
func NewSystem(pool *pgxpool.Pool) *System {
	return &System{pool: pool}
}

// SystemSettings is the dashboard-editable global configuration.
type SystemSettings struct {
	PublicDomain string `json:"publicDomain"` // FQDN/IP agents reach; "" = derive from request
	BrandName    string `json:"brandName"`    // shown in the console title / tab
	DefaultTheme string `json:"defaultTheme"` // light | dark — default for users with no saved choice
	Timezone     string `json:"timezone"`     // IANA name, informational (display)
	SLASeconds   int    `json:"slaSeconds"`   // call-center service-level threshold (sec)
}

const systemCols = `public_domain, brand_name, default_theme, timezone, sla_seconds`

// Get returns the current settings, seeding the singleton row if absent.
func (s *System) Get(ctx context.Context) (SystemSettings, error) {
	c, err := s.get(ctx)
	if err != nil {
		if _, ierr := s.pool.Exec(ctx, `INSERT INTO tpbx_system_settings (id) VALUES (1) ON CONFLICT DO NOTHING`); ierr == nil {
			return s.get(ctx)
		}
		// Fall back to sane defaults rather than failing callers (e.g. the
		// softphone config or the public branding endpoint).
		return SystemSettings{BrandName: "XeloVoice", DefaultTheme: "dark", Timezone: "UTC", SLASeconds: 20}, nil
	}
	if c.SLASeconds <= 0 {
		c.SLASeconds = 20
	}
	return c, nil
}

func (s *System) get(ctx context.Context) (SystemSettings, error) {
	var c SystemSettings
	err := s.pool.QueryRow(ctx, `SELECT `+systemCols+` FROM tpbx_system_settings WHERE id=1`).
		Scan(&c.PublicDomain, &c.BrandName, &c.DefaultTheme, &c.Timezone, &c.SLASeconds)
	return c, err
}

// Update persists the settings (upserting the singleton row).
func (s *System) Update(ctx context.Context, c SystemSettings) error {
	c.PublicDomain = strings.TrimSpace(c.PublicDomain)
	c.BrandName = strings.TrimSpace(c.BrandName)
	if c.BrandName == "" {
		c.BrandName = "XeloVoice"
	}
	if c.DefaultTheme != "light" {
		c.DefaultTheme = "dark"
	}
	if strings.TrimSpace(c.Timezone) == "" {
		c.Timezone = "UTC"
	}
	if c.SLASeconds <= 0 {
		c.SLASeconds = 20
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO tpbx_system_settings
		    (id, public_domain, brand_name, default_theme, timezone, sla_seconds, updated_at)
		VALUES (1,$1,$2,$3,$4,$5, now())
		ON CONFLICT (id) DO UPDATE SET
		    public_domain=EXCLUDED.public_domain,
		    brand_name=EXCLUDED.brand_name,
		    default_theme=EXCLUDED.default_theme,
		    timezone=EXCLUDED.timezone,
		    sla_seconds=EXCLUDED.sla_seconds,
		    updated_at=now()`,
		c.PublicDomain, c.BrandName, c.DefaultTheme, c.Timezone, c.SLASeconds)
	return err
}

// SeedDomain sets public_domain from the install-time env value on first boot,
// but only when the stored value is still empty — so an admin who later clears
// or changes it from the UI is never overwritten by the env on restart.
func (s *System) SeedDomain(ctx context.Context, envDomain string) {
	envDomain = strings.TrimSpace(envDomain)
	if envDomain == "" {
		return
	}
	_, _ = s.pool.Exec(ctx, `
		INSERT INTO tpbx_system_settings (id, public_domain) VALUES (1,$1)
		ON CONFLICT (id) DO UPDATE SET public_domain=$1
		 WHERE tpbx_system_settings.public_domain = ''`, envDomain)
}
