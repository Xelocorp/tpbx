package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/td425/tpbx/internal/store"
)

// The agent softphone is a separate app (served at /phone) with its own
// session cookie, distinct from the admin console's tpbx_session. An agent
// authenticates with a SIP extension + secret, so the session gates only the
// softphone's own endpoints -- never the admin API.
const agentSessionCookie = "tpbx_agent"

type agentCtxKey string

const agentKey agentCtxKey = "agent_ext"

func agentFrom(r *http.Request) string {
	if ext, ok := r.Context().Value(agentKey).(string); ok {
		return ext
	}
	return ""
}

// requireAgent rejects requests without a valid agent session cookie.
func (s *Server) requireAgent(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(agentSessionCookie)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication required"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		ext, ok := s.Agents.LookupSession(ctx, c.Value)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "session expired"})
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), agentKey, ext)))
	})
}

func (s *Server) handleAgentLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Extension string `json:"extension"`
		Password  string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()

	a, err := s.Agents.Authenticate(ctx, strings.TrimSpace(body.Extension), body.Password)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid extension or password"})
		return
	}
	token, err := s.Agents.CreateSession(ctx, a.Extension)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	http.SetCookie(w, s.agentCookie(r, token))
	writeJSON(w, http.StatusOK, map[string]any{
		"extension":   a.Extension,
		"displayName": a.DisplayName,
	})
}

func (s *Server) handleAgentLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(agentSessionCookie); err == nil {
		s.Agents.DeleteSession(r.Context(), c.Value)
	}
	clear := s.agentCookie(r, "")
	clear.MaxAge = -1
	http.SetCookie(w, clear)
	writeJSON(w, http.StatusOK, map[string]string{"status": "logged out"})
}

// handleAgentConfig returns everything the browser softphone needs to register
// and place calls: the SIP identity (with secret, since it is the agent's own),
// the WSS signalling URL, and ICE (STUN/TURN) servers -- all derived from the
// admin-editable WebRTC settings so it adapts per deployment.
func (s *Server) handleAgentConfig(w http.ResponseWriter, r *http.Request) {
	ext := agentFrom(r)
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	a, err := s.Agents.Get(ctx, ext)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	cfg, err := s.Settings.GetWebRTC(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	host := s.resolveHost(r, cfg)
	policy := cfg.ICETransportPolicy
	if policy != "relay" {
		policy = "all"
	}

	// A reverse proxy terminating TLS exposes the WebSocket on its own host/path,
	// so an explicit override wins over the derived wss://<host>:<port>/ws.
	wsURL := strings.TrimSpace(cfg.WSSURL)
	if wsURL == "" {
		wssPort := cfg.WSSPort
		if wssPort == "" {
			wssPort = "8089"
		}
		wsURL = fmt.Sprintf("wss://%s:%s/ws", host, wssPort)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"extension":          a.Extension,
		"displayName":        a.DisplayName,
		"password":           a.Password, // the agent's own SIP secret, over their session
		"domain":             host,
		"wsUrl":              wsURL,
		"iceServers":         s.iceServers(cfg, host, ext),
		"iceTransportPolicy": policy,
	})
}

// resolveHost picks the address clients should reach signalling/media at:
// the admin-set public host wins, then the install-time domain, then the
// request Host (which is correct for LAN installs the admin browses to).
func (s *Server) resolveHost(r *http.Request, cfg store.WebRTCSettings) string {
	if cfg.PublicHost != "" {
		return cfg.PublicHost
	}
	if s.Domain != "" {
		return s.Domain
	}
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return host
}

// iceServers builds the ICE server list from the WebRTC settings.
//
//   - STUN: offered when enabled.
//   - TURN "builtin": short-lived HMAC credentials minted from the coturn
//     shared secret (TURN REST API) so the secret never reaches the browser.
//   - TURN "static": fixed username/password for an external TURN service.
//   - TURN "none"/disabled: omitted.
func (s *Server) iceServers(cfg store.WebRTCSettings, host, ext string) []map[string]any {
	turnHost := cfg.TURNHost
	if turnHost == "" {
		turnHost = host
	}
	servers := []map[string]any{}
	if cfg.STUNEnabled {
		stun := splitCSV(cfg.STUNURLs) // explicit STUN servers (e.g. a public fallback)
		if len(stun) == 0 {
			stun = []string{"stun:" + hostPort(turnHost, "3478")}
		}
		servers = append(servers, map[string]any{"urls": stun})
	}
	if !cfg.TURNEnabled || cfg.TURNMode == "none" {
		return servers
	}

	// Explicit URLs win; otherwise derive standard coturn URLs from turnHost.
	urls := splitCSV(cfg.TURNURLs)
	if len(urls) == 0 {
		urls = []string{
			"turn:" + hostPort(turnHost, "3478") + "?transport=udp",
			"turn:" + hostPort(turnHost, "3478") + "?transport=tcp",
		}
		if cfg.TURNTLS {
			urls = append(urls, "turns:"+hostPort(turnHost, "5349")+"?transport=tcp")
		}
	}

	switch cfg.TURNMode {
	case "static":
		if cfg.TURNStaticUser == "" {
			return servers // misconfigured; fall back to STUN only
		}
		servers = append(servers, map[string]any{
			"urls": urls, "username": cfg.TURNStaticUser, "credential": cfg.TURNStaticPassword,
		})
	default: // "builtin"
		if s.TURNSecret == "" {
			return servers // no coturn secret provisioned
		}
		ttl := s.TURNTTL
		if ttl <= 0 {
			ttl = time.Hour
		}
		username := strconv.FormatInt(time.Now().Add(ttl).Unix(), 10) + ":" + ext
		mac := hmac.New(sha1.New, []byte(s.TURNSecret))
		mac.Write([]byte(username))
		servers = append(servers, map[string]any{
			"urls":       urls,
			"username":   username,
			"credential": base64.StdEncoding.EncodeToString(mac.Sum(nil)),
		})
	}
	return servers
}

// hostPort appends :port to host unless host already carries a port, so a
// value like "stun.l.google.com:19302" is used verbatim instead of being
// double-ported into an invalid "stun.l.google.com:19302:3478".
func hostPort(host, port string) string {
	if strings.Contains(host, ":") {
		return host
	}
	return host + ":" + port
}

func splitCSV(s string) []string {
	out := []string{}
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// agentCookie builds the agent session cookie, marking it Secure when the
// request arrived over TLS (directly or via a terminating proxy).
func (s *Server) agentCookie(r *http.Request, token string) *http.Cookie {
	secure := r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
	return &http.Cookie{
		Name:     agentSessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int((16 * time.Hour).Seconds()),
	}
}
