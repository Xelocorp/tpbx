package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/td425/tpbx/internal/store"
)

func (s *Server) handleListIVRs(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	list, err := s.IVRs.List(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ivrs": list})
}

func (s *Server) handleGetIVR(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid id"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	v, err := s.IVRs.Get(ctx, id)
	if err != nil {
		writeExtError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) handleCreateIVR(w http.ResponseWriter, r *http.Request) {
	var v store.IVR
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32768)).Decode(&v); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	id, err := s.IVRs.Create(ctx, v)
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

func (s *Server) handleUpdateIVR(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid id"})
		return
	}
	var v store.IVR
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32768)).Decode(&v); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	v.ID = id
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.IVRs.Update(ctx, v); err != nil {
		writeExtError(w, err)
		return
	}
	if err := s.applyDialplan(ctx); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "saved but dialplan apply failed: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

func (s *Server) handleDeleteIVR(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid id"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.IVRs.Delete(ctx, id); err != nil {
		writeExtError(w, err)
		return
	}
	if err := s.applyDialplan(ctx); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "deleted but dialplan apply failed: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
