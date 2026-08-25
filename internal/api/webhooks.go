package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
)

// handleV1Events upgrades to a WebSocket and streams semantic call events to the
// caller. Authentication is the same API token as the rest of /api/v1 (the
// middleware already ran). An optional ?events= CSV filters the event types.
func (s *Server) handleV1Events(w http.ResponseWriter, r *http.Request) {
	if s.Bus == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "event bus unavailable"})
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	var prefixes []string
	if sc := tenantScope(r); sc != nil {
		prefixes = sc.PrefixList()
	}
	sub := s.Bus.Subscribe(r.URL.Query().Get("events"), prefixes)
	defer s.Bus.Unsubscribe(sub)

	ctx := conn.CloseRead(r.Context()) // we only write; detect client close

	// Greet so the consumer can confirm the stream is live.
	hello, _ := json.Marshal(map[string]any{"type": "hello", "time": time.Now().UTC()})
	if err := conn.Write(ctx, websocket.MessageText, hello); err != nil {
		return
	}

	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-sub.C():
			if !ok {
				return
			}
			payload, mErr := json.Marshal(ev)
			if mErr != nil {
				continue
			}
			wctx, cancel := context.WithTimeout(ctx, 8*time.Second)
			werr := conn.Write(wctx, websocket.MessageText, payload)
			cancel()
			if werr != nil {
				return
			}
		case <-ping.C:
			if err := conn.Ping(ctx); err != nil {
				return
			}
		}
	}
}

// --- Webhook administration (console, "settings" feature) --------------------

func (s *Server) handleListWebhooks(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	hooks, err := s.Webhooks.List(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"webhooks": hooks})
}

// handleCreateWebhook registers an endpoint and returns it including the freshly
// minted signing secret (shown so the operator can configure their receiver).
func (s *Server) handleCreateWebhook(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL      string `json:"url"`
		Events   string `json:"events"`
		TenantID *int64 `json:"tenantId"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	body.URL = strings.TrimSpace(body.URL)
	if !strings.HasPrefix(body.URL, "http://") && !strings.HasPrefix(body.URL, "https://") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "url must be an http(s) URL"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if body.TenantID != nil {
		if _, err := s.Tenants.Get(ctx, *body.TenantID); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown tenant"})
			return
		}
	}
	wh, err := s.Webhooks.Create(ctx, body.URL, strings.TrimSpace(body.Events), sessionFrom(r).Username, body.TenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, wh)
}

func (s *Server) handleToggleWebhook(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid webhook id"})
		return
	}
	var body struct {
		Enabled bool `json:"enabled"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body)
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.Webhooks.SetEnabled(ctx, id, body.Enabled); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"enabled": body.Enabled})
}

func (s *Server) handleDeleteWebhook(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid webhook id"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.Webhooks.Delete(ctx, id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// handleTestWebhook publishes a synthetic ping event so the operator can confirm
// their endpoint receives and verifies deliveries.
func (s *Server) handleTestWebhook(w http.ResponseWriter, r *http.Request) {
	if s.Bus == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "event bus unavailable"})
		return
	}
	s.Bus.Publish("webhook.test", map[string]any{
		"message": "This is a test event from XeloVoice.",
		"by":      sessionFrom(r).Username,
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "test event queued"})
}
