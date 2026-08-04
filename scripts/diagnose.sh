#!/usr/bin/env bash
#
# scripts/diagnose.sh -- health check for a TPBX + Asterisk install.
#
# Run on the server:  sudo ./scripts/diagnose.sh
#
# It checks the full registration chain (services -> DB realtime -> PJSIP
# transports -> listening sockets -> endpoints -> firewall) and prints a
# report so you can see exactly where SIP registration is breaking.

set -u

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YEL=$'\033[1;33m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$OFF" "$*"; }
bad()  { printf '  %s✗%s %s\n' "$RED" "$OFF" "$*"; }
warn() { printf '  %s!%s %s\n' "$YEL" "$OFF" "$*"; }
head() { printf '\n%s== %s ==%s\n' "$BOLD" "$*" "$OFF"; }

AST() { asterisk -rx "$*" 2>/dev/null; }

[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }

head "Services"
for svc in asterisk postgresql tpbx; do
  if systemctl is-active --quiet "$svc"; then ok "$svc is active"; else bad "$svc is NOT active (systemctl status $svc)"; fi
done

head "Database realtime (Asterisk -> PostgreSQL)"
odbc="$(AST 'odbc show')"
# Parse the active-connection count robustly (guarantee an integer).
active="$(printf '%s\n' "$odbc" | sed -n 's/.*active connections: \([0-9]\{1,\}\).*/\1/p' | head -1)"
case "$active" in '' | *[!0-9]*) active=0 ;; esac

# The authoritative test is isql (same DSN/driver/creds Asterisk uses). The
# `odbc show` "active connections" count is lazy: res_odbc opens connections on
# demand, so 0-active with a stale "Last fail" from startup is NOT proof of a
# problem if isql connects.
isql_ok=0
if command -v isql >/dev/null 2>&1; then
  if printf 'quit\n' | isql -v tpbx-pg >/dev/null 2>&1; then
    isql_ok=1
  fi
fi

if [ "$active" -gt 0 ]; then
  ok "ODBC connected ($active active connection(s))"
elif [ "$isql_ok" -eq 1 ]; then
  ok "ODBC DSN is good (isql connects). 0 active is just idle/lazy."
  printf '%s\n' "$odbc" | grep -qi 'Last fail' && \
    echo "     (a stale 'Last fail' from startup is harmless; 'module reload res_odbc.so' clears it)"
elif printf '%s\n' "$odbc" | grep -qi 'Last fail'; then
  bad "ODBC has a FAILED connection and isql also cannot connect -- realtime is DOWN"
  echo "     Repair a scram/password mismatch:"
  echo "       set -a; . /etc/tpbx/tpbx.env; set +a"
  echo "       sudo -u postgres psql -c \"ALTER ROLE tpbx WITH PASSWORD '\$TPBX_DB_PASSWORD';\""
  echo "       sudo asterisk -rx 'module reload res_odbc.so'"
else
  warn "ODBC has 0 active connections (may be idle; realtime opens on demand)"
fi
printf '%s\n' "$odbc" | sed 's/^/     /'
[ "$isql_ok" -eq 1 ] && ok "isql DSN test connected (driver + password + pg_hba all OK)"

# Confirm the Asterisk ODBC config actually got a real password rendered.
if [ -f /etc/asterisk/res_odbc.conf ]; then
  if grep -qi '__DB_PASSWORD__' /etc/asterisk/res_odbc.conf; then
    bad "res_odbc.conf still contains the __DB_PASSWORD__ placeholder (install did not substitute it)"
  fi
fi

# Surface the real error from the Asterisk log, if any.
odbc_log="$(grep -iE 'odbc|res_config' /var/log/asterisk/full 2>/dev/null | tail -6)"
if [ -n "$odbc_log" ]; then
  echo "     recent Asterisk ODBC log:"
  printf '%s\n' "$odbc_log" | sed 's/^/       /'
fi
# Specific, common failure: the daemon can't resolve the DSN even though isql can.
if printf '%s\n' "$odbc_log" | grep -qi 'Data source name not found'; then
  bad "Asterisk daemon cannot find the ODBC DSN (env issue, not credentials)."
  echo "     Point the daemon at /etc via a systemd drop-in:"
  echo "       sudo mkdir -p /etc/systemd/system/asterisk.service.d"
  echo "       printf '[Service]\\nEnvironment=ODBCSYSINI=/etc\\nEnvironment=ODBCINI=/etc/odbc.ini\\n' \\"
  echo "         | sudo tee /etc/systemd/system/asterisk.service.d/tpbx-odbc.conf"
  echo "       sudo systemctl daemon-reload && sudo systemctl restart asterisk"
fi

head "PJSIP transports (must be listening for phones to connect)"
tp="$(AST 'pjsip show transports')"
if echo "$tp" | grep -q 'transport-'; then
  echo "$tp" | sed 's/^/     /'
else
  bad "No PJSIP transports loaded!"
  echo "     Most common cause: the ODBC/realtime check above is DOWN, so"
  echo "     res_pjsip aborted before binding transports. Fix ODBC first, then:"
  echo "       systemctl restart asterisk"
  echo "     Also verify the include: grep -n pjsip_transports.conf /etc/asterisk/pjsip.conf"
fi

head "Listening sockets"
for p in "5060 udp" "5060 tcp" "5061 tcp" "8089 tcp"; do
  set -- $p
  proto=$2; port=$1
  flag="-lun"; [ "$proto" = tcp ] && flag="-lnt"
  if ss $flag 2>/dev/null | grep -q ":${port} "; then
    ok "listening on ${port}/${proto}"
  else
    warn "nothing listening on ${port}/${proto}"
  fi
done

head "Endpoints (from realtime)"
# How many extensions actually exist in the database? This distinguishes an
# empty database (nothing created yet) from a broken realtime lookup.
db_count=""
if [ -f /etc/tpbx/tpbx.env ] && command -v psql >/dev/null 2>&1; then
  # shellcheck disable=SC1091
  db_url="$(. /etc/tpbx/tpbx.env >/dev/null 2>&1; echo "${TPBX_DATABASE_URL:-}")"
  [ -n "$db_url" ] && db_count="$(psql "$db_url" -tAc 'SELECT count(*) FROM ps_endpoints' 2>/dev/null)"
fi

eps="$(AST 'pjsip show endpoints')"
if echo "$eps" | grep -qE 'Endpoint:'; then
  ok "Asterisk sees endpoints from realtime:"
  echo "$eps" | grep -E 'Endpoint:|Contact:' | sed 's/^/     /'
elif [ "${db_count:-0}" = "0" ] && [ -n "$db_count" ]; then
  ok "No extensions created yet (ps_endpoints is empty) -- this is expected on a"
  echo "     fresh install. Create one in the GUI (Extensions -> New), or:"
  echo "       curl -s -X POST http://127.0.0.1:8080/api/extensions \\"
  echo "         -H 'Content-Type: application/json' \\"
  echo "         -d '{\"id\":\"1001\",\"password\":\"Test1234\",\"context\":\"from-internal\"}'"
elif [ -n "$db_count" ] && [ "$db_count" -gt 0 ] 2>/dev/null; then
  bad "$db_count extension(s) exist in the DB but Asterisk sees none -- realtime is broken."
  echo "     Fix ODBC (above), then: sudo asterisk -rx 'module reload res_odbc.so'"
else
  warn "No endpoints visible. If you have created one, check realtime/ODBC above."
fi

head "Firewall"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw status | sed 's/^/     /'
  ufw status | grep -qE '5060' || warn "ufw active but 5060 not allowed -- SIP is blocked!"
else
  ok "ufw not active (host firewall not blocking; check cloud/Proxmox firewall separately)"
fi

head "Watch a live registration attempt"
cat <<'EOF'
     Turn on SIP tracing, then register from your phone and watch:
       asterisk -rx 'pjsip set logger on'
       asterisk -rvvvv        (or: tail -f /var/log/asterisk/full)
     You will see the inbound REGISTER and Asterisk's reply. Common results:
       - nothing arrives            -> firewall / wrong IP / wrong transport in the phone
       - 401 then 200 OK            -> success (that first 401 is normal)
       - 403 Forbidden              -> wrong password, or endpoint not identified
       - phone says 'IOError'       -> transport mismatch (set phone to UDP:5060)
EOF
echo
