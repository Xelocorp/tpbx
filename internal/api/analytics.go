package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/td425/tpbx/internal/store"
)

// extFromChannel pulls the extension out of an ARI channel name like
// "PJSIP/1001-00000abc" -> "1001".
func extFromChannel(name string) string {
	if !strings.HasPrefix(name, "PJSIP/") {
		return ""
	}
	rest := name[len("PJSIP/"):]
	if i := strings.IndexByte(rest, '-'); i >= 0 {
		return rest[:i]
	}
	return rest
}

// handleAnalyticsOverview returns the dashboard Overview: headline stats, the
// call-volume series, and the live Active Extensions list (in-call from ARI,
// wrap-up from recent call ends, else online from presence).
func (s *Server) handleAnalyticsOverview(w http.ResponseWriter, r *http.Request) {
	from, to := parseWindow(r)
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	ov, err := s.Dashboard.OverviewStats(ctx, from, to)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	// Call-center (queue/ACD) KPIs — optional ?queue= filter; SLA from the query
	// (?sla=) else the global System setting (default 20s).
	q := r.URL.Query()
	slaDefault := 20
	if sys, serr := s.System.Get(ctx); serr == nil && sys.SLASeconds > 0 {
		slaDefault = sys.SLASeconds
	}
	cc, _ := s.Dashboard.CallCenterStats(ctx, from, to, q.Get("queue"), atoiDefault(q.Get("sla"), slaDefault))
	queues := s.Dashboard.QueueNames(ctx)

	names, _ := s.Dashboard.ExtensionNames(ctx)
	presence, _ := s.Ext.Status(ctx)
	wrap, _ := s.Dashboard.RecentWrap(ctx, time.Now().Add(-30*time.Second))
	inCall := map[string]bool{}
	liveIvr, liveTransfer := 0, 0
	if chans, cerr := s.ARI.Channels(ctx); cerr == nil {
		for _, ch := range chans {
			if ext := extFromChannel(ch.Name); ext != "" {
				inCall[ext] = true
			}
			switch strings.ToLower(ch.Dialplan.AppName) {
			case "background", "backgrounddetect", "playback", "read", "waitexten", "authenticate", "ivr":
				liveIvr++
			case "transfer", "attendedtransfer", "bridgewait":
				liveTransfer++
			}
		}
	}
	live := []store.LiveExtension{}
	for ext, st := range presence {
		if !st.Online && !inCall[ext] {
			continue
		}
		status := "online"
		if inCall[ext] {
			status = "in_call"
		} else if wrap[ext] {
			status = "wrap"
		}
		live = append(live, store.LiveExtension{Extension: ext, DisplayName: names[ext], Status: status})
	}
	sort.Slice(live, func(i, j int) bool {
		rank := map[string]int{"in_call": 0, "wrap": 1, "online": 2}
		if rank[live[i].Status] != rank[live[j].Status] {
			return rank[live[i].Status] < rank[live[j].Status]
		}
		return live[i].Extension < live[j].Extension
	})

	// Present Call Status + Agent status (live). Talking is the number of agent
	// legs currently up (ARI); In Queue comes from open queue_log sessions.
	online, onCall := 0, len(inCall)
	for _, st := range presence {
		if st.Online {
			online++
		}
	}
	present := map[string]int{
		"inIvr":        liveIvr,      // callers in IVR apps (ARI dialplan)
		"inQueue":      cc.InQueue,   // open queue_log sessions
		"transferring": liveTransfer, // channels in a transfer app
		"talking":      onCall,       // agent legs currently up
	}
	agents := map[string]int{
		"total":  len(presence),
		"online": online,
		"onCall": onCall,
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"from":       from.Format(time.RFC3339),
		"to":         to.Format(time.RFC3339),
		"overview":   ov,
		"callcenter": cc,
		"queues":     queues,
		"present":    present,
		"agents":     agents,
		"live":       live,
	})
}

// handleAnalyticsExtension returns the per-extension deep-dive view.
func (s *Server) handleAnalyticsExtension(w http.ResponseWriter, r *http.Request) {
	ext := chi.URLParam(r, "ext")
	from, to := parseWindow(r)
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	d, err := s.Dashboard.ExtensionStats(ctx, ext, from, to)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, d)
}

// handleAnalyticsReports returns the Reports view.
func (s *Server) handleAnalyticsReports(w http.ResponseWriter, r *http.Request) {
	from, to := parseWindow(r)
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	rep, err := s.Dashboard.ReportsStats(ctx, from, to)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

// handleAgentAnalytics returns per-agent call stats for a time window. The
// window is given by ?from=&to= (RFC3339) or ?days=N; it defaults to the last
// 7 days.
func (s *Server) handleAgentAnalytics(w http.ResponseWriter, r *http.Request) {
	from, to := parseWindow(r)
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	agents, err := s.Analytics.AgentStats(ctx, from, to)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"from":   from.Format(time.RFC3339),
		"to":     to.Format(time.RFC3339),
		"agents": agents,
	})
}

// handleSoftphoneAnalytics returns per-agent softphone telemetry rollups (DND,
// answered/rejected/missed, talk time) and a recent call log for a window.
func (s *Server) handleSoftphoneAnalytics(w http.ResponseWriter, r *http.Request) {
	from, to := parseWindow(r)
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	stats, err := s.Softphone.Stats(ctx, from, to)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"from":   from.Format(time.RFC3339),
		"to":     to.Format(time.RFC3339),
		"agents": stats.Agents,
		"recent": stats.Recent,
	})
}

// handleWrapupCalls lists recent calls (from CDR) that a supervisor can tag with
// a disposition — so calls placed on any softphone still feed the analytics.
func (s *Server) handleWrapupCalls(w http.ResponseWriter, r *http.Request) {
	from, to := parseWindow(r)
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	calls, err := s.Softphone.UntaggedCalls(ctx, from, to, r.URL.Query().Get("ext"))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"calls": calls})
}

// handleWrapupTag records a disposition for a past call (timestamped at the call
// time so it lands in the right window).
func (s *Server) handleWrapupTag(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Extension   string `json:"extension"`
		Direction   string `json:"direction"`
		Peer        string `json:"peer"`
		Outcome     string `json:"outcome"`
		DurationSec int    `json:"durationSec"`
		At          string `json:"at"` // RFC3339 call time
		Nature      string `json:"nature"`
		Resolution  string `json:"resolution"`
		HangupCause string `json:"hangupCause"`
		Note        string `json:"note"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.Extension == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "extension required"})
		return
	}
	at, _ := time.Parse(time.RFC3339, body.At)
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	err := s.Softphone.TagCall(ctx, store.SoftphoneEvent{
		Extension:   body.Extension,
		Direction:   body.Direction,
		Peer:        body.Peer,
		Outcome:     body.Outcome,
		DurationSec: body.DurationSec,
		Nature:      body.Nature,
		Resolution:  body.Resolution,
		HangupCause: body.HangupCause,
		Note:        body.Note,
	}, at)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// parseWindow resolves the reporting window from the query string: an explicit
// ?from=&to= (RFC3339) wins, otherwise a rolling ?days=N (default 7).
func parseWindow(r *http.Request) (time.Time, time.Time) {
	q := r.URL.Query()
	from, fromErr := time.Parse(time.RFC3339, q.Get("from"))
	to, toErr := time.Parse(time.RFC3339, q.Get("to"))
	if fromErr == nil && toErr == nil && to.After(from) {
		return from, to
	}
	days := atoiDefault(q.Get("days"), 7)
	if days <= 0 || days > 366 {
		days = 7
	}
	now := time.Now()
	return now.AddDate(0, 0, -days), now
}

func atoiDefault(s string, def int) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return def
		}
		n = n*10 + int(c-'0')
	}
	if s == "" {
		return def
	}
	return n
}
