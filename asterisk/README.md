# Asterisk configuration for TPBX

These files connect your Asterisk instance to the same PostgreSQL database the
TPBX GUI uses, so configuration written by the GUI (endpoints, trunks, routes)
is read live by Asterisk, and call records (CDR/CEL) flow back into the GUI.

They target **Asterisk 20/21/22 with `res_pjsip`** on Ubuntu/Debian and use the
**native PostgreSQL realtime driver (`res_config_pgsql`)** — no ODBC, no
unixODBC, no DSN. `install.sh` installs and wires all of this automatically; the
steps below are for a manual setup.

## 1. Install Asterisk + modules

```bash
sudo apt-get install -y asterisk asterisk-modules asterisk-config
```

Confirm the native PostgreSQL realtime module is present:

```bash
find /usr/lib -name res_config_pgsql.so     # e.g. /usr/lib/x86_64-linux-gnu/asterisk/modules/
```

## 2. Install these config files into `/etc/asterisk/`

| File | Purpose |
|---|---|
| `res_pgsql.conf` | PostgreSQL connection for realtime (host/db/user/pass) |
| `extconfig.conf` | Maps realtime families → `pgsql,tpbx,<table>` |
| `sorcery.conf` | Tells `res_pjsip` its objects come from realtime |
| `cdr_pgsql.conf` | Writes CDR rows to the `cdr` table |
| `cel_pgsql.conf` | Writes CEL rows to the `cel` table |
| `ari.conf` | ARI user for the GUI (localhost) |
| `manager.conf` | AMI user for the GUI (localhost) |
| `pjsip_transports.conf` | UDP/TCP/TLS/WSS transports (GUI-managed) |
| `modules.conf` | **Preloads `res_config_pgsql` before `res_pjsip`** |

`install.sh` substitutes the DB password into `res_pgsql.conf`, `cdr_pgsql.conf`
and `cel_pgsql.conf` (the `__DB_PASSWORD__` placeholder).

Make `pjsip.conf` include the managed transports:

```ini
; /etc/asterisk/pjsip.conf
#include "pjsip_transports.conf"
```

Enable the HTTP server (needed by ARI and the WebRTC WSS transport) in
`/etc/asterisk/http.conf`:

```ini
[general]
enabled=yes
bindaddr=127.0.0.1
bindport=8088
tlsenable=yes
tlsbindaddr=0.0.0.0:8089
tlscertfile=/etc/asterisk/keys/tpbx.crt
tlsprivatekey=/etc/asterisk/keys/tpbx.key
```

## 3. Critical: module load order

`res_pjsip` reads its endpoints from realtime, so the realtime engine must be
loaded **first**. The provided `modules.conf` does this:

```ini
[modules]
autoload = yes
preload = res_config_pgsql.so
```

Without the preload, `res_pjsip` initializes before `res_config_pgsql` and fails
to start — no SIP transports bind and no endpoints are visible.

## 4. Apply and verify

```bash
sudo systemctl restart asterisk
sudo asterisk -rx "module show like res_config_pgsql"   # Running
sudo asterisk -rx "pjsip show transports"               # transport-udp/tcp/tls
# after creating an extension in the GUI:
sudo asterisk -rx "pjsip show endpoints"
```

## Security notes

- Change every `tpbx` password/secret and keep them in sync with the backend's
  `TPBX_ARI_PASS` / `TPBX_AMI_PASS` environment variables.
- Keep **ARI (8088) and AMI (5038) bound to `127.0.0.1`**. The GUI runs on the
  same host and is the only intended client; never expose them to the network.
- Store TLS material under `/etc/asterisk/keys/` owned by the `asterisk` user
  with `0600` private keys.
- PostgreSQL stays on localhost with `scram-sha-256`; libpq (used by
  `res_config_pgsql`) negotiates it natively.
