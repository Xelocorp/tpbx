// Package db owns the PostgreSQL connection pool shared by the API handlers.
//
// The same database is the Asterisk realtime backend (pjsip endpoints, auths,
// aors, ...) and the CDR/CEL sink, so the GUI can both provision configuration
// and report on call activity by talking to one place.
package db

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// DB wraps a pgx connection pool.
type DB struct {
	Pool *pgxpool.Pool
}

// Open creates and verifies a pooled connection to PostgreSQL.
func Open(ctx context.Context, url string) (*DB, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	cfg.MaxConns = 10
	cfg.MaxConnLifetime = time.Hour

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &DB{Pool: pool}, nil
}

// Close releases all pooled connections.
func (d *DB) Close() {
	if d.Pool != nil {
		d.Pool.Close()
	}
}
