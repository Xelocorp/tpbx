package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/td425/tpbx/internal/ari"
	"github.com/td425/tpbx/internal/store"
)

// apiTokenKey carries the authenticated token metadata on the request context.
const apiTokenKey ctxKey = "apiToken"

// apiTokenFrom returns the token that authenticated the current /api/v1 request.
func apiTokenFrom(r *http.Request) store.ApiToken {
	if t, ok := r.Context().Value(apiTokenKey).(store.ApiToken); ok {
		return t
	}
	return store.ApiToken{}
}

// extractAPIToken pulls the bearer token from the request. Three transports are
// accepted, in priority order:
//
//	Authorization: Bearer <token>   (preferred)
//	X-API-Token: <token>            (header)
//	?api_token=<token>              (SendQ-style query param, for quick tests)
func extractAPIToken(r *http.Request) string {
	if h := r.Header.Get("Authorization"); h != "" {
		if len(h) > 7 && strings.EqualFold(h[:7], "Bearer ") {
			return strings.TrimSpace(h[7:])
		}
	}
	if h := strings.TrimSpace(r.Header.Get("X-API-Token")); h != "" {
		return h
	}
	return strings.TrimSpace(r.URL.Query().Get("api_token"))
}

// requireAPIToken authenticates a machine-to-machine request against the
// tpbx_api_tokens table. It rejects missing, unknown, or revoked tokens and
// stashes the token metadata for handlers/auditing. This is the sole guard on
// the /api/v1 surface — it is independent of the browser session cookie.
func (s *Server) requireAPIToken(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.ApiTokens == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "api tokens are not configured"})
			return
		}
		tok := extractAPIToken(r)
		if tok == "" {
			w.Header().Set("WWW-Authenticate", `Bearer realm="tpbx", error="invalid_request"`)
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing API token"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		meta, ok := s.ApiTokens.Authenticate(ctx, tok)
		if !ok {
			w.Header().Set("WWW-Authenticate", `Bearer realm="tpbx", error="invalid_token"`)
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid or revoked API token"})
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), apiTokenKey, meta)))
	})
}

// noStore marks the JSON responses on the API as uncacheable — token-scoped data
// should never be stored by an intermediary.
func noStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
}

// --- v1 handlers ------------------------------------------------------------

// handleV1Ping is an auth check: it confirms a token works and echoes its name.
func (s *Server) handleV1Ping(w http.ResponseWriter, r *http.Request) {
	t := apiTokenFrom(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":    true,
		"token": t.Name,
		"time":  time.Now().UTC().Format(time.RFC3339),
	})
}

func (s *Server) handleV1ListExtensions(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	exts, err := s.Ext.List(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"extensions": exts})
}

func (s *Server) handleV1GetExtension(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	ext, err := s.Ext.Get(ctx, chi.URLParam(r, "id"))
	if err != nil {
		writeExtError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ext)
}

func (s *Server) handleV1CreateExtension(w http.ResponseWriter, r *http.Request) {
	var ext store.Extension
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&ext); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.Ext.Create(ctx, ext); err != nil {
		writeExtError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"status": "created", "id": ext.ID})
}

func (s *Server) handleV1DeleteExtension(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.Ext.Delete(ctx, chi.URLParam(r, "id")); err != nil {
		writeExtError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (s *Server) handleV1ListTrunks(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	trunks, err := s.Trunks.List(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"trunks": trunks})
}

// handleV1ReportsOverview returns the call-center KPI block for a window
// (?days=N or ?from=&to=), optionally scoped to a queue (?queue=) with a custom
// SLA (?sla=). This is the same computation the dashboard Overview uses.
func (s *Server) handleV1ReportsOverview(w http.ResponseWriter, r *http.Request) {
	from, to := parseWindow(r)
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	q := r.URL.Query()
	slaDefault := 20
	if sys, serr := s.System.Get(ctx); serr == nil && sys.SLASeconds > 0 {
		slaDefault = sys.SLASeconds
	}
	cc, err := s.Dashboard.CallCenterStats(ctx, from, to, q.Get("queue"), atoiDefault(q.Get("sla"), slaDefault))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"from":       from.Format(time.RFC3339),
		"to":         to.Format(time.RFC3339),
		"callcenter": cc,
	})
}

func (s *Server) handleV1ReportsQueues(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	writeJSON(w, http.StatusOK, map[string]any{"queues": s.Dashboard.QueueNames(ctx)})
}

func (s *Server) handleV1ReportsAgents(w http.ResponseWriter, r *http.Request) {
	from, to := parseWindow(r)
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	agents, err := s.Analytics.AgentStats(ctx, from, to)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"from":   from.Format(time.RFC3339),
		"to":     to.Format(time.RFC3339),
		"agents": agents,
	})
}

// handleV1Calls returns the live channel snapshot (active calls) from ARI.
func (s *Server) handleV1Calls(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	chans, err := s.ARI.Channels(ctx)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"channels": chans})
}

// handleV1Originate places a call. Same contract as the console's originate.
func (s *Server) handleV1Originate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Endpoint  string `json:"endpoint"`
		Extension string `json:"extension"`
		Context   string `json:"context"`
		CallerID  string `json:"callerId"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if body.Endpoint == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "endpoint is required"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	ch, err := s.ARI.Originate(ctx, ari.OriginateParams{
		Endpoint:  body.Endpoint,
		Extension: body.Extension,
		Context:   body.Context,
		CallerID:  body.CallerID,
	})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"channel": ch})
}

// handleV1Hangup terminates a live channel by id.
func (s *Server) handleV1Hangup(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "channel id is required"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.ARI.Hangup(ctx, id, r.URL.Query().Get("reason")); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "hung up", "channel": id})
}

// --- Token administration (browser console, under the "settings" feature) ----

func (s *Server) handleListAPITokens(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	toks, err := s.ApiTokens.List(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tokens": toks})
}

// handleCreateAPIToken mints a token and returns the plaintext exactly once.
func (s *Server) handleCreateAPIToken(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" {
		body.Name = "api-token"
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	plaintext, meta, err := s.ApiTokens.Create(ctx, body.Name, sessionFrom(r).Username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// The plaintext is only ever returned here.
	writeJSON(w, http.StatusCreated, map[string]any{"token": plaintext, "meta": meta})
}

// handleRevokeAPIToken disables a token permanently.
func (s *Server) handleRevokeAPIToken(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid token id"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.ApiTokens.Revoke(ctx, id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "revoked"})
}

// handleDeleteAPIToken removes a token row entirely.
func (s *Server) handleDeleteAPIToken(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid token id"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.ApiTokens.Delete(ctx, id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// handleAPIDocs serves the human-readable API reference (self-contained HTML,
// themed like the console). It is public so the "API docs" link opens without a
// session; it documents the endpoints but exposes no secrets.
func (s *Server) handleAPIDocs(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(apiDocsHTML))
}
