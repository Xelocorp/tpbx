# TPBX — Asterisk Control Console

A web GUI for operating an Asterisk PBX instead of the CLI: manage extensions,
trunks, transports (UDP/TCP/TLS/WebRTC), inbound/outbound routing, and view call
history, logs and live call activity.

**Stack:** Go backend (ARI + AMI) · PostgreSQL (Asterisk realtime + CDR/CEL) ·
React/TypeScript frontend. Theme: sci-fi call-center, primary green `#39a751`.

> **New here (human or AI)? Start with [`docs/DEEP_INDEX.md`](docs/DEEP_INDEX.md)** —
> a single, complete map of the codebase: architecture, data model, every file's
> job, the IVR/routing internals, deployment, conventions, extension recipes, and
> the hard-won gotchas. Read it once and you can develop and upgrade this system.
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) has the original design rationale.

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
migrations/        PostgreSQL schema (pjsip realtime, cdr, cel, gui), embedded in the binary
asterisk/          config templates installed on the Asterisk host (+ README)
web/               React + TypeScript + Vite frontend (sci-fi green theme)
docs/              architecture & design
install.sh         idempotent fresh-server bootstrap
upgrade.sh         single-command in-place upgrade
scripts/lib.sh     shared install/upgrade routines (build, migrate, service)
```

The binary is also a small CLI: `tpbx serve` (default) runs the server,
`tpbx migrate` applies pending migrations, `tpbx version` prints the build.

## Install on a fresh server (production)

On a clean Ubuntu/Debian box, one command bootstraps everything —
PostgreSQL, Asterisk, Go, Node, TLS certs, the systemd service, database
migrations, and security tuning (fail2ban, localhost-only ARI/AMI, scram-sha-256):

```bash
git clone <this-repo> /opt/tpbx && cd /opt/tpbx
sudo ./install.sh
# optionally also enable the ufw firewall:
sudo TPBX_ENABLE_FIREWALL=yes ./install.sh
```

`install.sh` is **idempotent** — re-running repairs config and never regenerates
existing secrets. It generates a random PostgreSQL password, ARI secret and AMI
secret, and writes a full **credentials report to `/root/tpbx-credentials.txt`**
(root-only) listing every username, password, port and installed version.

It sets up the whole stack correctly for Asterisk realtime: uses the **native
PostgreSQL driver** (`res_config_pgsql`, no ODBC), detects the multiarch module
directory, preloads `res_config_pgsql` before `res_pjsip`, enforces PostgreSQL
`scram-sha-256` (re-hashing the role password to match), and verifies at the end
that the realtime engine is loaded and SIP transports are listening.

Verify any time with:

```bash
sudo ./scripts/diagnose.sh          # full registration-chain health check
```

If something's off, see [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

### Upgrading (continuous updates)

Pull the latest code and upgrade in place with a single command:

```bash
cd /opt/tpbx
git pull && sudo ./upgrade.sh
```

This rebuilds the backend + frontend, applies only **new** database migrations
(tracked in `schema_migrations`, embedded in the binary), and restarts the
service. It never touches your generated secrets or GUI-managed Asterisk config.
Migrations are forward-only and safe to run on every deploy.

## Quick start (dev)

Prereqs: Go 1.24+, Node 20+, PostgreSQL 14+, and (for real telephony) Asterisk
18+ with `res_pjsip`. See [`asterisk/README.md`](asterisk/README.md) for the
Asterisk realtime wiring.

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
