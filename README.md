# TPBX — Asterisk Control Console

A web GUI for operating an Asterisk PBX instead of the CLI: manage extensions,
trunks, transports (UDP/TCP/TLS/WebRTC), inbound/outbound routing, and view call
history, logs and live call activity.

**Stack:** Go backend (ARI + AMI) · PostgreSQL (Asterisk realtime + CDR/CEL) ·
React/TypeScript frontend. Theme: sci-fi call-center, primary green `#39a751`.

> Status: **Phase 1 — Foundation.** The ARI/AMI→browser bridge, realtime DB
> schema, Asterisk config templates and a live-dashboard skeleton are in place.
> See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design and
> roadmap.

## Architecture at a glance

The GUI never edits `.conf` files by hand. Configuration lives in two places:

- **PostgreSQL realtime** for endpoints/auths/aors/trunks/routing — the GUI does
  CRUD, Asterisk reads it live.
- **Managed include files** for the few things realtime can't hold (PJSIP
  transports, TLS, WebRTC) — the GUI generates them and reloads Asterisk.

Live state (registrations, active calls, events) comes from ARI/AMI and is
pushed to the browser over a WebSocket. Full diagram in the architecture doc.

## Layout

```
cmd/tpbx/          Go entrypoint
internal/          backend: config, db, ami, ari, ws hub, http api
migrations/        PostgreSQL schema (pjsip realtime, cdr, cel, gui)
asterisk/          config templates to install on the Asterisk host (+ README)
web/               React + TypeScript + Vite frontend (sci-fi green theme)
docs/              architecture & design
```

## Quick start (dev)

Prereqs: Go 1.24+, Node 20+, PostgreSQL 14+, and (for real telephony) Asterisk
18+ with `res_pjsip`. See [`asterisk/README.md`](asterisk/README.md) for the
Asterisk + ODBC wiring.

```bash
# 1. Database (creates role+db, then applies migrations AS the app role)
make db-create
make db-migrate

# 2. Build & run everything (backend serves the built UI on :8080)
make run
#   open http://localhost:8080

# --- or hot-reload frontend during development ---
go run ./cmd/tpbx            # terminal 1  (backend on :8080)
cd web && npm install && npm run dev   # terminal 2 (UI on :5173, proxies to :8080)
```

Without Asterisk running you still get a working console: the dashboard shows
the DB-backed data and reports the ARI/AMI link as down until Asterisk is up.

## Configuration

All via environment variables (defaults assume localhost):

| Variable | Default | Purpose |
|---|---|---|
| `TPBX_HTTP_ADDR` | `:8080` | GUI/API listen address |
| `TPBX_DATABASE_URL` | `postgres://tpbx:tpbx@127.0.0.1:5432/tpbx?sslmode=disable` | PostgreSQL |
| `TPBX_ARI_URL` / `_USER` / `_PASS` / `_APP` | `http://127.0.0.1:8088` … | Asterisk REST Interface |
| `TPBX_AMI_ADDR` / `_USER` / `_PASS` | `127.0.0.1:5038` … | Asterisk Manager Interface |
| `TPBX_ASTERISK_CONF_DIR` | `/etc/asterisk` | Where managed includes are written |
| `TPBX_WEB_DIR` | `web/dist` | Built frontend to serve |

**Change every default `tpbx` password** and keep ARI/AMI bound to `127.0.0.1`.
