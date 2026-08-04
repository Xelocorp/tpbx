// Package ws is a fan-out hub that pushes live events to connected browsers.
//
// The backend consumes AMI and ARI events, normalises them into small JSON
// envelopes, and broadcasts them here. Every browser on the dashboard holds a
// single WebSocket and receives the same stream, so the UI reflects call
// activity in real time without polling.
package ws

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Envelope is the message shape the frontend receives. Kind is a short
// discriminator ("channel", "endpoint", "hello", ...) and Data is the payload.
type Envelope struct {
	Kind string `json:"kind"`
	Data any    `json:"data"`
}

// Hub tracks connected clients and broadcasts envelopes to all of them.
type Hub struct {
	mu      sync.RWMutex
	clients map[*client]struct{}
}

type client struct {
	conn *websocket.Conn
	send chan []byte
}

// NewHub creates an empty hub.
func NewHub() *Hub {
	return &Hub{clients: make(map[*client]struct{})}
}

// Broadcast marshals env once and delivers it to every connected client. Slow
// clients that cannot keep up are dropped rather than stalling the hub.
func (h *Hub) Broadcast(env Envelope) {
	payload, err := json.Marshal(env)
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		select {
		case c.send <- payload:
		default:
			// Drop; the writer will be reaped when its buffer is full.
		}
	}
}

// ServeHTTP upgrades an HTTP request to a WebSocket and registers the client.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// The dashboard is served from the same origin as this endpoint; for
		// dev with a Vite proxy this is still same-origin from the browser's
		// perspective.
		InsecureSkipVerify: false,
	})
	if err != nil {
		return
	}

	c := &client{conn: conn, send: make(chan []byte, 64)}
	h.add(c)
	defer h.remove(c)

	ctx := r.Context()
	// Greet the client so the UI can confirm the socket is live.
	hello, _ := json.Marshal(Envelope{Kind: "hello", Data: map[string]string{"status": "connected"}})
	c.send <- hello

	go h.readPump(ctx, c) // drain client reads (pings/closes)
	h.writePump(ctx, c)
	conn.Close(websocket.StatusNormalClosure, "")
}

func (h *Hub) writePump(ctx context.Context, c *client) {
	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-c.send:
			writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := c.conn.Write(writeCtx, websocket.MessageText, msg)
			cancel()
			if err != nil {
				return
			}
		}
	}
}

func (h *Hub) readPump(ctx context.Context, c *client) {
	for {
		if _, _, err := c.conn.Read(ctx); err != nil {
			return
		}
	}
}

func (h *Hub) add(c *client) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
}

func (h *Hub) remove(c *client) {
	h.mu.Lock()
	delete(h.clients, c)
	h.mu.Unlock()
}
