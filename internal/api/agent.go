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
// the WSS signalling URL, and freshly-minted ICE (STUN/TURN) servers.
func (s *Server) handleAgentConfig(w http.ResponseWriter, r *http.Request) {
	ext := agentFrom(r)
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	a, err := s.Agents.Get(ctx, ext)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	host := s.publicHost(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"extension":   a.Extension,
		"displayName": a.DisplayName,
		"password":    a.Password, // the agent's own SIP secret, over their session
		"domain":      host,
		"wsUrl":       fmt.Sprintf("wss://%s:%s/ws", host, s.wssPort()),
		"iceServers":  s.iceServers(host, ext),
	})
}

// publicHost is the FQDN/IP clients should use to reach signalling and media.
// The configured domain wins; otherwise it is derived from the request Host so
// a bare-IP install still works without any configuration.
func (s *Server) publicHost(r *http.Request) string {
	if s.Domain != "" {
		return s.Domain
	}
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return host
}

func (s *Server) wssPort() string {
	if s.WSSPort != "" {
		return s.WSSPort
	}
	return "8089"
}

// iceServers builds the ICE server list. STUN is always offered; TURN is added
// only when a shared secret is configured, using the coturn REST convention:
// username = "<expiry-unix>:<name>", credential = base64(HMAC-SHA1(secret, username)).
// The credential is short-lived so the static secret never reaches the browser.
func (s *Server) iceServers(host, ext string) []map[string]any {
	servers := []map[string]any{
		{"urls": []string{fmt.Sprintf("stun:%s:3478", host)}},
	}
	if s.TURNSecret == "" {
		return servers
	}
	ttl := s.TURNTTL
	if ttl <= 0 {
		ttl = time.Hour
	}
	expiry := time.Now().Add(ttl).Unix()
	username := strconv.FormatInt(expiry, 10) + ":" + ext
	mac := hmac.New(sha1.New, []byte(s.TURNSecret))
	mac.Write([]byte(username))
	credential := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	servers = append(servers, map[string]any{
		"urls": []string{
			fmt.Sprintf("turn:%s:3478?transport=udp", host),
			fmt.Sprintf("turn:%s:3478?transport=tcp", host),
			fmt.Sprintf("turns:%s:5349?transport=tcp", host),
		},
		"username":   username,
		"credential": credential,
	})
	return servers
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
