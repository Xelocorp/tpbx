// Package events is the fan-out bus behind the /api/v1 event surface. Semantic
// telephony events (call.started, call.answered, call.ended, ...) are published
// here and delivered two ways:
//
//   - to live WebSocket subscribers (the /api/v1/events stream), and
//   - to persisted outbound webhooks, each POSTed with an HMAC-SHA256 signature.
//
// The bus is transport-agnostic: main wires the ARI event stream into Publish,
// and the api package subscribes WebSocket clients and manages webhook rows.
package events

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/td425/tpbx/internal/store"
)

// Event is a single semantic occurrence delivered to subscribers.
type Event struct {
	ID   string         `json:"id"`
	Type string         `json:"type"`
	Time time.Time      `json:"time"`
	Data map[string]any `json:"data,omitempty"`
}

// Subscriber is a live consumer (one WebSocket client). Events are dropped for a
// subscriber that cannot keep up rather than stalling the bus.
type Subscriber struct {
	ch       chan Event
	filter   map[string]bool // event types this subscriber wants; nil = all
	prefixes []string        // tenant extension prefixes; nil/empty = all tenants
}

// C is the receive channel for a subscriber.
func (s *Subscriber) C() <-chan Event { return s.ch }

// Bus fans events out to live subscribers and persisted webhooks.
type Bus struct {
	mu   sync.RWMutex
	subs map[*Subscriber]struct{}

	hooks  *store.Webhooks
	client *http.Client
	seq    atomic.Uint64
	now    func() time.Time
}

// New returns a Bus. hooks may be nil (then only live subscribers are served).
func New(hooks *store.Webhooks) *Bus {
	return &Bus{
		subs:   make(map[*Subscriber]struct{}),
		hooks:  hooks,
		client: &http.Client{Timeout: 8 * time.Second},
		now:    time.Now,
	}
}

// Subscribe registers a live consumer. filterCSV limits the event types it
// receives ("" or "*" = all). extPrefixes, when non-empty, restricts delivery to
// events whose extension matches one of the prefixes (tenant scoping). Call
// Unsubscribe when done.
func (b *Bus) Subscribe(filterCSV string, extPrefixes []string) *Subscriber {
	s := &Subscriber{ch: make(chan Event, 64), filter: parseFilter(filterCSV), prefixes: extPrefixes}
	b.mu.Lock()
	b.subs[s] = struct{}{}
	b.mu.Unlock()
	return s
}

// Unsubscribe removes a live consumer and closes its channel.
func (b *Bus) Unsubscribe(s *Subscriber) {
	b.mu.Lock()
	if _, ok := b.subs[s]; ok {
		delete(b.subs, s)
		close(s.ch)
	}
	b.mu.Unlock()
}

// Publish stamps an event with an id + time and fans it out. Webhook delivery
// runs in the background so Publish never blocks the caller (the ARI loop).
func (b *Bus) Publish(evType string, data map[string]any) {
	ev := Event{
		ID:   fmt.Sprintf("evt_%d_%d", b.now().UnixNano(), b.seq.Add(1)),
		Type: evType,
		Time: b.now().UTC(),
		Data: data,
	}

	// Live subscribers (non-blocking).
	b.mu.RLock()
	for s := range b.subs {
		if s.filter != nil && !s.filter[ev.Type] {
			continue
		}
		if !eventMatchesPrefixes(ev, s.prefixes) {
			continue
		}
		select {
		case s.ch <- ev:
		default: // slow client; drop this event for them
		}
	}
	b.mu.RUnlock()

	// Persisted webhooks (background).
	if b.hooks != nil {
		go b.deliverWebhooks(ev)
	}
}

func (b *Bus) deliverWebhooks(ev Event) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	hooks, err := b.hooks.EnabledWithSecret(ctx)
	if err != nil || len(hooks) == 0 {
		return
	}
	body, err := json.Marshal(ev)
	if err != nil {
		return
	}
	for _, h := range hooks {
		if f := parseFilter(h.Events); f != nil && !f[ev.Type] {
			continue
		}
		// Tenant scoping: a hook bound to a tenant only receives events whose
		// extension matches the tenant's prefixes.
		if !eventMatchesPrefixes(ev, splitCSV(h.TenantPrefixes)) {
			continue
		}
		b.postWithRetry(ctx, h, body)
	}
}

// postWithRetry delivers one event to one webhook with a short bounded retry.
func (b *Bus) postWithRetry(ctx context.Context, h store.Webhook, body []byte) {
	sig := sign(h.Secret, body)
	var lastStatus int
	var lastErr string
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Duration(attempt) * time.Second):
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.URL, bytes.NewReader(body))
		if err != nil {
			lastErr = err.Error()
			break
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "XeloVoice-Webhook/1.0")
		req.Header.Set("X-XeloVoice-Signature", "sha256="+sig)
		resp, err := b.client.Do(req)
		if err != nil {
			lastErr = err.Error()
			continue
		}
		lastStatus = resp.StatusCode
		resp.Body.Close()
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			lastErr = ""
			break
		}
		lastErr = fmt.Sprintf("HTTP %d", resp.StatusCode)
	}
	if lastErr != "" && lastStatus == 0 {
		slog.Warn("webhook delivery failed", "url", h.URL, "err", lastErr)
	}
	// Record on a fresh short context so the outcome is stored even if the
	// delivery deadline above has already elapsed.
	rctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	b.hooks.RecordDelivery(rctx, h.ID, lastStatus, lastErr)
}

// sign returns the hex HMAC-SHA256 of body under secret.
func sign(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// eventMatchesPrefixes reports whether an event belongs to a tenant identified
// by extension prefixes. An empty prefix list means "no tenant scope" (match
// all). Events with no extension in their data never match a scoped filter, so a
// scoped consumer never sees another tenant's (or an unattributable) event.
func eventMatchesPrefixes(ev Event, prefixes []string) bool {
	if len(prefixes) == 0 {
		return true
	}
	ext, _ := ev.Data["extension"].(string)
	if ext == "" {
		return false
	}
	for _, p := range prefixes {
		if strings.HasPrefix(ext, p) {
			return true
		}
	}
	return false
}

// splitCSV trims a CSV into a slice, dropping empties.
func splitCSV(s string) []string {
	out := []string{}
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// parseFilter turns a CSV event filter into a set. "" or "*" (any element) means
// "all events", returned as nil.
func parseFilter(csv string) map[string]bool {
	csv = strings.TrimSpace(csv)
	if csv == "" || csv == "*" {
		return nil
	}
	set := map[string]bool{}
	for _, p := range strings.Split(csv, ",") {
		if p = strings.TrimSpace(p); p != "" {
			if p == "*" {
				return nil
			}
			set[p] = true
		}
	}
	if len(set) == 0 {
		return nil
	}
	return set
}
