// Package migrate is a tiny forward-only SQL migration runner.
//
// Migrations are plain .sql files named "NNNN_description.sql". They are applied
// in filename order; each file that has not yet been recorded in the
// schema_migrations table is executed inside a single transaction and then
// recorded. Re-running is a no-op, which is exactly what upgrade.sh relies on:
// it can call `tpbx migrate` on every deploy and only genuinely new migrations
// take effect.
package migrate

import (
	"context"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Result describes what a Run did, for logging.
type Result struct {
	Applied []string // migration versions applied this run
	Skipped int      // already-applied migrations left untouched
}

// Run applies all pending migrations found under "migrations" in fsys.
func Run(ctx context.Context, pool *pgxpool.Pool, fsys fs.FS) (Result, error) {
	var res Result

	if err := ensureTable(ctx, pool); err != nil {
		return res, err
	}

	applied, err := appliedVersions(ctx, pool)
	if err != nil {
		return res, err
	}

	files, err := fs.Glob(fsys, "migrations/*.sql")
	if err != nil {
		return res, err
	}
	sort.Strings(files)

	for _, f := range files {
		version := versionOf(f)
		if applied[version] {
			res.Skipped++
			continue
		}
		sqlBytes, err := fs.ReadFile(fsys, f)
		if err != nil {
			return res, fmt.Errorf("read %s: %w", f, err)
		}
		if err := applyOne(ctx, pool, version, string(sqlBytes)); err != nil {
			return res, fmt.Errorf("apply %s: %w", version, err)
		}
		res.Applied = append(res.Applied, version)
	}
	return res, nil
}

func ensureTable(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version     TEXT PRIMARY KEY,
			applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
		)`)
	return err
}

func appliedVersions(ctx context.Context, pool *pgxpool.Pool) (map[string]bool, error) {
	rows, err := pool.Query(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	set := map[string]bool{}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		set[v] = true
	}
	return set, rows.Err()
}

// applyOne runs a migration and records it atomically: if the SQL fails, the
// transaction rolls back and the version is NOT recorded, so a fixed migration
// can be retried on the next run.
func applyOne(ctx context.Context, pool *pgxpool.Pool, version, sqlText string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after a successful Commit

	if _, err := tx.Exec(ctx, sqlText); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO schema_migrations (version) VALUES ($1)`, version); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func versionOf(path string) string {
	name := path
	if i := strings.LastIndex(name, "/"); i >= 0 {
		name = name[i+1:]
	}
	return strings.TrimSuffix(name, ".sql")
}
