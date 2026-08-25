package events

import (
	"encoding/json"
	"strings"
)

// ariChannel is the subset of an ARI channel object we surface on events.
type ariChannel struct {
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
	Dialplan struct {
		Context string `json:"context"`
		Exten   string `json:"exten"`
	} `json:"dialplan"`
}

// TranslateARI maps a raw ARI event to a semantic bus event. It returns ok=false
// for ARI events we do not surface (bridges, playback, etc.), so the caller can
// skip publishing. The mapping is intentionally small and stable — external
// integrations code against these names, not Asterisk's internal event zoo.
func TranslateARI(ariType string, raw json.RawMessage) (evType string, data map[string]any, ok bool) {
	var env struct {
		Channel ariChannel `json:"channel"`
	}
	_ = json.Unmarshal(raw, &env)
	ch := env.Channel

	switch ariType {
	case "ChannelCreated", "StasisStart":
		evType = "call.started"
	case "ChannelStateChange":
		if !strings.EqualFold(ch.State, "Up") {
			return "", nil, false
		}
		evType = "call.answered"
	case "ChannelDestroyed", "StasisEnd":
		evType = "call.ended"
	default:
		return "", nil, false
	}

	if ch.ID == "" {
		// No channel payload (shouldn't happen for these types) — nothing useful
		// to hand a consumer.
		return "", nil, false
	}
	data = map[string]any{
		"channelId":       ch.ID,
		"channel":         ch.Name,
		"extension":       extFromChannelName(ch.Name),
		"state":           ch.State,
		"callerNumber":    ch.Caller.Number,
		"callerName":      ch.Caller.Name,
		"connectedNumber": ch.Connected.Number,
		"context":         ch.Dialplan.Context,
		"exten":           ch.Dialplan.Exten,
	}
	return evType, data, true
}

// extFromChannelName pulls "1001" out of "PJSIP/1001-00000abc".
func extFromChannelName(name string) string {
	if !strings.HasPrefix(name, "PJSIP/") {
		return ""
	}
	rest := name[len("PJSIP/"):]
	if i := strings.IndexByte(rest, '-'); i >= 0 {
		return rest[:i]
	}
	return rest
}
