package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/td425/tpbx/internal/store"
)

// applyTransports regenerates the PJSIP transports include from the transport
// table and writes it to the service-writable state file that Asterisk
// #includes. A `pjsip reload` is issued best-effort: it picks up non-bind
// attribute changes immediately, but bind changes only take effect after a
// full Asterisk restart (which the console offers via handleRestartAsterisk).
func (s *Server) applyTransports(ctx context.Context) error {
	content, err := s.Transports.GenerateConfig(ctx)
	if err != nil {
		return err
	}
	if s.TransportsFile != "" {
		if err := os.WriteFile(s.TransportsFile, []byte(content), 0o644); err != nil {
			return err
		}
	}
	if err := s.ARI.ReloadModule(ctx, "res_pjsip.so"); err != nil {
		slog.Warn("pjsip reload failed", "err", err)
	}
	return nil
}

func (s *Server) handleListTransports(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	list, err := s.Transports.List(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"transports": list})
}

func (s *Server) handleGetTransport(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	t, err := s.Transports.Get(ctx, chi.URLParam(r, "name"))
	if err != nil {
		writeExtError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *Server) handleCreateTransport(w http.ResponseWriter, r *http.Request) {
	var t store.Transport
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&t); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.Transports.Create(ctx, t); err != nil {
		writeExtError(w, err)
		return
	}
	if err := s.applyTransports(ctx); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "saved but apply failed: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"status": "created", "restartRequired": true})
}

func (s *Server) handleUpdateTransport(w http.ResponseWriter, r *http.Request) {
	var t store.Transport
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&t); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	t.Name = chi.URLParam(r, "name")
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.Transports.Update(ctx, t); err != nil {
		writeExtError(w, err)
		return
	}
	if err := s.applyTransports(ctx); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "saved but apply failed: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "updated", "restartRequired": true})
}

func (s *Server) handleDeleteTransport(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.Transports.Delete(ctx, chi.URLParam(r, "name")); err != nil {
		writeExtError(w, err)
		return
	}
	if err := s.applyTransports(ctx); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "deleted but apply failed: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "deleted", "restartRequired": true})
}

// handleRestartAsterisk performs a full Asterisk restart so transport bind
// changes take effect. This briefly drops SIP service and any active calls, so
// the console gates it behind an explicit, clearly-warned action.
func (s *Server) handleRestartAsterisk(w http.ResponseWriter, r *http.Request) {
	if s.RestartAsterisk == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "restart is not available in this deployment"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if err := s.RestartAsterisk(ctx); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "restarting"})
}
