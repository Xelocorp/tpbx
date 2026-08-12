package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
)

// handleTOTPEnroll starts (or restarts) two-factor enrolment for the logged-in
// user: it mints a secret and returns the otpauth URI to render as a QR code.
// TOTP is not active until the user confirms a code via activate.
func (s *Server) handleTOTPEnroll(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	secret, uri, err := s.Users.BeginTOTPEnroll(ctx, sessionFrom(r).Username)
	if err != nil {
		writeExtError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"secret": secret, "otpauthUri": uri})
}

// handleTOTPActivate confirms enrolment with a code from the authenticator.
func (s *Server) handleTOTPActivate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.Users.ActivateTOTP(ctx, sessionFrom(r).Username, body.Code); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "two-factor enabled"})
}

// handleTOTPDisable turns off two-factor for the logged-in user. Roles that
// mandate TOTP cannot self-disable.
func (s *Server) handleTOTPDisable(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	sess := sessionFrom(r)
	if s.Roles.RequiresTOTP(ctx, sess.Role) {
		writeJSON(w, http.StatusForbidden, map[string]string{
			"error": "your role requires two-factor authentication; it cannot be disabled",
		})
		return
	}
	if err := s.Users.DisableTOTP(ctx, sess.Username, body.Code); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "two-factor disabled"})
}

// handleResetUserTOTP lets an admin clear a user's two-factor enrolment when
// they have lost their authenticator device.
func (s *Server) handleResetUserTOTP(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := s.Users.ResetTOTP(ctx, chi.URLParam(r, "username")); err != nil {
		writeExtError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "two-factor reset"})
}
