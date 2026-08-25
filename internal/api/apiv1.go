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

// tenantScopeKey carries the resolved tenant (nil = global) on the context.
const tenantScopeKey ctxKey = "tenantScope"

// apiTokenFrom returns the token that authenticated the current /api/v1 request.
func apiTokenFrom(r *http.Request) store.ApiToken {
	if t, ok := r.Context().Value(apiTokenKey).(store.ApiToken); ok {
		return t
	}
	return store.ApiToken{}
}

// tenantScope returns the tenant the current request is scoped to, or nil for a
// global (unscoped) token.
func tenantScope(r *http.Request) *store.Tenant {
	if t, ok := r.Context().Value(tenantScopeKey).(*store.Tenant); ok {
		return t
	}
	return nil
}

// scopeAllows reports whether the current request's scope permits an extension.
// A global token (nil scope) allows everything; a tenant token allows only its
// own extensions.
func scopeAllows(r *http.Request, ext string) bool {
	sc := tenantScope(r)
	return sc == nil || sc.Matches(ext)
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
		rctx := context.WithValue(r.Context(), apiTokenKey, meta)
		// Resolve the tenant scope, if any. A token bound to a tenant that no
		// longer exists falls back to global (the FK is ON DELETE SET NULL, so
		// this is only a transient race), which is safe: it never widens beyond
		// the operator's own console access.
		var scope *store.Tenant
		if meta.TenantID != nil && s.Tenants != nil {
			if t, terr := s.Tenants.Get(ctx, *meta.TenantID); terr == nil {
				scope = &t
			}
		}
		rctx = context.WithValue(rctx, tenantScopeKey, scope)
		next.ServeHTTP(w, r.WithContext(rctx))
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
	resp := map[string]any{
		"ok":    true,
		"token": t.Name,
		"scope": "global",
		"time":  time.Now().UTC().Format(time.RFC3339),
	}
	if sc := tenantScope(r); sc != nil {
		resp["scope"] = "tenant"
		resp["tenant"] = map[string]any{"slug": sc.Slug, "name": sc.Name, "extPrefixes": sc.PrefixList()}
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleV1ListExtensions(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	exts, err := s.Ext.List(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if sc := tenantScope(r); sc != nil {
		filtered := exts[:0]
		for _, e := range exts {
			if sc.Matches(e.ID) {
				filtered = append(filtered, e)
			}
		}
		exts = filtered
	}
	writeJSON(w, http.StatusOK, map[string]any{"extensions": exts})
}

func (s *Server) handleV1GetExtension(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	// A tenant token must not be able to probe extensions outside its scope, so
	// an out-of-scope id is indistinguishable from a missing one (404).
	if !scopeAllows(r, id) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	ext, err := s.Ext.Get(ctx, id)
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
	if !scopeAllows(r, ext.ID) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "extension is outside your tenant scope"})
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
	id := chi.URLParam(r, "id")
	if !scopeAllows(r, id) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.Ext.Delete(ctx, id); err != nil {
		writeExtError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (s *Server) handleV1ListTrunks(w http.ResponseWriter, r *http.Request) {
	// Trunks are shared infrastructure, not tenant-owned; a scoped token cannot
	// enumerate them.
	if tenantScope(r) != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "trunks are not available to tenant-scoped tokens"})
		return
	}
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
	queue := q.Get("queue")

	// Tenant scoping: queue KPIs are queue-based, so a scoped token may only
	// query its own tenant's queues. If it names one it doesn't own, refuse; if
	// it names none, default to the tenant's single queue, or require a choice.
	if sc := tenantScope(r); sc != nil {
		allowed := sc.QueueList()
		if len(allowed) == 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no queues are configured for your tenant"})
			return
		}
		if queue == "" {
			if len(allowed) == 1 {
				queue = allowed[0]
			} else {
				writeJSON(w, http.StatusBadRequest, map[string]string{
					"error": "specify ?queue= (one of: " + strings.Join(allowed, ", ") + ")",
				})
				return
			}
		} else if !contains(allowed, queue) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "queue is outside your tenant scope"})
			return
		}
	}

	slaDefault := 20
	if sys, serr := s.System.Get(ctx); serr == nil && sys.SLASeconds > 0 {
		slaDefault = sys.SLASeconds
	}
	cc, err := s.Dashboard.CallCenterStats(ctx, from, to, queue, atoiDefault(q.Get("sla"), slaDefault))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"from":       from.Format(time.RFC3339),
		"to":         to.Format(time.RFC3339),
		"queue":      queue,
		"callcenter": cc,
	})
}

func (s *Server) handleV1ReportsQueues(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	// A scoped token only sees its own tenant's queues.
	if sc := tenantScope(r); sc != nil {
		writeJSON(w, http.StatusOK, map[string]any{"queues": sc.QueueList()})
		return
	}
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
	if sc := tenantScope(r); sc != nil {
		filtered := agents[:0]
		for _, a := range agents {
			if sc.Matches(a.Extension) {
				filtered = append(filtered, a)
			}
		}
		agents = filtered
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"from":   from.Format(time.RFC3339),
		"to":     to.Format(time.RFC3339),
		"agents": agents,
	})
}

// contains reports whether v is in list.
func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// handleV1Calls returns the live channel snapshot (active calls) from ARI. A
// scoped token sees only channels belonging to its tenant's extensions.
func (s *Server) handleV1Calls(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	chans, err := s.ARI.Channels(ctx)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	if sc := tenantScope(r); sc != nil {
		filtered := chans[:0]
		for _, ch := range chans {
			if sc.Matches(extFromChannel(ch.Name)) {
				filtered = append(filtered, ch)
			}
		}
		chans = filtered
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
	// Tenant scoping: the originating device must belong to the tenant, so a
	// scoped token can only place calls from its own extensions.
	if sc := tenantScope(r); sc != nil {
		epExt := extFromChannel(body.Endpoint) // "PJSIP/1001" -> "1001"
		if !sc.Matches(epExt) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "endpoint is outside your tenant scope"})
			return
		}
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
	// Tenant scoping: only allow hanging up a channel that belongs to the
	// tenant. An out-of-scope (or unknown) channel id looks like "not found".
	if sc := tenantScope(r); sc != nil {
		chans, cerr := s.ARI.Channels(ctx)
		if cerr != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": cerr.Error()})
			return
		}
		allowed := false
		for _, ch := range chans {
			if ch.ID == id && sc.Matches(extFromChannel(ch.Name)) {
				allowed = true
				break
			}
		}
		if !allowed {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
	}
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
		Name     string `json:"name"`
		TenantID *int64 `json:"tenantId"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" {
		body.Name = "api-token"
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	// Validate the tenant exists before binding a token to it.
	if body.TenantID != nil {
		if _, err := s.Tenants.Get(ctx, *body.TenantID); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown tenant"})
			return
		}
	}
	plaintext, meta, err := s.ApiTokens.Create(ctx, body.Name, sessionFrom(r).Username, body.TenantID)
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
