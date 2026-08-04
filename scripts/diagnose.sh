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
if echo "$odbc" | grep -qiE 'Connected|Number of active'; then
  ok "ODBC connection present"
  echo "$odbc" | sed 's/^/     /'
else
  bad "ODBC not connected -- realtime endpoints won't load"
  echo "     try: asterisk -rx 'module reload res_odbc.so' ; asterisk -rx 'odbc show'"
fi

head "PJSIP transports (must be listening for phones to connect)"
tp="$(AST 'pjsip show transports')"
if echo "$tp" | grep -q 'transport-'; then
  echo "$tp" | sed 's/^/     /'
else
  bad "No PJSIP transports loaded!"
  echo "     Check: grep -n pjsip_transports.conf /etc/asterisk/pjsip.conf"
  echo "     Then:  asterisk -rx 'module reload res_pjsip.so'   (or restart asterisk)"
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
eps="$(AST 'pjsip show endpoints')"
if echo "$eps" | grep -qE 'Endpoint:'; then
  echo "$eps" | grep -E 'Endpoint:|Contact:' | sed 's/^/     /'
else
  bad "No endpoints visible to Asterisk."
  echo "     Create one in the GUI, then: asterisk -rx 'pjsip show endpoints'"
  echo "     If the GUI shows it but this doesn't, realtime/ODBC is the problem (see above)."
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
