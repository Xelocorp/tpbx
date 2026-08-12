package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/td425/tpbx/internal/store"
)

const sessionCookie = "tpbx_session"

type ctxKey string

const sessionKey ctxKey = "session"

// sessionFrom returns the authenticated session on the request context.
func sessionFrom(r *http.Request) store.Session {
	if s, ok := r.Context().Value(sessionKey).(store.Session); ok {
		return s
	}
	return store.Session{}
}

// requireAuth rejects requests without a valid session cookie, and stashes the
// resolved session on the context for downstream handlers.
func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(sessionCookie)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication required"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		sess, ok := s.Users.LookupSession(ctx, c.Value)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "session expired"})
			return
		}
		// If the user's role mandates two-factor but they have not enrolled,
		// fence them to the enrolment endpoints until they do. This makes the
		// per-role "require TOTP" toggle actually binding, not just advisory.
		if !sess.TOTPEnabled && !totpSetupAllowed(r.URL.Path) && s.Roles.RequiresTOTP(ctx, sess.Role) {
			writeJSON(w, http.StatusForbidden, map[string]any{
				"error":             "two-factor setup required",
				"totpSetupRequired": true,
			})
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), sessionKey, sess)))
	})
}

// totpSetupAllowed lists the endpoints a user forced into TOTP enrolment may
// still reach before completing it.
func totpSetupAllowed(path string) bool {
	switch path {
	case "/api/me", "/api/change-password", "/api/totp/enroll", "/api/totp/activate":
		return true
	}
	return false
}

// requireAdmin is layered on top of requireAuth for admin-only endpoints.
func (s *Server) requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if sessionFrom(r).Role != "admin" {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "admin role required"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// actionForMethod maps an HTTP method to one of the four permission actions
// (view/create/edit/delete). Read requests are "view"; writes map by verb.
func actionForMethod(method string) string {
	switch method {
	case http.MethodPost:
		return "create"
	case http.MethodPut, http.MethodPatch:
		return "edit"
	case http.MethodDelete:
		return "delete"
	default:
		return "view"
	}
}

// requirePerm gates a group of routes for one console feature. The action is
// derived from the HTTP method, so a GET needs the feature's "view" permission,
// a POST needs "create", PUT/PATCH "edit", DELETE "delete". The admin role
// always passes (handled inside Roles.Can).
func (s *Server) requirePerm(feature string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			sess := sessionFrom(r)
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			if !s.Roles.Can(ctx, sess.Role, feature, actionForMethod(r.Method)) {
				writeJSON(w, http.StatusForbidden, map[string]string{
					"error": "you do not have permission to " + actionForMethod(r.Method) + " " + feature,
				})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// audit logs mutating requests (POST/PUT/DELETE) that succeeded, recording who
// did what. Wrapped around the authenticated API routes.
func (s *Server) audit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			next.ServeHTTP(w, r)
			return
		}
		sw := &statusWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(sw, r)
		if sw.status >= 200 && sw.status < 300 {
			sess := sessionFrom(r)
			s.Users.Audit(context.Background(), sess.Username, r.Method+" "+r.URL.Path, "", clientIP(r))
		}
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func clientIP(r *http.Request) string {
	if f := r.Header.Get("X-Forwarded-For"); f != "" {
		return f
	}
	return r.RemoteAddr
}

// --- Handlers ---------------------------------------------------------------

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
		TOTPCode string `json:"totpCode"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()

	u, err := s.Users.Authenticate(ctx, body.Username, body.Password)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid username or password"})
		return
	}
	// If the account already has two-factor active, require a valid code. The
	// first request (no code) returns totpRequired so the UI can prompt for it
	// without treating it as a failed login.
	if u.TOTPEnabled {
		if body.TOTPCode == "" {
			writeJSON(w, http.StatusOK, map[string]any{"totpRequired": true})
			return
		}
		if !s.Users.VerifyTOTP(ctx, u.Username, body.TOTPCode) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid authentication code"})
			return
		}
	}
	token, err := s.Users.CreateSession(ctx, u)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(store.SessionTTL.Seconds()),
	})
	s.Users.Audit(ctx, u.Username, "login", "", clientIP(r))
	writeJSON(w, http.StatusOK, s.mePayload(ctx, u.Username, u.Role, u.TOTPEnabled))
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		s.Users.DeleteSession(r.Context(), c.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/", HttpOnly: true, MaxAge: -1,
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "logged out"})
}

// mePayload builds the identity + permission bundle the frontend uses to decide
// which nav items and action buttons to show. The admin role always reports
// full permissions on every feature. totpSetupRequired is true when the user's
// role mandates two-factor but they have not yet enrolled — the frontend then
// forces enrolment before showing the console.
func (s *Server) mePayload(ctx context.Context, username, role string, totpEnabled bool) map[string]any {
	perms := store.Permissions{}
	if role == "admin" {
		full := store.Perm{View: true, Create: true, Edit: true, Delete: true}
		for _, f := range store.Features {
			perms[f] = full
		}
	} else if rl, err := s.Roles.Get(ctx, role); err == nil {
		perms = rl.Permissions
	}
	return map[string]any{
		"username":          username,
		"role":              role,
		"permissions":       perms,
		"totpEnabled":       totpEnabled,
		"totpSetupRequired": !totpEnabled && s.Roles.RequiresTOTP(ctx, role),
	}
}

// handleMe returns the current session's user, or 401. The frontend calls this
// on load to decide whether to show the login screen.
func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r)
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	writeJSON(w, http.StatusOK, s.mePayload(ctx, sess.Username, sess.Role, sess.TOTPEnabled))
}

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.Users.ChangePassword(ctx, sessionFrom(r).Username, body.Password); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "password changed"})
}

// --- Admin user management ---------------------------------------------------

func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	users, err := s.Users.List(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": users})
}

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username    string `json:"username"`
		Password    string `json:"password"`
		Role        string `json:"role"`
		DisplayName string `json:"displayName"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if body.Role == "" {
		body.Role = "operator"
	}
	if _, err := s.Roles.Get(ctx, body.Role); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown role: " + body.Role})
		return
	}
	err := s.Users.Create(ctx, store.User{Username: body.Username, Role: body.Role, DisplayName: body.DisplayName}, body.Password)
	if err != nil {
		writeExtError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"status": "created", "username": body.Username})
}

// handleUpdateUser changes an existing user's role, display name and disabled
// flag. An admin cannot lock themselves out by demoting or disabling their own
// account.
func (s *Server) handleUpdateUser(w http.ResponseWriter, r *http.Request) {
	target := chi.URLParam(r, "username")
	var body struct {
		Role        string `json:"role"`
		DisplayName string `json:"displayName"`
		Disabled    bool   `json:"disabled"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if target == sessionFrom(r).Username && (body.Disabled || body.Role != "admin") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "you cannot demote or disable your own account"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if _, err := s.Roles.Get(ctx, body.Role); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown role: " + body.Role})
		return
	}
	err := s.Users.Update(ctx, store.User{
		Username:    target,
		Role:        body.Role,
		DisplayName: body.DisplayName,
		Disabled:    body.Disabled,
	})
	if err != nil {
		writeExtError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "updated", "username": target})
}

func (s *Server) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	target := chi.URLParam(r, "username")
	if target == sessionFrom(r).Username {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cannot delete your own account"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := s.Users.Delete(ctx, target); err != nil {
		writeExtError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (s *Server) handleResetUserPassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.Users.ChangePassword(ctx, chi.URLParam(r, "username"), body.Password); err != nil {
		writeExtError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "password reset"})
}
