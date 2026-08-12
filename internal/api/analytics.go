package api

import (
	"context"
	"net/http"
	"time"
)

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
