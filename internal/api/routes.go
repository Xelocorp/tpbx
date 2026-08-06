package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/td425/tpbx/internal/store"
)

// applyDialplan regenerates the routing dialplan from the route tables, writes
// it to the included file, and reloads Asterisk's dialplan. The file lives in
// the service's own writable state dir, so no elevated permissions are needed.
// The reload is best-effort; a write failure is reported to the caller.
func (s *Server) applyDialplan(ctx context.Context) error {
	content, err := s.Routes.GenerateDialplan(ctx)
	if err != nil {
		return err
	}
	// Append the IVR menu contexts so inbound routes can target them.
	if s.IVRs != nil {
		if ivr, ierr := s.IVRs.GenerateDialplan(ctx); ierr == nil {
			content += ivr
		} else {
			slog.Warn("generate IVR dialplan", "err", ierr)
		}
	}
	if s.DialplanFile != "" {
		if err := os.WriteFile(s.DialplanFile, []byte(content), 0o644); err != nil {
			return err
		}
	}
	if err := s.ARI.ReloadModule(ctx, "pbx_config.so"); err != nil {
		slog.Warn("dialplan reload failed", "err", err)
	}
	return nil
}

func pathID(r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	return id, err == nil
}

// --- Outbound routes ---------------------------------------------------------

func (s *Server) handleListOutbound(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	list, err := s.Routes.ListOutbound(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"routes": list})
}

func (s *Server) handleCreateOutbound(w http.ResponseWriter, r *http.Request) {
	var rt store.OutboundRoute
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&rt); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	id, err := s.Routes.CreateOutbound(ctx, rt)
	if err != nil {
		writeExtError(w, err)
		return
	}
	if err := s.applyDialplan(ctx); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "saved but dialplan apply failed: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"status": "created", "id": id})
}

func (s *Server) handleUpdateOutbound(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid id"})
		return
	}
	var rt store.OutboundRoute
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&rt); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	rt.ID = id
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.Routes.UpdateOutbound(ctx, rt); err != nil {
		writeExtError(w, err)
		return
	}
	if err := s.applyDialplan(ctx); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "saved but dialplan apply failed: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

func (s *Server) handleDeleteOutbound(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid id"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.Routes.DeleteOutbound(ctx, id); err != nil {
		writeExtError(w, err)
		return
	}
	if err := s.applyDialplan(ctx); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "deleted but dialplan apply failed: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// --- Inbound routes ----------------------------------------------------------

func (s *Server) handleListInbound(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	list, err := s.Routes.ListInbound(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"routes": list})
}

func (s *Server) handleCreateInbound(w http.ResponseWriter, r *http.Request) {
	var rt store.InboundRoute
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&rt); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	id, err := s.Routes.CreateInbound(ctx, rt)
	if err != nil {
		writeExtError(w, err)
		return
	}
	if err := s.applyDialplan(ctx); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "saved but dialplan apply failed: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"status": "created", "id": id})
}

func (s *Server) handleUpdateInbound(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid id"})
		return
	}
	var rt store.InboundRoute
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&rt); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	rt.ID = id
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.Routes.UpdateInbound(ctx, rt); err != nil {
		writeExtError(w, err)
		return
	}
	if err := s.applyDialplan(ctx); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "saved but dialplan apply failed: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

func (s *Server) handleDeleteInbound(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid id"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.Routes.DeleteInbound(ctx, id); err != nil {
		writeExtError(w, err)
		return
	}
	if err := s.applyDialplan(ctx); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "deleted but dialplan apply failed: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
