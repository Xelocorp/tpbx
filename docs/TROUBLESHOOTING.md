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

## `res_pjsip` won't start / no transports / no endpoints

`res_pjsip` reads its endpoints from **realtime**, so it depends on the ODBC
realtime stack being loaded *first*. The pitfalls, all handled by `install.sh`:

- **`res_config_odbc` must be preloaded before `res_pjsip`.** Under plain
  `autoload`, `res_config_odbc` loads *before* its `res_odbc` dependency
  (alphabetical order) and fails. The managed `modules.conf` preloads
  `res_odbc.so` then `res_config_odbc.so`.
- **The module directory is multiarch.** On Debian/Asterisk 22 it is
  `/usr/lib/x86_64-linux-gnu/asterisk/modules`, not `/usr/lib/asterisk/modules`.
  `install.sh` detects it (`detect_module_dir`).
- **Never preload a module that isn't installed** — it's fatal. `modules.conf`
  is generated to preload only modules present on disk.

Check: `sudo asterisk -rx "module show like res_config_odbc"` should show it
Running.

## ODBC connection fails (realtime down) but `isql` works

```bash
sudo asterisk -rx "odbc show"     # Number of active connections: 0 + Last fail
printf 'quit\n' | isql -v tpbx-pg # ... yet this connects fine
```

This is a **PostgreSQL SCRAM mismatch**: the DB role's password was hashed under
an older `password_encryption` before hardening enforced `scram-sha-256`, so
`pg_hba` rejects it. `install.sh` now re-hashes the role password after enabling
scram. Manual fix:

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
