package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Dashboard computes the analytics-dashboard rollups (Overview / Extension /
// Reports) from CDR plus the softphone telemetry + disposition rows. Live
// per-extension status (in-call/wrap/online) is layered on by the API handler,
// which has the ARI channel list.
type Dashboard struct {
	pool *pgxpool.Pool
}

// NewDashboard returns a Dashboard store bound to a connection pool.
func NewDashboard(pool *pgxpool.Pool) *Dashboard {
	return &Dashboard{pool: pool}
}

// LiveExtension is one row of the Active Extensions panel.
type LiveExtension struct {
	Extension   string `json:"extension"`
	DisplayName string `json:"displayName"`
	Status      string `json:"status"` // in_call | wrap | online
}

// ExtensionNames returns extension -> display name for internal endpoints.
func (s *Dashboard) ExtensionNames(ctx context.Context) (map[string]string, error) {
	out := map[string]string{}
	rows, err := s.pool.Query(ctx, `SELECT id, COALESCE(callerid,'') FROM ps_endpoints`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, cid string
		if err := rows.Scan(&id, &cid); err != nil {
			return out, err
		}
		out[id] = callerIDName(cid)
	}
	return out, rows.Err()
}

// RecentWrap returns the set of extensions whose most recent softphone call
// ended after `since` — i.e. agents currently in call wrap-up.
func (s *Dashboard) RecentWrap(ctx context.Context, since time.Time) (map[string]bool, error) {
	out := map[string]bool{}
	rows, err := s.pool.Query(ctx, `
		SELECT extension, max(at) FROM tpbx_softphone_events
		 WHERE event='call' GROUP BY extension
		HAVING max(at) >= $1`, since)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var ext string
		var at time.Time
		if err := rows.Scan(&ext, &at); err != nil {
			return out, err
		}
		out[ext] = true
	}
	return out, rows.Err()
}

// Slice is a labelled proportion (Nature of Calls, Hangup Causes).
type Slice struct {
	Label string  `json:"label"`
	Count int     `json:"count"`
	Pct   float64 `json:"pct"`
}

// VolumePoint is one day of inbound/outbound call counts.
type VolumePoint struct {
	Label    string `json:"label"`
	Inbound  int    `json:"inbound"`
	Outbound int    `json:"outbound"`
}

// Overview is the top dashboard view.
type Overview struct {
	TotalCalls     int           `json:"totalCalls"`
	AHTSeconds     int           `json:"ahtSeconds"`
	ResolutionRate float64       `json:"resolutionRate"` // 0..1 over tagged calls
	ResolutionN    int           `json:"resolutionN"`    // tagged calls in window
	OnlineDevices  int           `json:"onlineDevices"`
	Volume         []VolumePoint `json:"volume"`
}

const extInvolved = `(channel LIKE 'PJSIP/' || $1 || '-%' OR dstchannel LIKE 'PJSIP/' || $1 || '-%')`

func (s *Dashboard) OverviewStats(ctx context.Context, from, to time.Time) (Overview, error) {
	var o Overview
	// Total calls + AHT from CDR.
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*),
		       COALESCE(round(avg(billsec) FILTER (WHERE disposition='ANSWERED')),0)::int
		  FROM cdr WHERE calldate >= $1 AND calldate < $2`, from, to).
		Scan(&o.TotalCalls, &o.AHTSeconds); err != nil {
		return o, err
	}
	// Resolution rate from dispositions.
	var resolved int
	_ = s.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE resolution<>''),
		       count(*) FILTER (WHERE resolution='resolved')
		  FROM tpbx_softphone_events
		 WHERE event='call' AND at >= $1 AND at < $2`, from, to).Scan(&o.ResolutionN, &resolved)
	if o.ResolutionN > 0 {
		o.ResolutionRate = float64(resolved) / float64(o.ResolutionN)
	}
	// Online devices (registered contacts) — a proxy for active agents.
	_ = s.pool.QueryRow(ctx, `SELECT count(*) FROM ps_contacts`).Scan(&o.OnlineDevices)

	// Daily call volume, split inbound/outbound.
	o.Volume = []VolumePoint{}
	rows, err := s.pool.Query(ctx, `
		SELECT to_char(date_trunc('day', calldate), 'Mon DD') AS d,
		       count(*) FILTER (WHERE dstchannel LIKE 'PJSIP/%')                                           AS inbound,
		       count(*) FILTER (WHERE channel LIKE 'PJSIP/%' AND COALESCE(dstchannel,'') NOT LIKE 'PJSIP/%') AS outbound
		  FROM cdr WHERE calldate >= $1 AND calldate < $2
		 GROUP BY date_trunc('day', calldate) ORDER BY date_trunc('day', calldate)`, from, to)
	if err != nil {
		return o, err
	}
	defer rows.Close()
	for rows.Next() {
		var v VolumePoint
		if err := rows.Scan(&v.Label, &v.Inbound, &v.Outbound); err != nil {
			return o, err
		}
		o.Volume = append(o.Volume, v)
	}
	return o, rows.Err()
}

// TimelineItem is one entry in an extension's recent activity.
type TimelineItem struct {
	At     time.Time `json:"at"`
	Kind   string    `json:"kind"` // call | dnd | system
	Title  string    `json:"title"`
	Detail string    `json:"detail"`
}

// ExtensionDetail is the per-agent deep-dive view.
type ExtensionDetail struct {
	Extension      string         `json:"extension"`
	DisplayName    string         `json:"displayName"`
	AvgCallSeconds int            `json:"avgCallSeconds"`
	CallsToday     int            `json:"callsToday"`
	HangupRate     float64        `json:"hangupRate"`
	Nature         []Slice        `json:"nature"`
	HangupCauses   []Slice        `json:"hangupCauses"`
	Timeline       []TimelineItem `json:"timeline"`
}

func (s *Dashboard) ExtensionStats(ctx context.Context, ext string, from, to time.Time) (ExtensionDetail, error) {
	d := ExtensionDetail{Extension: ext, Nature: []Slice{}, HangupCauses: []Slice{}, Timeline: []TimelineItem{}}

	var callerid string
	_ = s.pool.QueryRow(ctx, `SELECT COALESCE(callerid,'') FROM ps_endpoints WHERE id=$1`, ext).Scan(&callerid)
	d.DisplayName = callerIDName(callerid)

	// Avg answered call time (CDR) for calls this extension took part in.
	_ = s.pool.QueryRow(ctx, `
		SELECT COALESCE(round(avg(billsec) FILTER (WHERE disposition='ANSWERED')),0)::int
		  FROM cdr WHERE calldate >= $2 AND calldate < $3 AND `+extInvolved,
		ext, from, to).Scan(&d.AvgCallSeconds)

	// Calls today (CDR).
	_ = s.pool.QueryRow(ctx, `
		SELECT count(*) FROM cdr
		 WHERE calldate >= date_trunc('day', now()) AND `+extInvolved, ext).Scan(&d.CallsToday)

	// Hangup rate = non-answered softphone calls / total, for this ext.
	var total, bad int
	_ = s.pool.QueryRow(ctx, `
		SELECT count(*), count(*) FILTER (WHERE outcome IN ('missed','rejected','failed'))
		  FROM tpbx_softphone_events
		 WHERE event='call' AND extension=$1 AND at >= $2 AND at < $3`, ext, from, to).Scan(&total, &bad)
	if total > 0 {
		d.HangupRate = float64(bad) / float64(total)
	}

	d.Nature = s.slices(ctx, ext, from, to, "nature")
	d.HangupCauses = s.slices(ctx, ext, from, to, "hangup_cause")

	// Recent activity timeline from softphone events.
	rows, err := s.pool.Query(ctx, `
		SELECT event, direction, peer, outcome, duration_sec, note, at
		  FROM tpbx_softphone_events
		 WHERE extension=$1 AND at >= $2 AND at < $3
		 ORDER BY at DESC LIMIT 12`, ext, from, to)
	if err != nil {
		return d, err
	}
	defer rows.Close()
	for rows.Next() {
		var event, dir, peer, outcome, note string
		var dur int
		var at time.Time
		if err := rows.Scan(&event, &dir, &peer, &outcome, &dur, &note, &at); err != nil {
			return d, err
		}
		d.Timeline = append(d.Timeline, timelineItem(event, dir, peer, outcome, dur, note, at))
	}
	return d, rows.Err()
}

// slices returns a labelled proportion breakdown for a disposition column.
func (s *Dashboard) slices(ctx context.Context, ext string, from, to time.Time, col string) []Slice {
	out := []Slice{}
	rows, err := s.pool.Query(ctx, fmt.Sprintf(`
		SELECT %s, count(*) FROM tpbx_softphone_events
		 WHERE event='call' AND extension=$1 AND %s <> '' AND at >= $2 AND at < $3
		 GROUP BY %s ORDER BY count(*) DESC`, col, col, col), ext, from, to)
	if err != nil {
		return out
	}
	defer rows.Close()
	total := 0
	type kc struct {
		k string
		c int
	}
	var list []kc
	for rows.Next() {
		var k string
		var c int
		if err := rows.Scan(&k, &c); err != nil {
			return out
		}
		list = append(list, kc{k, c})
		total += c
	}
	for _, e := range list {
		pct := 0.0
		if total > 0 {
			pct = float64(e.c) / float64(total)
		}
		out = append(out, Slice{Label: e.k, Count: e.c, Pct: pct})
	}
	return out
}

func timelineItem(event, dir, peer, outcome string, dur int, note string, at time.Time) TimelineItem {
	switch event {
	case "call":
		title := "Call"
		if dir == "in" {
			title = "Incoming call"
		} else if dir == "out" {
			title = "Outgoing call"
		}
		detail := fmt.Sprintf("%s · %s", peer, outcome)
		if outcome == "answered" && dur > 0 {
			detail += fmt.Sprintf(" · %dm %ds", dur/60, dur%60)
		}
		if note != "" {
			detail += " — " + note
		}
		return TimelineItem{At: at, Kind: "call", Title: title, Detail: detail}
	case "dnd_on":
		return TimelineItem{At: at, Kind: "dnd", Title: "Do Not Disturb on", Detail: ""}
	case "dnd_off":
		return TimelineItem{At: at, Kind: "dnd", Title: "Do Not Disturb off", Detail: ""}
	case "registered":
		return TimelineItem{At: at, Kind: "system", Title: "Registered", Detail: ""}
	default:
		return TimelineItem{At: at, Kind: "system", Title: event, Detail: ""}
	}
}

// RankRow is one agent in the performance ranking.
type RankRow struct {
	Extension      string  `json:"extension"`
	DisplayName    string  `json:"displayName"`
	AHTSeconds     int     `json:"ahtSeconds"`
	ResolutionRate float64 `json:"resolutionRate"`
	Trend          string  `json:"trend"` // up | down | flat
}

// Reports is the reports view.
type Reports struct {
	PeakVolume         int       `json:"peakVolume"`
	CommonHangupReason string    `json:"commonHangupReason"`
	TopExtension       string    `json:"topExtension"`
	TopExtensionName   string    `json:"topExtensionName"`
	TopExtensionRate   float64   `json:"topExtensionRate"`
	ThisWeek           []int     `json:"thisWeek"`
	LastWeek           []int     `json:"lastWeek"`
	Insights           []string  `json:"insights"`
	Ranking            []RankRow `json:"ranking"`
}

func (s *Dashboard) ReportsStats(ctx context.Context, from, to time.Time) (Reports, error) {
	r := Reports{ThisWeek: []int{}, LastWeek: []int{}, Insights: []string{}, Ranking: []RankRow{}}

	// Peak daily volume in window.
	_ = s.pool.QueryRow(ctx, `
		SELECT COALESCE(max(c),0) FROM (
		  SELECT count(*) c FROM cdr WHERE calldate >= $1 AND calldate < $2
		   GROUP BY date_trunc('day', calldate)) t`, from, to).Scan(&r.PeakVolume)

	// Common hangup reason (top disposition cause).
	_ = s.pool.QueryRow(ctx, `
		SELECT hangup_cause FROM tpbx_softphone_events
		 WHERE event='call' AND hangup_cause <> '' AND at >= $1 AND at < $2
		 GROUP BY hangup_cause ORDER BY count(*) DESC LIMIT 1`, from, to).Scan(&r.CommonHangupReason)

	// Top extension by resolution rate (min 3 tagged calls).
	_ = s.pool.QueryRow(ctx, `
		SELECT e.extension, COALESCE(ep.callerid,''),
		       avg(CASE WHEN resolution='resolved' THEN 1.0 ELSE 0.0 END)
		  FROM tpbx_softphone_events e
		  LEFT JOIN ps_endpoints ep ON ep.id = e.extension
		 WHERE e.event='call' AND e.resolution <> '' AND e.at >= $1 AND e.at < $2
		 GROUP BY e.extension, ep.callerid
		HAVING count(*) >= 3
		 ORDER BY 3 DESC LIMIT 1`, from, to).Scan(&r.TopExtension, &r.TopExtensionName, &r.TopExtensionRate)
	r.TopExtensionName = callerIDName(r.TopExtensionName)

	// This week vs last week daily counts (7 points each).
	now := time.Now()
	thisStart := now.AddDate(0, 0, -7)
	lastStart := now.AddDate(0, 0, -14)
	r.ThisWeek = s.dailyCounts(ctx, thisStart, now)
	r.LastWeek = s.dailyCounts(ctx, lastStart, thisStart)

	// Agent ranking: AHT + resolution rate + trend (this vs last week AHT).
	r.Ranking = s.ranking(ctx, from, to, thisStart, now, lastStart, thisStart)

	// Simple computed insights.
	tw, lw := sum(r.ThisWeek), sum(r.LastWeek)
	if lw > 0 {
		delta := int(float64(tw-lw) / float64(lw) * 100)
		if delta >= 10 {
			r.Insights = append(r.Insights, fmt.Sprintf("Call volume up %d%% vs last week.", delta))
		} else if delta <= -10 {
			r.Insights = append(r.Insights, fmt.Sprintf("Call volume down %d%% vs last week.", -delta))
		}
	}
	if r.CommonHangupReason != "" {
		r.Insights = append(r.Insights, "Most common hangup cause: "+r.CommonHangupReason+".")
	}
	if len(r.Insights) == 0 {
		r.Insights = append(r.Insights, "Not enough tagged calls yet for trend insights.")
	}
	return r, nil
}

func (s *Dashboard) dailyCounts(ctx context.Context, from, to time.Time) []int {
	out := make([]int, 7)
	rows, err := s.pool.Query(ctx, `
		SELECT date_trunc('day', calldate) d, count(*) FROM cdr
		 WHERE calldate >= $1 AND calldate < $2
		 GROUP BY d ORDER BY d`, from, to)
	if err != nil {
		return out
	}
	defer rows.Close()
	i := 0
	for rows.Next() && i < 7 {
		var d time.Time
		var c int
		if err := rows.Scan(&d, &c); err != nil {
			return out
		}
		out[i] = c
		i++
	}
	return out
}

func (s *Dashboard) ranking(ctx context.Context, from, to, twFrom, twTo, lwFrom, lwTo time.Time) []RankRow {
	out := []RankRow{}
	rows, err := s.pool.Query(ctx, `
		SELECT e.extension, COALESCE(ep.callerid,''),
		       COALESCE(round(avg(c.billsec) FILTER (WHERE c.disposition='ANSWERED')),0)::int AS aht,
		       avg(CASE WHEN e.resolution='resolved' THEN 1.0 WHEN e.resolution='unresolved' THEN 0.0 END) AS res
		  FROM tpbx_softphone_events e
		  LEFT JOIN ps_endpoints ep ON ep.id = e.extension
		  LEFT JOIN cdr c ON (c.channel LIKE 'PJSIP/' || e.extension || '-%'
		                   OR c.dstchannel LIKE 'PJSIP/' || e.extension || '-%')
		                 AND c.calldate >= $1 AND c.calldate < $2
		 WHERE e.event='call' AND e.at >= $1 AND e.at < $2
		 GROUP BY e.extension, ep.callerid
		 ORDER BY res DESC NULLS LAST, aht ASC
		 LIMIT 10`, from, to)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var row RankRow
		var res *float64
		if err := rows.Scan(&row.Extension, &row.DisplayName, &row.AHTSeconds, &res); err != nil {
			return out
		}
		row.DisplayName = callerIDName(row.DisplayName)
		if res != nil {
			row.ResolutionRate = *res
		}
		row.Trend = s.trend(ctx, row.Extension, twFrom, twTo, lwFrom, lwTo)
		out = append(out, row)
	}
	return out
}

// trend compares this-week vs last-week answered AHT for an extension.
func (s *Dashboard) trend(ctx context.Context, ext string, twFrom, twTo, lwFrom, lwTo time.Time) string {
	q := `SELECT COALESCE(round(avg(billsec) FILTER (WHERE disposition='ANSWERED')),0)::int
	        FROM cdr WHERE calldate >= $2 AND calldate < $3 AND ` + extInvolved
	var twv, lwv int
	_ = s.pool.QueryRow(ctx, q, ext, twFrom, twTo).Scan(&twv)
	_ = s.pool.QueryRow(ctx, q, ext, lwFrom, lwTo).Scan(&lwv)
	if lwv == 0 {
		return "flat"
	}
	if twv < lwv-5 {
		return "up" // lower handle time is better
	}
	if twv > lwv+5 {
		return "down"
	}
	return "flat"
}

func sum(xs []int) int {
	t := 0
	for _, x := range xs {
		t += x
	}
	return t
}
