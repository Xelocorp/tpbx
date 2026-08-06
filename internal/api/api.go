// Package api wires the HTTP surface of the TPBX GUI backend: a JSON API under
// /api, the live-events WebSocket under /ws, and the static single-page app
// everywhere else.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/td425/tpbx/internal/ari"
	"github.com/td425/tpbx/internal/db"
	"github.com/td425/tpbx/internal/store"
	"github.com/td425/tpbx/internal/ws"
)

// Server holds the dependencies shared across HTTP handlers.
type Server struct {
	DB             *db.DB
	ARI            *ari.Client
	Hub            *ws.Hub
	Ext            *store.Extensions
	Trunks         *store.Trunks
	Routes         *store.Routes
	Transports     *store.Transports
	Users          *store.Users
	Agents         *store.Agents
	Settings       *store.Settings
	Analytics      *store.Analytics
	CDR            *store.CDR
	DialplanFile   string // generated routing dialplan Asterisk #includes
	TransportsFile string // generated PJSIP transports include Asterisk loads
	WebDir         string // built admin frontend (index.html, assets/)
	AgentWebDir    string // built agent softphone frontend, served under /phone

	// WebRTC/signalling parameters handed to the browser softphone.
	Domain     string        // public FQDN/IP for WSS + TURN ("" = derive from request)
	WSSPort    string        // Asterisk secure-WebSocket port (default 8089)
	TURNSecret string        // coturn static-auth-secret ("" disables TURN)
	TURNTTL    time.Duration // lifetime of a minted TURN credential

	// RestartAsterisk performs a full Asterisk restart (to re-bind transports).
	// Injected by main so the api package stays decoupled from AMI/config. Nil
	// when unavailable, in which case the restart endpoint reports so.
	RestartAsterisk func(context.Context) error
}

// Router builds the chi router with all routes mounted.
func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(30 * time.Second))

	r.Route("/api", func(r chi.Router) {
		// Public endpoints (no session required).
		r.Get("/health", s.handleHealth)
		r.Post("/login", s.handleLogin)
		r.Post("/logout", s.handleLogout)

		// Agent softphone: its own login + session, separate from the admin
		// console. Agents authenticate with a SIP extension + secret.
		r.Route("/agent", func(r chi.Router) {
			r.Use(s.agentCORS) // allow the cross-origin browser extension
			r.Options("/*", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
			r.Post("/login", s.handleAgentLogin)
			r.Post("/logout", s.handleAgentLogout)
			r.Group(func(r chi.Router) {
				r.Use(s.requireAgent)
				r.Get("/config", s.handleAgentConfig)
			})
		})

		// Everything else requires an authenticated session (Phase 8) and is
		// audited (who changed what).
		r.Group(func(r chi.Router) {
			r.Use(s.requireAuth)
			r.Use(s.audit)

			r.Get("/me", s.handleMe)
			r.Post("/change-password", s.handleChangePassword)

			r.Get("/status", s.handleStatus)
			r.Get("/endpoints", s.handleEndpoints)

			// Phase 2: live control actions.
			r.Get("/asterisk/info", s.handleAsteriskInfo)
			r.Post("/originate", s.handleOriginate)
			r.Delete("/channels/{id}", s.handleHangup)
			r.Post("/reload", s.handleReload)

			// Phase 3: extension provisioning (CRUD over realtime tables).
			r.Get("/extensions", s.handleListExtensions)
			r.Post("/extensions", s.handleCreateExtension)
			r.Get("/extensions/{id}", s.handleGetExtension)
			r.Put("/extensions/{id}", s.handleUpdateExtension)
			r.Delete("/extensions/{id}", s.handleDeleteExtension)

			// Phase 4: trunks (connection to an upstream SIP provider).
			r.Get("/trunks", s.handleListTrunks)
			r.Post("/trunks", s.handleCreateTrunk)
			r.Get("/trunks/{id}", s.handleGetTrunk)
			r.Put("/trunks/{id}", s.handleUpdateTrunk)
			r.Delete("/trunks/{id}", s.handleDeleteTrunk)

			// Phase 5: routing (compiled into a generated dialplan include).
			r.Get("/routes/outbound", s.handleListOutbound)
			r.Post("/routes/outbound", s.handleCreateOutbound)
			r.Put("/routes/outbound/{id}", s.handleUpdateOutbound)
			r.Delete("/routes/outbound/{id}", s.handleDeleteOutbound)
			r.Get("/routes/inbound", s.handleListInbound)
			r.Post("/routes/inbound", s.handleCreateInbound)
			r.Put("/routes/inbound/{id}", s.handleUpdateInbound)
			r.Delete("/routes/inbound/{id}", s.handleDeleteInbound)

			// PJSIP transports (load-time objects compiled to a static
			// #include; bind changes need an Asterisk restart).
			r.Get("/transports", s.handleListTransports)
			r.Post("/transports", s.handleCreateTransport)
			r.Get("/transports/{name}", s.handleGetTransport)
			r.Put("/transports/{name}", s.handleUpdateTransport)
			r.Delete("/transports/{name}", s.handleDeleteTransport)
			r.Post("/asterisk/restart", s.handleRestartAsterisk)

			// Call history (CDR).
			r.Get("/cdr", s.handleListCDR)

			// Analytics (manager or admin).
			r.Group(func(r chi.Router) {
				r.Use(s.requireManager)
				r.Get("/analytics/agents", s.handleAgentAnalytics)
			})

			// Phase 8: user management (admin only).
			r.Group(func(r chi.Router) {
				r.Use(s.requireAdmin)
				r.Get("/users", s.handleListUsers)
				r.Post("/users", s.handleCreateUser)
				r.Delete("/users/{username}", s.handleDeleteUser)
				r.Post("/users/{username}/password", s.handleResetUserPassword)

				// Runtime WebRTC/TURN configuration (varies per deployment).
				r.Get("/settings/webrtc", s.handleGetWebRTCSettings)
				r.Put("/settings/webrtc", s.handleUpdateWebRTCSettings)
			})
		})
	})

	// Live event stream for the dashboard (authenticated).
	r.Handle("/ws", s.requireAuth(http.HandlerFunc(s.Hub.ServeHTTP)))

	// Agent softphone SPA (separate build) under /phone.
	r.Get("/phone", s.serveAgentSPA)
	r.Get("/phone/*", s.serveAgentSPA)

	// Packaged downloads (extension zips). 404 when absent instead of falling
	// through to the SPA, so a not-yet-built file never masquerades as HTML.
	r.Get("/downloads/*", s.serveDownload)

	// Everything else is the admin SPA.
	r.NotFound(s.serveSPA)
	r.Get("/", s.serveSPA)

	return r
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	health := map[string]any{"status": "ok", "time": time.Now().UTC()}
	if err := s.DB.Pool.Ping(ctx); err != nil {
		health["database"] = "down: " + err.Error()
		health["status"] = "degraded"
	} else {
		health["database"] = "up"
	}
	writeJSON(w, http.StatusOK, health)
}

// handleStatus returns a live snapshot pulled straight from Asterisk via ARI:
// currently known endpoints and active channels. The dashboard renders this on
// first load and then keeps it fresh from the /ws event stream.
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	resp := map[string]any{"time": time.Now().UTC()}

	if eps, err := s.ARI.Endpoints(ctx); err != nil {
		resp["endpoints_error"] = err.Error()
	} else {
		resp["endpoints"] = eps
	}
	if chans, err := s.ARI.Channels(ctx); err != nil {
		resp["channels_error"] = err.Error()
	} else {
		resp["channels"] = chans
	}
	writeJSON(w, http.StatusOK, resp)
}

// handleEndpoints lists provisioned PJSIP endpoints from the realtime tables.
// This is configuration (what SHOULD exist), as opposed to /status which is
// live state (what IS registered right now).
func (s *Server) handleEndpoints(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	rows, err := s.DB.Pool.Query(ctx,
		`SELECT id, COALESCE(context,''), COALESCE(disallow,''), COALESCE(allow,''), COALESCE(transport,'')
		   FROM ps_endpoints ORDER BY id`)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	type endpoint struct {
		ID        string `json:"id"`
		Context   string `json:"context"`
		Disallow  string `json:"disallow"`
		Allow     string `json:"allow"`
		Transport string `json:"transport"`
	}
	out := []endpoint{}
	for rows.Next() {
		var e endpoint
		if err := rows.Scan(&e.ID, &e.Context, &e.Disallow, &e.Allow, &e.Transport); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		out = append(out, e)
	}
	writeJSON(w, http.StatusOK, map[string]any{"endpoints": out})
}

// handleAsteriskInfo returns the running PBX version and lifecycle times.
func (s *Server) handleAsteriskInfo(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	info, err := s.ARI.AsteriskInfo(ctx)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, info)
}

// handleOriginate places a new call via ARI and returns the created channel.
func (s *Server) handleOriginate(w http.ResponseWriter, r *http.Request) {
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

// handleHangup terminates an active channel by id.
func (s *Server) handleHangup(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "channel id is required"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := s.ARI.Hangup(ctx, id, r.URL.Query().Get("reason")); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "hung up", "channel": id})
}

// handleReload reloads an Asterisk module (e.g. res_pjsip.so) via ARI.
func (s *Server) handleReload(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Module string `json:"module"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if body.Module == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "module is required"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := s.ARI.ReloadModule(ctx, body.Module); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "reloaded", "module": body.Module})
}

// --- Phase 3: extensions -----------------------------------------------

func (s *Server) handleListExtensions(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	exts, err := s.Ext.List(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"extensions": exts})
}

func (s *Server) handleGetExtension(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	ext, err := s.Ext.Get(ctx, chi.URLParam(r, "id"))
	if err != nil {
		writeExtError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ext)
}

func (s *Server) handleCreateExtension(w http.ResponseWriter, r *http.Request) {
	ext, ok := decodeExtension(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := s.Ext.Create(ctx, ext); err != nil {
		writeExtError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"status": "created", "id": ext.ID})
}

func (s *Server) handleUpdateExtension(w http.ResponseWriter, r *http.Request) {
	ext, ok := decodeExtension(w, r)
	if !ok {
		return
	}
	// The path id is authoritative.
	ext.ID = chi.URLParam(r, "id")
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := s.Ext.Update(ctx, ext); err != nil {
		writeExtError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "updated", "id": ext.ID})
}

func (s *Server) handleDeleteExtension(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := s.Ext.Delete(ctx, chi.URLParam(r, "id")); err != nil {
		writeExtError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func decodeExtension(w http.ResponseWriter, r *http.Request) (store.Extension, bool) {
	var ext store.Extension
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&ext); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return ext, false
	}
	return ext, true
}

// writeExtError maps store errors to HTTP status codes.
func writeExtError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	case errors.Is(err, store.ErrConflict):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "already exists"})
	default:
		// Validation errors and everything else.
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	}
}

// --- Phase 4: trunks ---------------------------------------------------

// reloadPJSIP asks Asterisk to reload PJSIP so realtime OUTBOUND REGISTRATIONS
// and IDENTIFIES take effect. Endpoints/AORs are fetched from realtime on
// demand, but registrations and identifies are only read at load/reload time,
// so a trunk written to the DB does nothing until this runs. Best-effort: the
// config is already persisted; a reload failure is logged, not fatal.
func (s *Server) reloadPJSIP(ctx context.Context) {
	if err := s.ARI.ReloadModule(ctx, "res_pjsip.so"); err != nil {
		slog.Warn("pjsip reload after trunk change failed", "err", err)
	}
}

func (s *Server) handleListTrunks(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	trunks, err := s.Trunks.List(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// Enrich with live reachability from ARI (best-effort). The trunk's AOR is
	// qualified, so the endpoint state reflects whether the provider responds.
	if eps, err := s.ARI.Endpoints(ctx); err == nil {
		state := make(map[string]string, len(eps))
		for _, e := range eps {
			if strings.EqualFold(e.Technology, "PJSIP") {
				state[e.Resource] = e.State
			}
		}
		for i := range trunks {
			if st, ok := state[trunks[i].Name]; ok {
				trunks[i].State = st
			} else {
				trunks[i].State = "unknown"
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"trunks": trunks})
}

func (s *Server) handleGetTrunk(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	t, err := s.Trunks.Get(ctx, chi.URLParam(r, "id"))
	if err != nil {
		writeExtError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *Server) handleCreateTrunk(w http.ResponseWriter, r *http.Request) {
	t, ok := decodeTrunk(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := s.Trunks.Create(ctx, t); err != nil {
		writeExtError(w, err)
		return
	}
	s.reloadPJSIP(ctx)
	writeJSON(w, http.StatusCreated, map[string]string{"status": "created", "name": t.Name})
}

func (s *Server) handleUpdateTrunk(w http.ResponseWriter, r *http.Request) {
	t, ok := decodeTrunk(w, r)
	if !ok {
		return
	}
	t.Name = chi.URLParam(r, "id")
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := s.Trunks.Update(ctx, t); err != nil {
		writeExtError(w, err)
		return
	}
	s.reloadPJSIP(ctx)
	writeJSON(w, http.StatusOK, map[string]string{"status": "updated", "name": t.Name})
}

func (s *Server) handleDeleteTrunk(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := s.Trunks.Delete(ctx, chi.URLParam(r, "id")); err != nil {
		writeExtError(w, err)
		return
	}
	s.reloadPJSIP(ctx)
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func decodeTrunk(w http.ResponseWriter, r *http.Request) (store.Trunk, bool) {
	var t store.Trunk
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&t); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return t, false
	}
	return t, true
}

// serveSPA serves the built frontend from WebDir. Unknown paths fall back to
// index.html so client-side routing works. If no build is present it serves a
// themed placeholder so the operator can confirm the backend is running.
// serveAgentSPA serves the agent softphone build (rooted at /phone). Its assets
// are referenced as /phone/assets/..., so the /phone prefix is stripped before
// looking a file up under AgentWebDir; unknown paths fall back to its index.
func (s *Server) serveAgentSPA(w http.ResponseWriter, r *http.Request) {
	if s.AgentWebDir != "" {
		rel := strings.TrimPrefix(r.URL.Path, "/phone")
		clean := filepath.Clean(strings.TrimPrefix(rel, "/"))
		candidate := filepath.Join(s.AgentWebDir, clean)
		if clean != "." && withinDir(s.AgentWebDir, candidate) {
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
				http.ServeFile(w, r, candidate)
				return
			}
		}
		index := filepath.Join(s.AgentWebDir, "index.html")
		if _, err := os.Stat(index); err == nil {
			http.ServeFile(w, r, index)
			return
		}
	}
	http.Error(w, "agent softphone not built", http.StatusNotFound)
}

// serveDownload serves a file from WebDir/downloads (the packaged extension
// zips) and returns 404 when it does not exist, so a missing build never falls
// through to the SPA and gets saved as an HTML "zip".
func (s *Server) serveDownload(w http.ResponseWriter, r *http.Request) {
	if s.WebDir == "" {
		http.NotFound(w, r)
		return
	}
	clean := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/downloads/"))
	if clean == "." || strings.HasPrefix(clean, "..") {
		http.NotFound(w, r)
		return
	}
	p := filepath.Join(s.WebDir, "downloads", clean)
	if !withinDir(s.WebDir, p) {
		http.NotFound(w, r)
		return
	}
	if info, err := os.Stat(p); err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="`+filepath.Base(p)+`"`)
	http.ServeFile(w, r, p)
}

func (s *Server) serveSPA(w http.ResponseWriter, r *http.Request) {
	if s.WebDir != "" {
		clean := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
		candidate := filepath.Join(s.WebDir, clean)
		if clean != "." && withinDir(s.WebDir, candidate) {
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
				http.ServeFile(w, r, candidate)
				return
			}
		}
		index := filepath.Join(s.WebDir, "index.html")
		if _, err := os.Stat(index); err == nil {
			http.ServeFile(w, r, index)
			return
		}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(placeholderHTML))
}

func withinDir(dir, path string) bool {
	rel, err := filepath.Rel(dir, path)
	if err != nil {
		return false
	}
	return !strings.HasPrefix(rel, "..")
}

// placeholderHTML is a self-contained themed landing page shown when the
// frontend has not been built yet. It matches the sci-fi call-center theme
// (primary green #39a751) so the visual identity is present from day one.
const placeholderHTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TPBX Control</title>
<style>
:root{--green:#39a751;--bg:#05100a;--panel:#0b1f14;--grid:rgba(57,167,81,.12);--text:#c8f7d4;--muted:#5f8f6e}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;font-family:"Segoe UI",system-ui,sans-serif;color:var(--text);
background:radial-gradient(circle at 50% 0%,#0a2417 0%,var(--bg) 60%);
background-image:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);
background-size:100% 100%,40px 40px,40px 40px;display:flex;align-items:center;justify-content:center}
.panel{border:1px solid var(--green);border-radius:14px;padding:48px 56px;background:rgba(11,31,20,.75);
box-shadow:0 0 40px rgba(57,167,81,.25),inset 0 0 30px rgba(57,167,81,.06);text-align:center;max-width:560px}
h1{margin:0 0 4px;font-size:34px;letter-spacing:6px;text-transform:uppercase;color:var(--green);text-shadow:0 0 18px rgba(57,167,81,.6)}
.tag{color:var(--muted);letter-spacing:3px;font-size:12px;text-transform:uppercase;margin-bottom:24px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--green);box-shadow:0 0 10px var(--green);
margin-right:8px;animation:pulse 1.6s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
code{color:var(--green)}
.hint{margin-top:22px;font-size:13px;color:var(--muted);line-height:1.7}
</style></head><body>
<div class="panel">
<h1>TPBX</h1>
<div class="tag">Asterisk Control Console</div>
<div><span class="dot"></span>Backend online</div>
<div class="hint">Frontend build not found. Run <code>make web</code> then reload,<br>
or hit the API directly: <code>/api/health</code></div>
</div></body></html>`
