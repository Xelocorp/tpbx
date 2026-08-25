package store

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// SoftphoneStore records and aggregates telemetry from the desktop softphone
// (DND toggles, registration, per-call outcomes). See migration 0021 for why
// these live here rather than being derived from CDR.
type SoftphoneStore struct {
	pool *pgxpool.Pool
}

// NewSoftphone returns a SoftphoneStore bound to a connection pool.
func NewSoftphone(pool *pgxpool.Pool) *SoftphoneStore {
	return &SoftphoneStore{pool: pool}
}

// SoftphoneEvent is a single telemetry record reported by an agent's softphone.
type SoftphoneEvent struct {
	Extension   string `json:"-"` // taken from the agent session, never the body
	Event       string `json:"event"`
	Direction   string `json:"direction"`
	Peer        string `json:"peer"`
	Outcome     string `json:"outcome"`
	DurationSec int    `json:"durationSec"`
	Transport   string `json:"transport"`
	// Disposition (post-call wrap-up), only meaningful on a 'call' event.
	Nature      string `json:"nature"`      // technical | billing | sales | other
	Resolution  string `json:"resolution"`  // resolved | unresolved
	HangupCause string `json:"hangupCause"` // user_frustration | technical_drop | other
	Note        string `json:"note"`
}

var validSoftphoneEvents = map[string]bool{
	"call": true, "dnd_on": true, "dnd_off": true, "registered": true, "unregistered": true,
}

// Record validates and inserts a telemetry event. Unknown event names are
// ignored (return nil) so a newer client can't fail against an older server.
func (s *SoftphoneStore) Record(ctx context.Context, ev SoftphoneEvent) error {
	if ev.Extension == "" || !validSoftphoneEvents[ev.Event] {
		return nil
	}
	if ev.DurationSec < 0 {
		ev.DurationSec = 0
	}
	// Clamp free-text fields defensively (column widths in migrations 0021/0022).
	ev.Peer = truncate(ev.Peer, 128)
	ev.Direction = truncate(ev.Direction, 8)
	ev.Outcome = truncate(ev.Outcome, 16)
	ev.Transport = truncate(ev.Transport, 8)
	ev.Nature = truncate(ev.Nature, 24)
	ev.Resolution = truncate(ev.Resolution, 16)
	ev.HangupCause = truncate(ev.HangupCause, 24)
	ev.Note = truncate(ev.Note, 500)
	_, err := s.pool.Exec(ctx, `
		INSERT INTO tpbx_softphone_events
		    (extension, event, direction, peer, outcome, duration_sec, transport,
		     nature, resolution, hangup_cause, note)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
		ev.Extension, ev.Event, ev.Direction, ev.Peer, ev.Outcome, ev.DurationSec, ev.Transport,
		ev.Nature, ev.Resolution, ev.HangupCause, ev.Note)
	return err
}

// TaggableCall is a recent CDR call that a supervisor can wrap-up-tag from the
// console, so calls placed on ANY softphone can still get Nature/Resolution/
// Hangup-cause dispositions feeding the analytics.
type TaggableCall struct {
	ID          string    `json:"id"`
	Extension   string    `json:"extension"`
	DisplayName string    `json:"displayName"`
	Direction   string    `json:"direction"` // in | out
	Peer        string    `json:"peer"`
	Disposition string    `json:"disposition"` // CDR disposition (ANSWERED/…)
	DurationSec int       `json:"durationSec"`
	At          time.Time `json:"at"`
	Tagged      bool      `json:"tagged"`
}

// UntaggedCalls lists recent CDR calls in [from,to) (optionally one extension),
// each flagged whether a disposition has already been recorded for it.
func (s *SoftphoneStore) UntaggedCalls(ctx context.Context, from, to time.Time, ext string) ([]TaggableCall, error) {
	out := []TaggableCall{}
	args := []any{from, to}
	extFilter := ""
	if ext != "" {
		extFilter = " AND calls.ext = $3"
		args = append(args, ext)
	}
	rows, err := s.pool.Query(ctx, `
		WITH calls AS (
		  SELECT c.uniqueid AS id, c.calldate AS at, c.disposition AS disp, c.billsec AS billsec,
		         CASE WHEN c.dstchannel LIKE 'PJSIP/%' THEN 'in' ELSE 'out' END AS dir,
		         CASE WHEN c.dstchannel LIKE 'PJSIP/%'
		              THEN substring(c.dstchannel from 'PJSIP/([^-]+)-')
		              ELSE substring(c.channel  from 'PJSIP/([^-]+)-') END AS ext,
		         CASE WHEN c.dstchannel LIKE 'PJSIP/%' THEN c.src ELSE c.dst END AS peer
		    FROM cdr c
		   WHERE c.calldate >= $1 AND c.calldate < $2
		     AND (c.channel LIKE 'PJSIP/%' OR c.dstchannel LIKE 'PJSIP/%')
		)
		SELECT calls.id, calls.at, calls.disp, calls.billsec, calls.dir,
		       COALESCE(calls.ext,''), COALESCE(ep.callerid,''), COALESCE(calls.peer,''),
		       EXISTS(SELECT 1 FROM tpbx_softphone_events e
		               WHERE e.event='call' AND e.resolution <> ''
		                 AND e.extension = calls.ext AND e.peer = calls.peer
		                 AND e.at BETWEEN calls.at - interval '5 min' AND calls.at + interval '5 min') AS tagged
		  FROM calls
		  LEFT JOIN ps_endpoints ep ON ep.id = calls.ext
		 WHERE calls.ext IS NOT NULL`+extFilter+`
		 ORDER BY calls.at DESC LIMIT 200`, args...)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var c TaggableCall
		var callerid string
		if err := rows.Scan(&c.ID, &c.At, &c.Disposition, &c.DurationSec, &c.Direction,
			&c.Extension, &callerid, &c.Peer, &c.Tagged); err != nil {
			return out, err
		}
		c.DisplayName = callerIDName(callerid)
		out = append(out, c)
	}
	return out, rows.Err()
}

// TagCall records a wrap-up disposition for a (possibly past) call, timestamped
// at the call time so it lands in the right analytics window. Used by the web
// wrap-up panel for any-softphone agents.
func (s *SoftphoneStore) TagCall(ctx context.Context, ev SoftphoneEvent, at time.Time) error {
	if ev.Extension == "" {
		return nil
	}
	if ev.DurationSec < 0 {
		ev.DurationSec = 0
	}
	if at.IsZero() {
		at = time.Now()
	}
	outcome := ev.Outcome
	if outcome == "" {
		outcome = "answered"
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO tpbx_softphone_events
		    (extension, event, direction, peer, outcome, duration_sec, transport,
		     nature, resolution, hangup_cause, note, at)
		VALUES ($1,'call',$2,$3,$4,$5,'wrapup',$6,$7,$8,$9,$10)`,
		ev.Extension, truncate(ev.Direction, 8), truncate(ev.Peer, 128), truncate(outcome, 16),
		ev.DurationSec, truncate(ev.Nature, 24), truncate(ev.Resolution, 16),
		truncate(ev.HangupCause, 24), truncate(ev.Note, 500), at)
	return err
}

// AgentCalls returns an agent's recent calls (newest first) from the persisted
// telemetry, so the softphone's Recents survives re-login, restart and device
// changes. Limit is capped.
func (s *SoftphoneStore) AgentCalls(ctx context.Context, ext string, limit int) ([]SoftphoneCall, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	rows, err := s.pool.Query(ctx, `
		SELECT direction, peer, outcome, duration_sec, transport, at
		  FROM tpbx_softphone_events
		 WHERE event='call' AND extension=$1
		 ORDER BY at DESC LIMIT $2`, ext, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SoftphoneCall{}
	for rows.Next() {
		var c SoftphoneCall
		if err := rows.Scan(&c.Direction, &c.Peer, &c.Outcome, &c.DurationSec, &c.Transport, &c.At); err != nil {
			return nil, err
		}
		c.Extension = ext
		out = append(out, c)
	}
	return out, rows.Err()
}

// ClearAgentCalls deletes an agent's call log (their Recents). Deliberate and
// destructive — this also removes those calls from analytics.
func (s *SoftphoneStore) ClearAgentCalls(ctx context.Context, ext string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM tpbx_softphone_events WHERE event='call' AND extension=$1`, ext)
	return err
}

// SoftphoneAgent is the per-agent softphone rollup for a window.
type SoftphoneAgent struct {
	Extension      string `json:"extension"`
	DisplayName    string `json:"displayName"`
	Answered       int    `json:"answered"`
	Rejected       int    `json:"rejected"`
	Missed         int    `json:"missed"`
	Failed         int    `json:"failed"`
	Inbound        int    `json:"inbound"`
	Outbound       int    `json:"outbound"`
	TalkTotal      int    `json:"talkTotal"` // seconds
	TalkAvg        int    `json:"talkAvg"`   // seconds, over answered
	Longest        int    `json:"longest"`   // seconds
	DndActivations int    `json:"dndActivations"`
	DndSeconds     int    `json:"dndSeconds"`
}

// SoftphoneCall is one entry in the recent call log.
type SoftphoneCall struct {
	Extension   string    `json:"extension"`
	DisplayName string    `json:"displayName"`
	Direction   string    `json:"direction"`
	Peer        string    `json:"peer"`
	Outcome     string    `json:"outcome"`
	DurationSec int       `json:"durationSec"`
	Transport   string    `json:"transport"`
	At          time.Time `json:"at"`
}

// SoftphoneStats bundles what the Analytics page needs.
type SoftphoneStats struct {
	Agents []SoftphoneAgent `json:"agents"`
	Recent []SoftphoneCall  `json:"recent"`
}

// Stats computes per-agent softphone rollups and a recent call log over
// [from, to). Only agents that reported at least one event in the window appear.
func (s *SoftphoneStore) Stats(ctx context.Context, from, to time.Time) (SoftphoneStats, error) {
	out := SoftphoneStats{Agents: []SoftphoneAgent{}, Recent: []SoftphoneCall{}}

	// Per-agent call rollup.
	byExt := map[string]*SoftphoneAgent{}
	rows, err := s.pool.Query(ctx, `
		SELECT e.extension, COALESCE(ep.callerid,''),
		       count(*) FILTER (WHERE outcome='answered')            AS answered,
		       count(*) FILTER (WHERE outcome='rejected')            AS rejected,
		       count(*) FILTER (WHERE outcome='missed')              AS missed,
		       count(*) FILTER (WHERE outcome='failed')              AS failed,
		       count(*) FILTER (WHERE direction='in')                AS inbound,
		       count(*) FILTER (WHERE direction='out')               AS outbound,
		       COALESCE(sum(duration_sec) FILTER (WHERE outcome='answered'),0) AS talk_total,
		       COALESCE(max(duration_sec),0)                         AS longest
		  FROM tpbx_softphone_events e
		  LEFT JOIN ps_endpoints ep ON ep.id = e.extension
		 WHERE e.event='call' AND e.at >= $1 AND e.at < $2
		 GROUP BY e.extension, ep.callerid`, from, to)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var a SoftphoneAgent
		var callerid string
		if err := rows.Scan(&a.Extension, &callerid, &a.Answered, &a.Rejected, &a.Missed,
			&a.Failed, &a.Inbound, &a.Outbound, &a.TalkTotal, &a.Longest); err != nil {
			rows.Close()
			return out, err
		}
		a.DisplayName = callerIDName(callerid)
		if a.Answered > 0 {
			a.TalkAvg = a.TalkTotal / a.Answered
		}
		byExt[a.Extension] = &a
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}

	// DND: count activations and total DND seconds by pairing dnd_on -> dnd_off
	// per extension in time order.
	if err := s.foldDND(ctx, from, to, byExt); err != nil {
		return out, err
	}

	for _, a := range byExt {
		out.Agents = append(out.Agents, *a)
	}
	sort.Slice(out.Agents, func(i, j int) bool { return out.Agents[i].Extension < out.Agents[j].Extension })

	// Recent call log.
	crows, err := s.pool.Query(ctx, `
		SELECT e.extension, COALESCE(ep.callerid,''), e.direction, e.peer, e.outcome,
		       e.duration_sec, e.transport, e.at
		  FROM tpbx_softphone_events e
		  LEFT JOIN ps_endpoints ep ON ep.id = e.extension
		 WHERE e.event='call' AND e.at >= $1 AND e.at < $2
		 ORDER BY e.at DESC
		 LIMIT 300`, from, to)
	if err != nil {
		return out, err
	}
	defer crows.Close()
	for crows.Next() {
		var c SoftphoneCall
		var callerid string
		if err := crows.Scan(&c.Extension, &callerid, &c.Direction, &c.Peer, &c.Outcome,
			&c.DurationSec, &c.Transport, &c.At); err != nil {
			return out, err
		}
		c.DisplayName = callerIDName(callerid)
		out.Recent = append(out.Recent, c)
	}
	return out, crows.Err()
}

// foldDND pairs dnd_on/dnd_off events per extension to derive activation counts
// and total DND time. An unpaired dnd_on (still on at window end) is counted up
// to `to`.
func (s *SoftphoneStore) foldDND(ctx context.Context, from, to time.Time, byExt map[string]*SoftphoneAgent) error {
	rows, err := s.pool.Query(ctx, `
		SELECT extension, event, at
		  FROM tpbx_softphone_events
		 WHERE event IN ('dnd_on','dnd_off') AND at >= $1 AND at < $2
		 ORDER BY extension, at`, from, to)
	if err != nil {
		return err
	}
	defer rows.Close()

	openOn := map[string]time.Time{}
	ensure := func(ext string) *SoftphoneAgent {
		a := byExt[ext]
		if a == nil {
			a = &SoftphoneAgent{Extension: ext}
			byExt[ext] = a
		}
		return a
	}
	for rows.Next() {
		var ext, event string
		var at time.Time
		if err := rows.Scan(&ext, &event, &at); err != nil {
			return err
		}
		a := ensure(ext)
		if event == "dnd_on" {
			a.DndActivations++
			if _, open := openOn[ext]; !open {
				openOn[ext] = at
			}
		} else { // dnd_off
			if start, open := openOn[ext]; open {
				a.DndSeconds += int(at.Sub(start).Seconds())
				delete(openOn, ext)
			}
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	// DND still on at window end.
	for ext, start := range openOn {
		ensure(ext).DndSeconds += int(to.Sub(start).Seconds())
	}
	// Fill display names for DND-only agents (no call rows).
	for ext, a := range byExt {
		if a.DisplayName == "" {
			var callerid string
			if err := s.pool.QueryRow(ctx, `SELECT COALESCE(callerid,'') FROM ps_endpoints WHERE id=$1`, ext).Scan(&callerid); err == nil {
				a.DisplayName = callerIDName(callerid)
			}
		}
	}
	return nil
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		return s[:n]
	}
	return s
}
