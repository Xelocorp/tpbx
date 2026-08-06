package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Analytics computes call-centre reporting from the CDR and CEL tables. An
// "agent" is an internal extension; its Asterisk channel looks like
// "PJSIP/<ext>-<suffix>", so the extension is recovered from channel names with
// split_part(split_part(name,'/',2),'-',1).
type Analytics struct {
	pool *pgxpool.Pool
}

// NewAnalytics returns an Analytics store bound to a connection pool.
func NewAnalytics(pool *pgxpool.Pool) *Analytics {
	return &Analytics{pool: pool}
}

// AgentStat is the per-agent rollup for a time window.
type AgentStat struct {
	Extension     string `json:"extension"`
	DisplayName   string `json:"displayName"`
	Calls         int    `json:"calls"`         // calls the agent took part in
	Answered      int    `json:"answered"`      // disposition ANSWERED
	Inbound       int    `json:"inbound"`       // agent was the called party
	Outbound      int    `json:"outbound"`      // agent placed the call
	Missed        int    `json:"missed"`        // inbound, NO ANSWER/BUSY
	TalkTotal     int    `json:"talkTotal"`     // seconds, sum of billsec
	TalkAvg       int    `json:"talkAvg"`       // seconds, avg over answered
	Longest       int    `json:"longest"`       // seconds, max billsec
	Transfers     int    `json:"transfers"`     // blind/attended transfers initiated
	HangupByAgent int    `json:"hangupByAgent"` // calls the agent ended first
	HangupByOther int    `json:"hangupByOther"` // calls the other party ended first
}

// AgentStats returns per-agent rollups over [from, to). Agents with no calls in
// the window still appear (with zeros), so a manager sees the whole team.
func (s *Analytics) AgentStats(ctx context.Context, from, to time.Time) ([]AgentStat, error) {
	// Base roster: internal extensions (excludes trunks, which use from-trunk).
	rows, err := s.pool.Query(ctx, `
		SELECT id, COALESCE(callerid,'')
		  FROM ps_endpoints
		 WHERE COALESCE(context,'') = 'from-internal'
		 ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	order := []string{}
	byExt := map[string]*AgentStat{}
	for rows.Next() {
		var id, cid string
		if err := rows.Scan(&id, &cid); err != nil {
			return nil, err
		}
		name := callerIDName(cid)
		if name == "" {
			name = id
		}
		byExt[id] = &AgentStat{Extension: id, DisplayName: name}
		order = append(order, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	get := func(ext string) *AgentStat {
		if a, ok := byExt[ext]; ok {
			return a
		}
		a := &AgentStat{Extension: ext, DisplayName: ext}
		byExt[ext] = a
		order = append(order, ext)
		return a
	}

	// Core CDR metrics, one row per call-leg the agent was on.
	core, err := s.pool.Query(ctx, `
		WITH legs AS (
		    SELECT split_part(split_part(channel,'/',2),'-',1) AS agent,
		           'out' AS dir, disposition, billsec
		      FROM cdr WHERE channel LIKE 'PJSIP/%' AND calldate >= $1 AND calldate < $2
		    UNION ALL
		    SELECT split_part(split_part(dstchannel,'/',2),'-',1) AS agent,
		           'in' AS dir, disposition, billsec
		      FROM cdr WHERE dstchannel LIKE 'PJSIP/%' AND calldate >= $1 AND calldate < $2
		)
		SELECT agent,
		       count(*),
		       count(*) FILTER (WHERE disposition='ANSWERED'),
		       count(*) FILTER (WHERE dir='in'),
		       count(*) FILTER (WHERE dir='out'),
		       count(*) FILTER (WHERE dir='in' AND disposition IN ('NO ANSWER','BUSY')),
		       COALESCE(sum(billsec),0),
		       COALESCE(round(avg(billsec) FILTER (WHERE disposition='ANSWERED')),0),
		       COALESCE(max(billsec),0)
		  FROM legs
		 WHERE agent <> ''
		 GROUP BY agent`, from, to)
	if err != nil {
		return nil, err
	}
	for core.Next() {
		var ext string
		var calls, answered, inbound, outbound, missed, total, avg, longest int
		if err := core.Scan(&ext, &calls, &answered, &inbound, &outbound, &missed, &total, &avg, &longest); err != nil {
			core.Close()
			return nil, err
		}
		if _, isExt := byExt[ext]; !isExt {
			continue // ignore trunk channels and other non-extension parties
		}
		a := get(ext)
		a.Calls, a.Answered, a.Inbound, a.Outbound, a.Missed = calls, answered, inbound, outbound, missed
		a.TalkTotal, a.TalkAvg, a.Longest = total, avg, longest
	}
	core.Close()
	if err := core.Err(); err != nil {
		return nil, err
	}

	// Transfers initiated by the agent (CEL).
	tr, err := s.pool.Query(ctx, `
		SELECT split_part(split_part(channame,'/',2),'-',1) AS agent, count(*)
		  FROM cel
		 WHERE eventtype IN ('BLINDTRANSFER','ATTENDEDTRANSFER')
		   AND eventtime >= $1 AND eventtime < $2
		 GROUP BY agent`, from, to)
	if err == nil {
		for tr.Next() {
			var ext string
			var n int
			if tr.Scan(&ext, &n) == nil {
				if a, ok := byExt[ext]; ok {
					a.Transfers = n
				}
			}
		}
		tr.Close()
	}

	// Who hung up first: the earliest HANGUP per call (linkedid) names the
	// party that disconnected. Attribute per agent that was on the call.
	hu, err := s.pool.Query(ctx, `
		WITH fh AS (
		    SELECT DISTINCT ON (linkedid) linkedid,
		           split_part(split_part(channame,'/',2),'-',1) AS hanger
		      FROM cel
		     WHERE eventtype='HANGUP' AND eventtime >= $1 AND eventtime < $2
		     ORDER BY linkedid, eventtime ASC
		),
		legs AS (
		    SELECT DISTINCT split_part(split_part(channel,'/',2),'-',1) AS agent, linkedid
		      FROM cdr WHERE channel LIKE 'PJSIP/%' AND calldate >= $1 AND calldate < $2
		    UNION
		    SELECT DISTINCT split_part(split_part(dstchannel,'/',2),'-',1) AS agent, linkedid
		      FROM cdr WHERE dstchannel LIKE 'PJSIP/%' AND calldate >= $1 AND calldate < $2
		)
		SELECT l.agent,
		       count(*) FILTER (WHERE fh.hanger = l.agent),
		       count(*) FILTER (WHERE fh.hanger IS NOT NULL AND fh.hanger <> l.agent)
		  FROM legs l LEFT JOIN fh ON fh.linkedid = l.linkedid
		 WHERE l.agent <> ''
		 GROUP BY l.agent`, from, to)
	if err == nil {
		for hu.Next() {
			var ext string
			var byA, byO int
			if hu.Scan(&ext, &byA, &byO) == nil {
				if a, ok := byExt[ext]; ok {
					a.HangupByAgent, a.HangupByOther = byA, byO
				}
			}
		}
		hu.Close()
	}

	out := make([]AgentStat, 0, len(order))
	for _, ext := range order {
		out = append(out, *byExt[ext])
	}
	return out, nil
}
