package store

import (
	"context"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// CDR is the read store for call detail records. Rows are written by Asterisk's
// cdr_pgsql module into the `cdr` table; this store only queries them.
type CDR struct {
	pool *pgxpool.Pool
}

// NewCDR returns a CDR store bound to a connection pool.
func NewCDR(pool *pgxpool.Pool) *CDR {
	return &CDR{pool: pool}
}

// CDRRecord is one call.
type CDRRecord struct {
	ID          int64     `json:"id"`
	CallDate    time.Time `json:"callDate"`
	CLID        string    `json:"clid"`
	Src         string    `json:"src"`
	Dst         string    `json:"dst"`
	Duration    int       `json:"duration"`
	Billsec     int       `json:"billsec"`
	Disposition string    `json:"disposition"`
	Channel     string    `json:"channel"`
	DstChannel  string    `json:"dstChannel"`
	UniqueID    string    `json:"uniqueId"`
}

// CDRFilter narrows and pages a CDR query.
type CDRFilter struct {
	Search      string // matches src, dst, or clid
	Disposition string // exact disposition, or "" for any
	Limit       int
	Offset      int
}

// List returns a page of CDR records (newest first) and the total match count.
func (s *CDR) List(ctx context.Context, f CDRFilter) ([]CDRRecord, int, error) {
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 50
	}
	if f.Offset < 0 {
		f.Offset = 0
	}

	where := []string{"1=1"}
	args := []any{}
	n := 0
	add := func(cond string, val any) {
		n++
		where = append(where, strings.Replace(cond, "?", "$"+itoa(n), 1))
		args = append(args, val)
	}
	if f.Search != "" {
		n++
		p := "$" + itoa(n)
		where = append(where, "(src ILIKE "+p+" OR dst ILIKE "+p+" OR clid ILIKE "+p+")")
		args = append(args, "%"+f.Search+"%")
	}
	if f.Disposition != "" {
		add("disposition = ?", f.Disposition)
	}
	cond := strings.Join(where, " AND ")

	var total int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM cdr WHERE `+cond, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	// Append LIMIT/OFFSET params.
	lp := "$" + itoa(n+1)
	op := "$" + itoa(n+2)
	args = append(args, f.Limit, f.Offset)

	rows, err := s.pool.Query(ctx, `
		SELECT id, calldate, COALESCE(clid,''), COALESCE(src,''), COALESCE(dst,''),
		       COALESCE(duration,0), COALESCE(billsec,0), COALESCE(disposition,''),
		       COALESCE(channel,''), COALESCE(dstchannel,''), COALESCE(uniqueid,'')
		  FROM cdr WHERE `+cond+`
		 ORDER BY calldate DESC, id DESC
		 LIMIT `+lp+` OFFSET `+op, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	out := []CDRRecord{}
	for rows.Next() {
		var c CDRRecord
		if err := rows.Scan(&c.ID, &c.CallDate, &c.CLID, &c.Src, &c.Dst,
			&c.Duration, &c.Billsec, &c.Disposition, &c.Channel, &c.DstChannel, &c.UniqueID); err != nil {
			return nil, 0, err
		}
		out = append(out, c)
	}
	return out, total, rows.Err()
}

// itoa is a tiny int->string helper (avoids importing strconv here).
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [20]byte
	pos := len(b)
	for i > 0 {
		pos--
		b[pos] = byte('0' + i%10)
		i /= 10
	}
	return string(b[pos:])
}
