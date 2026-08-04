# Asterisk configuration for TPBX

These files connect your Asterisk instance to the same PostgreSQL database the
TPBX GUI uses, so configuration written by the GUI (endpoints, trunks, routes)
is read live by Asterisk, and call records (CDR/CEL) flow back into the GUI.

They target **Asterisk 18/20/21 with `res_pjsip`** on Ubuntu 24.04.

## 1. Install the ODBC stack

```bash
sudo apt-get install -y unixodbc odbc-postgresql
```

## 2. Register the PostgreSQL ODBC driver — `/etc/odbcinst.ini`

```ini
[PostgreSQL]
Description = PostgreSQL ODBC driver
Driver      = /usr/lib/x86_64-linux-gnu/odbc/psqlodbcw.so
Setup       = /usr/lib/x86_64-linux-gnu/odbc/libodbcpsqlS.so
```

## 3. Define the DSN — `/etc/odbc.ini`

The DSN name must match `dsn => tpbx-pg` in `res_odbc.conf`.

```ini
[tpbx-pg]
Description = TPBX PostgreSQL
Driver      = PostgreSQL
Servername  = 127.0.0.1
Port        = 5432
Database    = tpbx
Username    = tpbx
Password    = tpbx
```

Verify: `isql -v tpbx-pg tpbx tpbx` should connect.

## 4. Install these Asterisk config files

Copy each file in this directory into `/etc/asterisk/`. Then make `pjsip.conf`
include the managed transports:

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

## 5. Load the modules

`modules.conf` (installed by this project) **preloads** the ODBC realtime stack
so it is available before `res_pjsip` starts:

```ini
[modules]
autoload = yes
preload = res_odbc.so
preload = res_config_odbc.so
```

This ordering is critical: `res_pjsip` reads its endpoints/auths/aors from
realtime via `res_config_odbc`. If that module is not already loaded when
`res_pjsip` initializes, `res_pjsip` fails to start — no SIP transports bind and
no endpoints are visible. (Symptom: `pjsip show transports` is empty and nothing
listens on 5060.)

These modules must be present: `res_odbc.so`, `res_config_odbc.so`,
`res_pjsip.so`, `cdr_adaptive_odbc.so`, `cel_odbc.so`, `res_ari.so`,
`res_http_websocket.so`.

Then:

```bash
sudo asterisk -rx "module reload res_odbc.so"
sudo asterisk -rx "odbc show"          # should list the tpbx connection
sudo asterisk -rx "pjsip reload"
sudo asterisk -rx "pjsip show endpoints"
```

## Security notes

- Change every `tpbx` password/secret in these files and keep them in sync with
  the backend's `TPBX_ARI_PASS` / `TPBX_AMI_PASS` environment variables.
- Keep **ARI (8088) and AMI (5038) bound to `127.0.0.1`**. The GUI runs on the
  same host and is the only intended client; never expose them to the network.
- Store TLS material under `/etc/asterisk/keys/` owned by the `asterisk` user
  with `0600` private keys.
