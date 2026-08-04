// Package ari implements a minimal client for the Asterisk REST Interface.
//
// ARI has two halves:
//   - a REST API used to query and manipulate channels, bridges, endpoints,
//     device state, etc. (request/response over HTTP); and
//   - a WebSocket that streams asynchronous Stasis events (channel created,
//     dialed, hung up, ...).
//
// For Phase 1 we implement the REST calls we need for the live dashboard and
// subscribe to the event WebSocket, forwarding events to the rest of the app.
package ari

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// Client talks to ARI over REST and (optionally) the event WebSocket.
type Client struct {
	baseURL  string
	username string
	password string
	appName  string
	http     *http.Client
}

// Event is a decoded Stasis event. We keep the raw payload plus the always
// present "type" discriminator so callers can decide how much to decode.
type Event struct {
	Type string          `json:"type"`
	Raw  json.RawMessage `json:"-"`
}

// New constructs an ARI client. It does not perform any I/O.
func New(baseURL, username, password, appName string) *Client {
	return &Client{
		baseURL:  strings.TrimRight(baseURL, "/"),
		username: username,
		password: password,
		appName:  appName,
		http:     &http.Client{Timeout: 15 * time.Second},
	}
}

// get performs an authenticated GET against /ari/<path> and decodes JSON into v.
func (c *Client) get(ctx context.Context, path string, v any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/ari/"+strings.TrimLeft(path, "/"), nil)
	if err != nil {
		return err
	}
	req.SetBasicAuth(c.username, c.password)
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("ari get %s: %w", path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("ari get %s: status %d: %s", path, resp.StatusCode, body)
	}
	if v == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

// Endpoint is a slimmed-down view of an ARI endpoint resource.
type Endpoint struct {
	Technology string   `json:"technology"`
	Resource   string   `json:"resource"`
	State      string   `json:"state"`
	ChannelIDs []string `json:"channel_ids"`
}

// Endpoints lists all endpoints known to Asterisk (registered or not).
func (c *Client) Endpoints(ctx context.Context) ([]Endpoint, error) {
	var out []Endpoint
	if err := c.get(ctx, "endpoints", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Channel is a slimmed-down view of an active ARI channel.
type Channel struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	State  string `json:"state"`
	Caller struct {
		Name   string `json:"name"`
		Number string `json:"number"`
	} `json:"caller"`
	Connected struct {
		Name   string `json:"name"`
		Number string `json:"number"`
	} `json:"connected"`
	CreationTime string `json:"creationtime"`
}

// Channels lists all active channels (i.e. live calls/legs).
func (c *Client) Channels(ctx context.Context) ([]Channel, error) {
	var out []Channel
	if err := c.get(ctx, "channels", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// StreamEvents connects to the ARI events WebSocket and delivers Stasis events
// to onEvent until ctx is cancelled or the connection fails. The caller is
// expected to run this in a goroutine and reconnect on error.
func (c *Client) StreamEvents(ctx context.Context, onEvent func(Event)) error {
	u, err := url.Parse(c.baseURL)
	if err != nil {
		return err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	default:
		u.Scheme = "ws"
	}
	u.Path = "/ari/events"
	q := u.Query()
	q.Set("app", c.appName)
	q.Set("api_key", c.username+":"+c.password)
	u.RawQuery = q.Encode()

	conn, _, err := websocket.Dial(ctx, u.String(), nil)
	if err != nil {
		return fmt.Errorf("ari events dial: %w", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	conn.SetReadLimit(1 << 20)

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		var ev Event
		if err := json.Unmarshal(data, &ev); err != nil {
			continue
		}
		ev.Raw = json.RawMessage(data)
		onEvent(ev)
	}
}
