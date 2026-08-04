// Package api wires the HTTP surface of the TPBX GUI backend: a JSON API under
// /api, the live-events WebSocket under /ws, and the static single-page app
// everywhere else.
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/td425/tpbx/internal/ari"
	"github.com/td425/tpbx/internal/db"
	"github.com/td425/tpbx/internal/ws"
)

// Server holds the dependencies shared across HTTP handlers.
type Server struct {
	DB     *db.DB
	ARI    *ari.Client
	Hub    *ws.Hub
	WebDir string // directory containing the built frontend (index.html, assets/)
}

// Router builds the chi router with all routes mounted.
func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(30 * time.Second))

	r.Route("/api", func(r chi.Router) {
		r.Get("/health", s.handleHealth)
		r.Get("/status", s.handleStatus)
		r.Get("/endpoints", s.handleEndpoints)
	})

	// Live event stream for the dashboard.
	r.Handle("/ws", http.HandlerFunc(s.Hub.ServeHTTP))

	// Everything else is the SPA.
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

// serveSPA serves the built frontend from WebDir. Unknown paths fall back to
// index.html so client-side routing works. If no build is present it serves a
// themed placeholder so the operator can confirm the backend is running.
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
