// Command tpbx is the TPBX GUI backend: it serves the web console, exposes a
// JSON API, and bridges Asterisk (ARI + AMI) live events to connected browsers.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/td425/tpbx/internal/ami"
	"github.com/td425/tpbx/internal/api"
	"github.com/td425/tpbx/internal/ari"
	"github.com/td425/tpbx/internal/config"
	"github.com/td425/tpbx/internal/db"
	"github.com/td425/tpbx/internal/ws"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	database, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer database.Close()
	slog.Info("connected to postgres")

	hub := ws.NewHub()
	ariClient := ari.New(cfg.ARI.BaseURL, cfg.ARI.Username, cfg.ARI.Password, cfg.ARI.AppName)

	// Bridge Asterisk events into the browser hub. Both loops reconnect
	// forever so a restart of Asterisk does not take the console down.
	go runARIEvents(ctx, ariClient, hub)
	go runAMIEvents(ctx, cfg, hub)

	srv := &api.Server{
		DB:     database,
		ARI:    ariClient,
		Hub:    hub,
		WebDir: webDir(),
	}

	httpServer := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           srv.Router(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		slog.Info("http listening", "addr", cfg.HTTPAddr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("http server", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return httpServer.Shutdown(shutdownCtx)
}

func webDir() string {
	if d := os.Getenv("TPBX_WEB_DIR"); d != "" {
		return d
	}
	return "web/dist"
}

// runARIEvents keeps a Stasis event subscription alive, forwarding each event
// to the browser hub, and reconnects with backoff on failure.
func runARIEvents(ctx context.Context, client *ari.Client, hub *ws.Hub) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := client.StreamEvents(ctx, func(ev ari.Event) {
			hub.Broadcast(ws.Envelope{Kind: "ari", Data: map[string]any{
				"type": ev.Type,
				"raw":  ev.Raw,
			}})
		})
		if ctx.Err() != nil {
			return
		}
		slog.Warn("ari events disconnected, retrying", "err", err, "in", backoff)
		sleep(ctx, backoff)
		backoff = nextBackoff(backoff)
	}
}

// runAMIEvents keeps an AMI session alive, forwarding events to the hub.
func runAMIEvents(ctx context.Context, cfg *config.Config, hub *ws.Hub) {
	backoff := time.Second
	for ctx.Err() == nil {
		client, err := ami.Dial(ctx, cfg.AMI.Addr, cfg.AMI.Username, cfg.AMI.Password, cfg.AMI.Timeout)
		if err != nil {
			slog.Warn("ami connect failed, retrying", "err", err, "in", backoff)
			sleep(ctx, backoff)
			backoff = nextBackoff(backoff)
			continue
		}
		slog.Info("ami connected")
		backoff = time.Second
		for {
			select {
			case <-ctx.Done():
				client.Close()
				return
			case msg, ok := <-client.Events():
				if !ok {
					break
				}
				if ev := msg.Get("Event"); ev != "" {
					hub.Broadcast(ws.Envelope{Kind: "ami", Data: msg})
				}
				continue
			}
			break
		}
		client.Close()
		slog.Warn("ami session ended, reconnecting")
	}
}

func nextBackoff(d time.Duration) time.Duration {
	d *= 2
	if d > 30*time.Second {
		return 30 * time.Second
	}
	return d
}

func sleep(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}
