# TPBX Architecture

TPBX is a web console for operating an Asterisk PBX: managing extensions,
trunks, transports (UDP/TCP/TLS/WebRTC), inbound/outbound routing, and viewing
call history, logs and live call activity — replacing the CLI/config-file
workflow with a GUI.

This document records the stack decision and the system design so the whole
build stays coherent as features land.

## 1. Stack decision

| Layer | Choice | Why |
|---|---|---|
| Backend | **Go** (`net/http` + chi) | Single static binary, excellent concurrency for event streams, trivial to run as a systemd service on the Asterisk host. |
| Asterisk control | **ARI** + **AMI** | ARI (REST + Stasis WebSocket) for live call state/control; AMI for management events and `reload`. AMI implemented directly (tiny text protocol); ARI over `net/http` + `coder/websocket`. |
| Database | **PostgreSQL** | Doubles as the Asterisk **realtime** config store *and* the CDR/CEL sink. Accessed with `pgx`. |
| Frontend | **React + TypeScript + Vite** | Modern SPA; served as static files by the Go binary in production. Theme: sci-fi call-center, primary green `#39a751`. |

Alternatives considered: Node/NestJS (fine, one-language stack) and Python/FastAPI
(fine, strong async). Go won on deploy simplicity and the maturity of its ARI
ecosystem. FreePBX was considered as a no-build option and rejected because the
GUI needs a bespoke UX and product ownership of the config.

## 2. The core design principle: hybrid config

Asterisk configuration lives in **two** places, and knowing which is which is
the single most important thing about this system:

```
                         ┌──────────────────────────────────────┐
                         │              TPBX backend (Go)         │
   Browser  ── HTTP ───► │  /api  REST   /ws  live events         │
   (React SPA)  ◄─ WS ── │                                        │
                         │   ┌────────────┐   ┌────────────────┐  │
                         │   │ DB writer  │   │ config-file     │  │
                         │   │ (realtime) │   │ generator       │  │
                         └───┼────────────┼───┼────────────────┼──┘
                             │            │   │                │
                    ┌────────▼───────┐    │   │        ┌───────▼────────┐
                    │  PostgreSQL    │    │   │        │ /etc/asterisk/ │
                    │  ps_endpoints  │    │   │        │  *.conf includes│
                    │  ps_auths ...  │    │   │        │ (transports/TLS)│
                    │  cdr / cel     │    │   │        └───────┬────────┘
                    └────────┬───────┘    │   │                │
                             │  realtime  │   │  reload         │
                        ┌────▼────────────▼───▼─────────────────▼──┐
                        │                Asterisk                   │
                        │   res_pjsip · ARI (8088) · AMI (5038)     │
                        └───────────────────────────────────────────┘
```

**A. Database realtime (the common case).** Endpoints, auths, AORs, identifies,
registrations and dynamic contacts are stored in PostgreSQL. Asterisk reads them
live via `res_config_odbc` (see `asterisk/sorcery.conf`, `asterisk/extconfig.conf`).
The GUI provisions telephony by doing plain CRUD on these tables — no file edits.
CDR/CEL flow back into the same database.

**B. Managed config files (the exceptions).** Some objects cannot be realtime
because Asterisk loads them once at startup — most importantly **PJSIP
transports** (UDP/TCP/TLS/WSS). For these the backend owns and rewrites include
files under `/etc/asterisk/` (e.g. `pjsip_transports.conf`) and triggers a
`pjsip reload` (or prompts for a restart when binding changes). TLS certificates
are files on disk referenced by those transports.

**C. Live state (never stored).** Registration status, active channels and call
events are not persisted — they come from ARI/AMI in real time and are pushed to
the browser over `/ws`.

### Feature → surface map

| Feature | Backing surface |
|---|---|
| Extensions / users | DB realtime: `ps_endpoints`, `ps_auths`, `ps_aors` |
| Trunks | DB realtime: `ps_endpoints`, `ps_auths`, `ps_registrations`, `ps_endpoint_id_ips` |
| Transports (UDP/TCP/TLS/WSS) | **Managed file**: `pjsip_transports.conf` + `pjsip reload` |
| WebRTC | WSS transport (file) + endpoint `webrtc=yes` (DB) + DTLS certs (files) |
| TLS certificates | Files under `/etc/asterisk/keys/`, paths referenced by transports |
| Inbound/outbound routing | DB realtime `extensions` table (Phase 6) |
| Call history (CDR) | DB: `cdr` via `cdr_adaptive_odbc` |
| Detailed call flow (CEL) | DB: `cel` via `cel_odbc` |
| Logs | Asterisk log files + CEL |
| Live monitor / control | ARI + AMI → `/ws` |

## 3. Backend layout

```
cmd/tpbx/main.go        entrypoint: wires everything, reconnecting ARI/AMI loops
internal/config         env-based configuration
internal/db             pgx connection pool
internal/ami            AMI client (native text protocol over TCP)
internal/ari            ARI client (REST + Stasis event WebSocket)
internal/ws             browser fan-out hub (one WebSocket per client)
internal/api            chi router: /api REST, /ws, static SPA
```

The two Asterisk event sources (ARI, AMI) run in their own goroutines with
exponential backoff, normalise events into small JSON envelopes, and broadcast
them through the `ws.Hub` to every connected browser.

## 4. Security posture

- ARI (8088) and AMI (5038) are bound to **127.0.0.1**. The backend runs on the
  same host and is their only client; they are never exposed to the network.
- The browser only ever talks to the TPBX backend, which authenticates users
  (Phase 8: `tpbx_users`, roles admin/operator/viewer) and records every config
  change in `tpbx_audit_log`.
- Migrations must be applied **as the application DB role** so it owns its
  tables (running them as a superuser leaves the app without privileges).
- TLS material lives under `/etc/asterisk/keys/`, `0600`, owned by `asterisk`.

## 5. Roadmap

1. **Foundation** ✅ — ARI/AMI bridge, Postgres + realtime schema, config
   templates, live-dashboard skeleton, themed SPA, versioned migrations, and
   one-command `install.sh` / `upgrade.sh` deployment. *(this milestone)*
2. **Live monitor & control** — originate/hangup, queues, `reload` from the UI.
3. **Extensions** — CRUD over `ps_endpoints`/`ps_auths`/`ps_aors` with validation.
4. **Transports & TLS/WebRTC** — managed include generator, cert store, WSS flow.
5. **Trunks** — SIP trunk provisioning + registration status.
6. **Routing** — inbound/outbound route builder → realtime dialplan.
7. **CDR & logs** — call-history reports, recordings, live log tail, CEL timelines.
8. **Hardening** — auth/RBAC, audit log surfacing, HTTPS, packaging.

## 6. Deployment & lifecycle

The system is designed around two idempotent scripts sharing one library
(`scripts/lib.sh`), so "build" and "migrate" are defined exactly once:

- **`install.sh`** — fresh-server bootstrap. Installs OS packages (PostgreSQL,
  Asterisk, unixODBC), pinned Go + Node toolchains, generates secrets **once**
  into `/etc/tpbx/tpbx.env`, provisions the DB/role (app-role-owned schema),
  wires ODBC, renders Asterisk config with injected secrets (backing up
  originals as `*.tpbx-orig`), generates self-signed TLS certs, builds and
  installs the binary, runs migrations, applies security tuning, installs the
  systemd unit, and writes a credentials report to `/root/tpbx-credentials.txt`.
- **`upgrade.sh`** — `git pull --ff-only` → rebuild → `tpbx migrate` → restart.
  Touches neither secrets nor GUI-managed Asterisk config.

**Migrations are versioned and embedded in the binary.** `tpbx migrate` records
each applied file in a `schema_migrations` table and applies only new ones, each
in its own transaction. Because the migration set is compiled into the binary,
an upgraded binary always carries exactly the migrations it expects — files on
disk can't drift from code. This is what makes single-command upgrades safe to
run on every deploy.

**Security tuning** applied by `install.sh`: ARI/AMI bound to `127.0.0.1`,
PostgreSQL on localhost with `scram-sha-256`, secret files `0640`/`0600`,
fail2ban (sshd + asterisk jails), systemd sandboxing, and an opt-in ufw firewall
(`TPBX_ENABLE_FIREWALL=yes`, kept off by default to avoid SSH lockout).

## 7. Prerequisites (target host)

Ubuntu 22.04/24.04. `install.sh` installs everything else: Asterisk 20 with
`res_pjsip`, PostgreSQL, unixODBC + psqlODBC, Go and Node. See
`asterisk/README.md` for the manual ODBC wiring if you deploy without the script.
