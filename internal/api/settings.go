package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/td425/tpbx/internal/store"
)

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
