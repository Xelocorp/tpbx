package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/td425/tpbx/internal/store"
)

// handleListRoles returns all console roles plus the catalogue of features and
// actions the editor renders its permission matrix from.
func (s *Server) handleListRoles(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	roles, err := s.Roles.List(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"roles":    roles,
		"features": store.Features,
		"actions":  store.Actions,
	})
}

// roleBody is the JSON shape for creating/updating a role.
type roleBody struct {
	Name        string            `json:"name"`
	DisplayName string            `json:"displayName"`
	Permissions store.Permissions `json:"permissions"`
	RequireTOTP bool              `json:"requireTotp"`
}

func (s *Server) handleCreateRole(w http.ResponseWriter, r *http.Request) {
	var body roleBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	err := s.Roles.Create(ctx, store.Role{
		Name:        body.Name,
		DisplayName: body.DisplayName,
		Permissions: body.Permissions,
		RequireTOTP: body.RequireTOTP,
	})
	if err != nil {
		writeExtError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"status": "created", "name": body.Name})
}

func (s *Server) handleUpdateRole(w http.ResponseWriter, r *http.Request) {
	var body roleBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	body.Name = chi.URLParam(r, "name")
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	err := s.Roles.Update(ctx, store.Role{
		Name:        body.Name,
		DisplayName: body.DisplayName,
		Permissions: body.Permissions,
		RequireTOTP: body.RequireTOTP,
	})
	if err != nil {
		writeExtError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "updated", "name": body.Name})
}

func (s *Server) handleDeleteRole(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := s.Roles.Delete(ctx, chi.URLParam(r, "name")); err != nil {
		writeExtError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
