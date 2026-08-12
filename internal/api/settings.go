package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"time"

	"github.com/td425/tpbx/internal/store"
)

// handleGetSystemSettings returns the global system/branding settings (admin).
func (s *Server) handleGetSystemSettings(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	cfg, err := s.System.Get(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// envDomain lets the UI show what the domain would fall back to if the
	// stored value were cleared (the install-time TPBX_DOMAIN).
	writeJSON(w, http.StatusOK, map[string]any{"settings": cfg, "envDomain": s.Domain})
}

// handleUpdateSystemSettings persists the global system/branding settings.
func (s *Server) handleUpdateSystemSettings(w http.ResponseWriter, r *http.Request) {
	var cfg store.SystemSettings
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&cfg); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.System.Update(ctx, cfg); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "saved"})
}

// handleGetInfra returns the read-only infrastructure config (DB URL, ARI/AMI,
// file paths) for display on the System tab. Secrets are masked here so they
// never reach the browser: the DB password becomes "***" and ARI/AMI passwords
// are not included at all.
func (s *Server) handleGetInfra(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"httpAddr":       s.Infra.HTTPAddr,
		"databaseUrl":    maskDBPassword(s.Infra.DatabaseURL),
		"ariUrl":         s.Infra.ARIURL,
		"ariUser":        s.Infra.ARIUser,
		"amiAddr":        s.Infra.AMIAddr,
		"amiUser":        s.Infra.AMIUser,
		"asteriskConf":   s.Infra.AsteriskConf,
		"dialplanFile":   s.Infra.DialplanFile,
		"transportsFile": s.Infra.TransportsFile,
		"pjsipFile":      s.Infra.PJSIPFile,
		"soundsDir":      s.Infra.SoundsDir,
		"wssPort":        s.Infra.WSSPort,
	})
}

// handleBranding is a public (no-auth) endpoint returning just the brand name
// and default theme, so the login screen and initial theme can be applied
// before a session exists. It deliberately exposes nothing sensitive.
func (s *Server) handleBranding(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	cfg, _ := s.System.Get(ctx) // Get never errors; falls back to defaults
	writeJSON(w, http.StatusOK, map[string]any{
		"brandName":    cfg.BrandName,
		"defaultTheme": cfg.DefaultTheme,
	})
}

// maskDBPassword replaces the password in a libpq/pgx URL with "***" so the
// connection string can be displayed without leaking the credential.
func maskDBPassword(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.User == nil {
		return raw
	}
	if _, hasPw := u.User.Password(); hasPw {
		u.User = url.UserPassword(u.User.Username(), "***")
	}
	return u.String()
}

// handleGetWebRTCSettings returns the current WebRTC/TURN configuration (admin).
func (s *Server) handleGetWebRTCSettings(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	cfg, err := s.Settings.GetWebRTC(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// Report whether a built-in coturn secret is provisioned so the UI can
	// warn when "builtin" mode is selected without one. The secret itself is
	// never sent to the browser.
	writeJSON(w, http.StatusOK, map[string]any{
		"settings":     cfg,
		"builtinReady": s.TURNSecret != "",
	})
}

// handleUpdateWebRTCSettings persists the WebRTC/TURN configuration (admin).
func (s *Server) handleUpdateWebRTCSettings(w http.ResponseWriter, r *http.Request) {
	var cfg store.WebRTCSettings
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&cfg); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.Settings.UpdateWebRTC(ctx, cfg); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "saved"})
}
