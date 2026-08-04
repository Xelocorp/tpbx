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

# Pick whichever Asterisk logfile exists on this box.
AST_LOG=/var/log/asterisk/full
[ -f "$AST_LOG" ] || AST_LOG=/var/log/asterisk/messages

[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }

head "Services"
for svc in asterisk postgresql tpbx; do
  if systemctl is-active --quiet "$svc"; then ok "$svc is active"; else bad "$svc is NOT active (systemctl status $svc)"; fi
done

head "Database realtime (Asterisk -> PostgreSQL, native res_config_pgsql)"

# 1. Is the native realtime engine loaded?
if AST 'module show like res_config_pgsql' | grep -q 'Running'; then
  ok "res_config_pgsql (native PostgreSQL realtime) is Running"
else
  bad "res_config_pgsql is NOT loaded -- res_pjsip cannot read endpoints."
  echo "     Ensure /etc/asterisk/modules.conf has: preload = res_config_pgsql.so"
  echo "     then: sudo systemctl restart asterisk"
fi

# 2. Can we reach the DB directly with the app credentials?
if [ -f /etc/tpbx/tpbx.env ] && command -v psql >/dev/null 2>&1; then
  # shellcheck disable=SC1091
  db_url="$(. /etc/tpbx/tpbx.env >/dev/null 2>&1; echo "${TPBX_DATABASE_URL:-}")"
  if [ -n "$db_url" ] && psql "$db_url" -tAc 'SELECT 1' >/dev/null 2>&1; then
    ok "PostgreSQL reachable with the app credentials"
  else
    bad "Cannot connect to PostgreSQL with TPBX_DATABASE_URL -- fix the DB/role first"
  fi
fi

# 3. Did the realtime config get its password rendered?
if [ -f /etc/asterisk/res_pgsql.conf ] && grep -qi '__DB_PASSWORD__' /etc/asterisk/res_pgsql.conf; then
  bad "res_pgsql.conf still contains the __DB_PASSWORD__ placeholder (install did not substitute it)"
fi

# 4. Surface any realtime/pgsql errors from the Asterisk log.
rt_log="$(grep -iE 'res_config_pgsql|realtime|pgsql|sorcery|column' "$AST_LOG" 2>/dev/null | tail -6)"
if [ -n "$rt_log" ]; then
  echo "     recent Asterisk realtime log:"
  printf '%s\n' "$rt_log" | sed 's/^/       /'
fi

head "PJSIP transports (must be listening for phones to connect)"
tp="$(AST 'pjsip show transports')"
if echo "$tp" | grep -q 'transport-'; then
  echo "$tp" | sed 's/^/     /'
else
  bad "No PJSIP transports loaded!"
  echo "     Most common cause: the realtime engine (res_config_pgsql) above is"
  echo "     not loaded, so res_pjsip aborted before binding transports. Then:"
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
  echo "     Fix realtime (above), then: sudo asterisk -rx 'module reload res_config_pgsql.so'"
else
  warn "No endpoints visible. If you have created one, check the realtime section above."
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
