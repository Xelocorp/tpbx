# Troubleshooting

Run the health check first — it inspects the whole registration chain and tells
you where it breaks:

```bash
sudo ./scripts/diagnose.sh
```

## A phone can't register ("IOError", timeout, or no response)

`IOError` in a softphone is a **transport-level** failure (it couldn't open the
SIP connection), not an auth rejection. Work down this list:

1. **Softphone transport = UDP.** Modern Linphone/clients default to TLS; against
   a self-signed cert that fails with `IOError`. Set transport to **UDP**, server
   `<server-ip>:5060`.
2. **Is anything listening on 5060?** `sudo asterisk -rx "pjsip show transports"`.
   Empty ⇒ `res_pjsip` didn't load its transports (see below).
3. **Firewall / NAT.** On Proxmox/cloud, make sure UDP/TCP 5060 (and the RTP
   range 10000–20000/udp) reach the VM. `install.sh` only touches the host
   firewall when `TPBX_ENABLE_FIREWALL=yes`.
4. **403 Forbidden** in `pjsip set logger on` output ⇒ wrong password or the
   endpoint isn't identified — a realtime/config issue, not transport.

## Realtime backend: native PostgreSQL (not ODBC)

TPBX uses Asterisk's **native PostgreSQL realtime driver, `res_config_pgsql`** —
it talks to PostgreSQL directly via libpq. There is deliberately **no ODBC**
(no unixODBC, no `odbc.ini`, no DSN, no driver manager), because the ODBC driver
manager produced environment-specific failures that were hard to diagnose
(e.g. the daemon reporting "Data source name not found" while `isql` worked).

## `res_pjsip` won't start / no transports / no endpoints

`res_pjsip` reads its endpoints from **realtime**, so `res_config_pgsql` must be
loaded *first*. Pitfalls, all handled by `install.sh`:

- **`res_config_pgsql` must be preloaded before `res_pjsip`.** The managed
  `modules.conf` does `preload = res_config_pgsql.so`. Without it, `res_pjsip`
  initializes before the realtime engine and fails — no transports, no endpoints.
- **The module directory is multiarch.** On Debian/Asterisk 22 it is
  `/usr/lib/x86_64-linux-gnu/asterisk/modules`, not `/usr/lib/asterisk/modules`.
  `install.sh` detects it (`detect_module_dir`).
- **Never preload a module that isn't installed** — it's fatal. `modules.conf`
  is generated to preload only modules present on disk.

Check: `sudo asterisk -rx "module show like res_config_pgsql"` should show it
Running, and `sudo asterisk -rx "pjsip show endpoints"` should list any
extensions you created.

## Realtime broken (DB has extensions but Asterisk sees none)

```bash
sudo asterisk -rx "module show like res_config_pgsql"   # is it Running?
psql "$(. /etc/tpbx/tpbx.env; echo "$TPBX_DATABASE_URL")" -tAc 'SELECT count(*) FROM ps_endpoints'
```

If the module is loaded and the DB is reachable but endpoints don't appear,
check `/var/log/asterisk/full` for `res_config_pgsql`/`realtime` errors, then
`sudo asterisk -rx "module reload res_config_pgsql.so"`.

If the DB itself rejects the app credentials, it's usually a **SCRAM mismatch**
(role password hashed before `scram-sha-256` was enforced). Re-hash it:

```bash
set -a; . /etc/tpbx/tpbx.env; set +a
sudo -u postgres psql -c "ALTER ROLE tpbx WITH PASSWORD '$TPBX_DB_PASSWORD';"
sudo systemctl restart asterisk
```

## Asterisk killed on start (`status=9/KILL`)

The Debian unit is `Type=notify`; if Asterisk is slow to signal readiness on a
busy first boot, systemd can SIGKILL it. `install.sh` installs a drop-in
(`/etc/systemd/system/asterisk.service.d/tpbx.conf`) raising `TimeoutStartSec`.
To see a genuine fatal error, run it in the foreground:

```bash
sudo systemctl stop asterisk
sudo asterisk -fcvvvvv
```

## WebRTC (WSS) transport

A `ws`/`wss` PJSIP transport must **not** define its own `bind` — it rides on
Asterisk's HTTP(S) server (`http.conf` `tlsbindaddr=0.0.0.0:8089`). A `bind`
here collides with that listener. WebRTC endpoints also need `webrtc=yes` (the
Extensions page sets this and forces the `transport-wss` transport). Browsers
reject self-signed WSS certs, so use a CA-signed cert for production.

## The TPBX service (`systemctl status tpbx`)

- `Changing to the requested working directory failed` ⇒ the service can't read
  its `WorkingDirectory`. TPBX serves from `/var/lib/tpbx` (owned by the `tpbx`
  user), never from the repo checkout, precisely so cloning under `/root` works.
- `database ... connection refused` ⇒ PostgreSQL isn't up, or `TPBX_DATABASE_URL`
  in `/etc/tpbx/tpbx.env` is wrong.
