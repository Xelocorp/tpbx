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
	"strconv"
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

// do performs an authenticated ARI request and, if v is non-nil and the
// response has a body, decodes JSON into v. query may be nil.
func (c *Client) do(ctx context.Context, method, path string, query url.Values, v any) error {
	u := c.baseURL + "/ari/" + strings.TrimLeft(path, "/")
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, nil)
	if err != nil {
		return err
	}
	req.SetBasicAuth(c.username, c.password)
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("ari %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("ari %s %s: status %d: %s", method, path, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if v == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

// get is a convenience wrapper for GET requests.
func (c *Client) get(ctx context.Context, path string, v any) error {
	return c.do(ctx, http.MethodGet, path, nil, v)
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

// OriginateParams describes a new outbound call. Endpoint is required (e.g.
// "PJSIP/1001"); the call is placed into the dialplan at Context,Extension.
type OriginateParams struct {
	Endpoint  string
	Extension string
	Context   string
	Priority  string
	CallerID  string
	Timeout   string // seconds; defaults to "30"
}

// Originate places a new call and connects it into the dialplan. It returns the
// created channel.
func (c *Client) Originate(ctx context.Context, p OriginateParams) (Channel, error) {
	var ch Channel
	if p.Endpoint == "" {
		return ch, fmt.Errorf("endpoint is required")
	}
	q := url.Values{}
	q.Set("endpoint", p.Endpoint)
	if p.Extension != "" {
		q.Set("extension", p.Extension)
	}
	if p.Context != "" {
		q.Set("context", p.Context)
	}
	q.Set("priority", orDefault(p.Priority, "1"))
	if p.CallerID != "" {
		q.Set("callerId", p.CallerID)
	}
	q.Set("timeout", orDefault(p.Timeout, "30"))
	err := c.do(ctx, http.MethodPost, "channels", q, &ch)
	return ch, err
}

// Hangup terminates an active channel by id.
func (c *Client) Hangup(ctx context.Context, channelID, reason string) error {
	q := url.Values{}
	if reason != "" {
		q.Set("reason", reason)
	}
	return c.do(ctx, http.MethodDelete, "channels/"+channelID, q, nil)
}

// RTPStats is a per-channel audio RTP counter snapshot. Rx is packets Asterisk
// received FROM the peer (the peer is sending audio); Tx is packets Asterisk
// sent TO the peer (the peer is receiving audio).
type RTPStats struct {
	Rx int64 `json:"rx"`
	Tx int64 `json:"tx"`
}

// channelVar evaluates a channel variable/function via ARI, returning "" on error.
func (c *Client) channelVar(ctx context.Context, id, name string) string {
	var out struct {
		Value string `json:"value"`
	}
	q := url.Values{}
	q.Set("variable", name)
	if err := c.do(ctx, http.MethodGet, "channels/"+id+"/variable", q, &out); err != nil {
		return ""
	}
	return out.Value
}

// ChannelRTP reads the audio RTP packet counters for a channel. Missing/na
// values come back as zero (e.g. before media is flowing).
func (c *Client) ChannelRTP(ctx context.Context, id string) RTPStats {
	rx := parseInt(c.channelVar(ctx, id, "CHANNEL(rtpqos,audio,rxcount)"))
	tx := parseInt(c.channelVar(ctx, id, "CHANNEL(rtpqos,audio,txcount)"))
	return RTPStats{Rx: rx, Tx: tx}
}

func parseInt(s string) int64 {
	n, _ := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	return n
}

// ReloadModule asks Asterisk to reload a module (e.g. "res_pjsip.so"). This is
// how the GUI applies configuration changes without a full restart.
func (c *Client) ReloadModule(ctx context.Context, module string) error {
	if module == "" {
		return fmt.Errorf("module is required")
	}
	return c.do(ctx, http.MethodPut, "asterisk/modules/"+module, nil, nil)
}

// Info is a slim view of ARI's /asterisk/info: version and lifecycle times.
type Info struct {
	System struct {
		Version  string `json:"version"`
		EntityID string `json:"entity_id"`
	} `json:"system"`
	Status struct {
		StartupTime    string `json:"startup_time"`
		LastReloadTime string `json:"last_reload_time"`
	} `json:"status"`
}

// AsteriskInfo returns version and status information about the running PBX.
func (c *Client) AsteriskInfo(ctx context.Context) (Info, error) {
	var info Info
	err := c.get(ctx, "asterisk/info", &info)
	return info, err
}

func orDefault(v, def string) string {
	if strings.TrimSpace(v) == "" {
		return def
	}
	return v
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
