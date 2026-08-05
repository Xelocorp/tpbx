package api

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/td425/tpbx/internal/store"
)

// handleListCDR returns a paginated, filtered page of call detail records.
func (s *Server) handleListCDR(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	offset, _ := strconv.Atoi(q.Get("offset"))

	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()

	records, total, err := s.CDR.List(ctx, store.CDRFilter{
		Search:      q.Get("q"),
		Disposition: q.Get("disposition"),
		Limit:       limit,
		Offset:      offset,
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"records": records, "total": total})
}
