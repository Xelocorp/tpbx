#!/usr/bin/env bash
#
# install.sh -- fresh-server bootstrap for the TPBX Asterisk control console.
#
# Idempotent: safe to re-run. On first run it installs and configures
# everything from scratch on Ubuntu 22.04/24.04; on later runs it repairs
# config and leaves generated secrets untouched.
#
#   Usage:  sudo ./install.sh
#
# What it does:
#   1. Installs OS packages (PostgreSQL, Asterisk, build tools)
#   2. Installs pinned Go + Node toolchains (only if missing/too old)
#   3. Generates secrets once and writes /etc/tpbx/tpbx.env
#   4. Creates the tpbx PostgreSQL role + database (owned by the app role)
#   5. Configures native PostgreSQL realtime (res_pgsql.conf) -- no ODBC
#   6. Installs Asterisk config, self-signed TLS certs, and include lines
#   7. Builds the backend + frontend and installs the binary
#   8. Runs database migrations
#   9. Installs and starts the systemd service

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export REPO_DIR
# shellcheck source=scripts/lib.sh
. "${REPO_DIR}/scripts/lib.sh"

# ------------------------------------------------------------------- OS deps
detect_os() {
  [ -f /etc/os-release ] || die "cannot detect OS (no /etc/os-release)"
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian) : ;;
    *) warn "tested on Ubuntu 22.04/24.04; '$ID' may need manual tweaks" ;;
  esac
}

install_packages() {
  log "Installing OS packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq \
    ca-certificates curl git build-essential openssl zip \
    postgresql postgresql-contrib \
    asterisk asterisk-modules asterisk-config \
    coturn certbot \
    fail2ban >/dev/null
  info "packages installed"
  ensure_realtime_module
}

# detect_module_dir locates Asterisk's loadable-module directory, which varies
# by packaging: Debian/Ubuntu multiarch (asterisk 22) uses
# /usr/lib/<triplet>/asterisk/modules, older builds use /usr/lib/asterisk/modules.
detect_module_dir() {
  local d
  for d in \
    /usr/lib/x86_64-linux-gnu/asterisk/modules \
    /usr/lib/aarch64-linux-gnu/asterisk/modules \
    /usr/lib/asterisk/modules \
    /usr/lib64/asterisk/modules; do
    [ -d "$d" ] && { echo "$d"; return 0; }
  done
  find /usr/lib -type d -path '*asterisk/modules' 2>/dev/null | head -1
}

# ensure_realtime_module makes sure the native PostgreSQL realtime backend
# (res_config_pgsql) is present. res_pjsip reads its endpoints from realtime, so
# without this module it fails to start and no SIP transports bind.
ensure_realtime_module() {
  ASTERISK_MODULES_DIR="$(detect_module_dir)"
  info "Asterisk modules dir: ${ASTERISK_MODULES_DIR:-<not found>}"
  if [ ! -f "${ASTERISK_MODULES_DIR}/res_config_pgsql.so" ]; then
    log "Ensuring Asterisk PostgreSQL realtime module is installed"
    apt-get install -y -qq asterisk-modules >/dev/null 2>&1 || true
  fi
  if [ -f "${ASTERISK_MODULES_DIR}/res_config_pgsql.so" ]; then
    info "res_config_pgsql (native PostgreSQL realtime) present"
  else
    warn "res_config_pgsql.so NOT found -- PJSIP realtime cannot work."
    warn "res_pjsip will fail to load its endpoints. Install the module that"
    warn "provides res_config_pgsql for your Asterisk build, then re-run install."
  fi
}

ensure_go() {
  local go; go="$(go_bin)"
  if "$go" version 2>/dev/null | grep -qE 'go1\.(2[5-9]|[3-9][0-9])'; then
    info "Go present: $($go version)"
    return
  fi
  log "Installing Go ${GO_VERSION}"
  local tarball
  tarball="go${GO_VERSION}.linux-$(arch_tag).tar.gz"
  curl -fsSL "https://go.dev/dl/${tarball}" -o "/tmp/${tarball}"
  rm -rf /usr/local/go
  tar -C /usr/local -xzf "/tmp/${tarball}"
  rm -f "/tmp/${tarball}"
  info "installed $(/usr/local/go/bin/go version)"
}

ensure_node() {
  if command -v node >/dev/null 2>&1 && \
     [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -ge "$NODE_MAJOR" ]; then
    info "Node present: $(node -v)"
    return
  fi
  log "Installing Node ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  info "installed $(node -v)"
}

ensure_postgres() {
  log "Ensuring PostgreSQL is running"
  systemctl enable --now postgresql >/dev/null 2>&1 || service postgresql start
  # Wait for the socket.
  for _ in $(seq 1 10); do
    sudo -u postgres psql -tc 'SELECT 1' >/dev/null 2>&1 && break
    sleep 1
  done
  sudo -u postgres psql -tc 'SELECT 1' >/dev/null 2>&1 || die "PostgreSQL not accepting connections"
}

# ----------------------------------------------------------------- env/secrets
provision_env() {
  if load_env; then
    log "Reusing existing secrets from $ENV_FILE"
    # Repair TPBX_WEB_DIR from older installs that pointed it at the repo
    # checkout (which the service user often cannot read).
    if ! grep -q "^TPBX_WEB_DIR=${STATE_DIR}/web/dist$" "$ENV_FILE"; then
      sed -i "s|^TPBX_WEB_DIR=.*|TPBX_WEB_DIR=${STATE_DIR}/web/dist|" "$ENV_FILE"
      grep -q '^TPBX_WEB_DIR=' "$ENV_FILE" || echo "TPBX_WEB_DIR=${STATE_DIR}/web/dist" >> "$ENV_FILE"
      info "corrected TPBX_WEB_DIR -> ${STATE_DIR}/web/dist"
      load_env
    fi
    if ! grep -q '^TPBX_DIALPLAN_FILE=' "$ENV_FILE"; then
      echo "TPBX_DIALPLAN_FILE=${STATE_DIR}/extensions_tpbx.conf" >> "$ENV_FILE"
      info "added TPBX_DIALPLAN_FILE"
      load_env
    fi
    if ! grep -q '^TPBX_ADMIN_PASSWORD=' "$ENV_FILE"; then
      { echo "TPBX_ADMIN_USER=admin"; echo "TPBX_ADMIN_PASSWORD=$(gen_secret)"; } >> "$ENV_FILE"
      info "added GUI admin credentials"
      load_env
    fi
    # WebRTC softphone additions (agent app + coturn shared secret).
    if ! grep -q '^TPBX_TURN_SECRET=' "$ENV_FILE"; then
      echo "TPBX_TURN_SECRET=$(gen_secret)" >> "$ENV_FILE"
      info "added TURN shared secret"
      load_env
    fi
    if ! grep -q '^TPBX_AGENT_WEB_DIR=' "$ENV_FILE"; then
      echo "TPBX_AGENT_WEB_DIR=${STATE_DIR}/web/dist-agent" >> "$ENV_FILE"
      load_env
    fi
    if ! grep -q '^TPBX_DOMAIN=' "$ENV_FILE"; then
      echo "TPBX_DOMAIN=${TPBX_DOMAIN:-}" >> "$ENV_FILE"
      load_env
    fi
    if ! grep -q '^TPBX_SOUNDS_DIR=' "$ENV_FILE"; then
      { echo "TPBX_SOUNDS_DIR=${SOUNDS_DIR}"; echo "TPBX_SOUNDS_PREFIX=tpbx"; } >> "$ENV_FILE"
      info "added IVR prompt directory (TPBX_SOUNDS_DIR)"
      load_env
    fi
    return
  fi
  log "Generating secrets -> $ENV_FILE"
  install -d -m 0750 "$(dirname "$ENV_FILE")"

  TPBX_DB_PASSWORD="$(gen_secret)"
  local ari_pass ami_pass admin_pass turn_secret
  ari_pass="$(gen_secret)"
  ami_pass="$(gen_secret)"
  admin_pass="$(gen_secret)"
  turn_secret="$(gen_secret)"

  cat > "$ENV_FILE" <<EOF
# TPBX runtime configuration -- generated by install.sh on $(date -u +%FT%TZ)
# Loaded by systemd (EnvironmentFile) and by install/upgrade scripts.
TPBX_HTTP_ADDR=${HTTP_ADDR}
TPBX_DB_PASSWORD=${TPBX_DB_PASSWORD}
TPBX_DATABASE_URL=postgres://tpbx:${TPBX_DB_PASSWORD}@127.0.0.1:5432/tpbx?sslmode=disable
TPBX_ARI_URL=http://127.0.0.1:8088
TPBX_ARI_USER=tpbx
TPBX_ARI_PASS=${ari_pass}
TPBX_ARI_APP=tpbx
TPBX_AMI_ADDR=127.0.0.1:5038
TPBX_AMI_USER=tpbx
TPBX_AMI_PASS=${ami_pass}
TPBX_ASTERISK_CONF_DIR=${ASTERISK_DIR}
TPBX_WEB_DIR=${STATE_DIR}/web/dist
TPBX_AGENT_WEB_DIR=${STATE_DIR}/web/dist-agent
TPBX_DIALPLAN_FILE=${STATE_DIR}/extensions_tpbx.conf
TPBX_TRANSPORTS_FILE=${STATE_DIR}/pjsip_transports.conf
TPBX_ADMIN_USER=admin
TPBX_ADMIN_PASSWORD=${admin_pass}
# WebRTC softphone: public FQDN (blank = derive from request host; set this once
# you have a domain + TLS), Asterisk secure-WebSocket port, and coturn secret.
TPBX_DOMAIN=${TPBX_DOMAIN:-}
TPBX_SIP_WSS_PORT=8089
TPBX_TURN_SECRET=${turn_secret}
# IVR prompt uploads land here (under Asterisk's sounds tree) and are played as
# <TPBX_SOUNDS_PREFIX>/<name>, e.g. tpbx/welcome.
TPBX_SOUNDS_DIR=${SOUNDS_DIR}
TPBX_SOUNDS_PREFIX=tpbx
EOF
  chmod 0640 "$ENV_FILE"
  load_env
}

# ------------------------------------------------------------------ database
provision_database() {
  log "Provisioning PostgreSQL role + database"
  # Role: create or sync password.
  if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='tpbx'" | grep -q 1; then
    sudo -u postgres psql -q -c "ALTER ROLE tpbx LOGIN PASSWORD '${TPBX_DB_PASSWORD}';"
  else
    sudo -u postgres psql -q -c "CREATE ROLE tpbx LOGIN PASSWORD '${TPBX_DB_PASSWORD}';"
  fi
  # Database owned by the app role.
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='tpbx'" | grep -q 1; then
    sudo -u postgres psql -q -c "CREATE DATABASE tpbx OWNER tpbx;"
  fi
  # Ensure the app role owns the public schema so migrations (run as tpbx)
  # create tables it can then read/write. This is the ownership gotcha.
  sudo -u postgres psql -d tpbx -q -c "ALTER SCHEMA public OWNER TO tpbx;" || true
  info "database ready"
}

# ------------------------------------------------------------------ asterisk
# render_conf copies a template from the repo into /etc/asterisk, substituting
# secret placeholders and backing up any pre-existing file once.
render_conf() {
  local name="$1"
  local src="${REPO_DIR}/asterisk/${name}"
  local dst="${ASTERISK_DIR}/${name}"
  [ -f "$src" ] || die "missing template $src"
  if [ -f "$dst" ] && [ ! -f "${dst}.tpbx-orig" ]; then
    cp -a "$dst" "${dst}.tpbx-orig"
  fi
  sed -e "s|__DB_PASSWORD__|${TPBX_DB_PASSWORD}|g" \
      -e "s|__ARI_PASSWORD__|${TPBX_ARI_PASS}|g" \
      -e "s|__AMI_PASSWORD__|${TPBX_AMI_PASS}|g" \
      "$src" > "$dst"
  chown root:asterisk "$dst" 2>/dev/null || true
  chmod 0640 "$dst"
}

# write_modules_conf generates /etc/asterisk/modules.conf, preloading ONLY the
# realtime modules that actually exist on disk. Preloading a missing module is
# fatal to Asterisk, so this is generated dynamically rather than shipped as a
# fixed file. res_config_pgsql must load before res_pjsip.
write_modules_conf() {
  [ -d "${ASTERISK_MODULES_DIR:-}" ] || ASTERISK_MODULES_DIR="$(detect_module_dir)"
  local mc="${ASTERISK_DIR}/modules.conf"
  [ -f "$mc" ] && [ ! -f "${mc}.tpbx-orig" ] && cp -a "$mc" "${mc}.tpbx-orig"
  {
    echo "; managed by TPBX -- preloads the realtime engine before res_pjsip"
    echo "[modules]"
    echo "autoload = yes"
    [ -f "${ASTERISK_MODULES_DIR}/res_config_pgsql.so" ] && echo "preload = res_config_pgsql.so"
    # The legacy chan_sip stack must NOT load: it knows nothing of our PJSIP
    # realtime endpoints, yet it will grab the WebSocket 'sip' subprotocol and
    # reject WebRTC softphone registrations with "Wrong password". Everything
    # here runs on res_pjsip, so unload chan_sip entirely.
    echo "noload = chan_sip.so"
  } > "$mc"
  chown root:asterisk "$mc" 2>/dev/null || true
  chmod 0640 "$mc"
  if [ -f "${ASTERISK_MODULES_DIR}/res_config_pgsql.so" ]; then
    info "modules.conf preloads res_config_pgsql"
  else
    warn "modules.conf written WITHOUT res_config_pgsql (module missing)"
  fi
}

provision_asterisk_config() {
  log "Installing Asterisk configuration"
  install -d "$ASTERISK_DIR"
  for f in res_pgsql.conf extconfig.conf sorcery.conf \
           cdr_pgsql.conf cel_pgsql.conf ari.conf manager.conf \
           extensions.conf logger.conf; do
    render_conf "$f"
  done

  write_modules_conf

  # Ensure pjsip.conf includes the managed transports. The transports file is
  # rewritten by the service on GUI edits, but systemd's ProtectSystem=full
  # makes /etc read-only for the service -- so, like the routing dialplan, it
  # lives under the writable state dir and is #included by absolute path.
  local pjsip="${ASTERISK_DIR}/pjsip.conf"
  local tinc="${STATE_DIR}/pjsip_transports.conf"
  touch "$pjsip"
  # Drop any earlier relative include (older installs shipped the file in
  # /etc/asterisk); the regex only matches the bare filename, not the new
  # absolute-path include.
  if grep -qE '#include[[:space:]]+"?pjsip_transports\.conf"?[[:space:]]*$' "$pjsip"; then
    grep -vE '#include[[:space:]]+"?pjsip_transports\.conf"?[[:space:]]*$' "$pjsip" > "${pjsip}.tpbx.tmp" \
      && mv "${pjsip}.tpbx.tmp" "$pjsip"
  fi
  if ! grep -qF "#include \"$tinc\"" "$pjsip"; then
    printf '\n; --- managed by TPBX ---\n#include "%s"\n' "$tinc" >> "$pjsip"
    info "added transports include to pjsip.conf ($tinc)"
  fi

  # Enable CEL (needed for cel_pgsql to record anything). Keep it minimal and
  # valid: just switch the engine on. (apps=/events= are not valid [general]
  # keys and only produce warnings.)
  local cel="${ASTERISK_DIR}/cel.conf"
  if [ ! -f "$cel" ] || ! grep -qE '^\s*enable\s*=\s*yes' "$cel"; then
    [ -f "$cel" ] && [ ! -f "${cel}.tpbx-orig" ] && cp -a "$cel" "${cel}.tpbx-orig"
    printf '; managed by TPBX\n[general]\nenable=yes\n' > "$cel"
  fi

  # HTTP server (required by ARI + the WebRTC WSS transport). On a fresh box we
  # write a managed http.conf, backing up any existing one.
  local http="${ASTERISK_DIR}/http.conf"
  [ -f "$http" ] && [ ! -f "${http}.tpbx-orig" ] && cp -a "$http" "${http}.tpbx-orig"
  cat > "$http" <<EOF
; managed by TPBX
[general]
enabled=yes
bindaddr=127.0.0.1
bindport=8088
tlsenable=yes
tlsbindaddr=0.0.0.0:8089
tlscertfile=${ASTERISK_KEYS_DIR}/tpbx.crt
tlsprivatekey=${ASTERISK_KEYS_DIR}/tpbx.key
EOF
  chown root:asterisk "$http" 2>/dev/null || true

  provision_certs
}

provision_certs() {
  install -d -m 0750 "$ASTERISK_KEYS_DIR"
  if [ ! -f "${ASTERISK_KEYS_DIR}/tpbx.crt" ]; then
    log "Generating self-signed TLS certificate (TLS/WSS)"
    local cn; cn="$(hostname -f 2>/dev/null || hostname)"
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
      -keyout "${ASTERISK_KEYS_DIR}/tpbx.key" \
      -out "${ASTERISK_KEYS_DIR}/tpbx.crt" \
      -subj "/CN=${cn}" >/dev/null 2>&1
    info "cert CN=${cn} (replace with a CA-signed cert for production WebRTC)"
  fi
  chown -R asterisk:asterisk "$ASTERISK_KEYS_DIR" 2>/dev/null || true
  chmod 0640 "${ASTERISK_KEYS_DIR}/tpbx.key" 2>/dev/null || true
}

# provision_letsencrypt obtains a browser-trusted certificate when TPBX_DOMAIN
# is set, and flows it into the managed cert files that Asterisk (WSS) and
# coturn (turns:) already read -- so no other config path changes. Without a
# domain it is a no-op and the self-signed cert stands. Best-effort: a DNS that
# does not yet point here just leaves the self-signed cert in place.
provision_letsencrypt() {
  if [ -z "${TPBX_DOMAIN:-}" ]; then
    info "TPBX_DOMAIN not set -- using self-signed cert (set a domain for browser-trusted WSS/TURN, then re-run install.sh)"
    return
  fi
  if ! command -v certbot >/dev/null 2>&1; then
    warn "certbot not installed; skipping Let's Encrypt"
    return
  fi
  log "Obtaining Let's Encrypt certificate for ${TPBX_DOMAIN}"
  local -a email_args=(--register-unsafely-without-email)
  [ -n "${TPBX_LE_EMAIL:-}" ] && email_args=(-m "${TPBX_LE_EMAIL}")

  # certbot --standalone binds :80; open it transiently if ufw is active.
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow 80/tcp >/dev/null 2>&1 || true
  fi

  if certbot certonly --standalone --non-interactive --agree-tos \
       "${email_args[@]}" -d "$TPBX_DOMAIN" >/dev/null 2>&1; then
    local live="/etc/letsencrypt/live/${TPBX_DOMAIN}"
    if [ -f "${live}/fullchain.pem" ]; then
      cp "${live}/fullchain.pem" "${ASTERISK_KEYS_DIR}/tpbx.crt"
      cp "${live}/privkey.pem" "${ASTERISK_KEYS_DIR}/tpbx.key"
      chown asterisk:asterisk "${ASTERISK_KEYS_DIR}/tpbx.crt" "${ASTERISK_KEYS_DIR}/tpbx.key" 2>/dev/null || true
      chmod 0640 "${ASTERISK_KEYS_DIR}/tpbx.key"
      info "installed Let's Encrypt cert for ${TPBX_DOMAIN}"
      install_le_renewal_hook
    fi
  else
    warn "certbot failed (is DNS for ${TPBX_DOMAIN} pointing at this server, and :80 open?) -- keeping self-signed cert"
  fi
}

# install_le_renewal_hook re-copies the renewed cert into the managed files and
# reloads the consumers, so renewals do not silently expire WSS/TURN.
install_le_renewal_hook() {
  local dir="/etc/letsencrypt/renewal-hooks/deploy"
  install -d "$dir"
  cat > "${dir}/tpbx.sh" <<EOF
#!/usr/bin/env bash
# managed by TPBX -- sync renewed cert into Asterisk + coturn and reload.
set -e
live="/etc/letsencrypt/live/${TPBX_DOMAIN}"
cp "\${live}/fullchain.pem" "${ASTERISK_KEYS_DIR}/tpbx.crt"
cp "\${live}/privkey.pem"   "${ASTERISK_KEYS_DIR}/tpbx.key"
chown asterisk:asterisk "${ASTERISK_KEYS_DIR}/tpbx.crt" "${ASTERISK_KEYS_DIR}/tpbx.key" || true
chmod 0640 "${ASTERISK_KEYS_DIR}/tpbx.key"
cp "\${live}/fullchain.pem" /etc/coturn/turn.crt
cp "\${live}/privkey.pem"   /etc/coturn/turn.key
chown turnserver:turnserver /etc/coturn/turn.crt /etc/coturn/turn.key || true
chmod 0640 /etc/coturn/turn.key
systemctl reload asterisk 2>/dev/null || systemctl restart asterisk || true
systemctl restart coturn 2>/dev/null || true
EOF
  chmod 0755 "${dir}/tpbx.sh"
}

# provision_coturn installs a STUN/TURN configuration so WebRTC media traverses
# NAT and restrictive firewalls. It authenticates browsers with time-limited
# HMAC credentials (use-auth-secret) minted by the backend from the same shared
# secret, so no long-term TURN passwords exist.
provision_coturn() {
  log "Configuring coturn (STUN/TURN for WebRTC media)"
  if [ -z "${TPBX_TURN_SECRET:-}" ]; then
    warn "TPBX_TURN_SECRET missing; TURN will be disabled (STUN only)"
    return
  fi
  local realm ext_ip cert_dir
  realm="${TPBX_DOMAIN:-$(hostname -f 2>/dev/null || hostname)}"
  cert_dir="/etc/coturn"
  install -d -m 0750 "$cert_dir"

  # coturn runs as its own user and needs a readable copy of the TLS material.
  if [ -f "${ASTERISK_KEYS_DIR}/tpbx.crt" ]; then
    cp "${ASTERISK_KEYS_DIR}/tpbx.crt" "${cert_dir}/turn.crt"
    cp "${ASTERISK_KEYS_DIR}/tpbx.key" "${cert_dir}/turn.key"
  fi
  chown -R turnserver:turnserver "$cert_dir" 2>/dev/null || true
  chmod 0640 "${cert_dir}/turn.key" 2>/dev/null || true

  # Best-effort public IP for 1:1 NAT (cloud VPS). Non-fatal if unavailable.
  ext_ip="$(curl -fsS --max-time 4 https://api.ipify.org 2>/dev/null || true)"

  local conf="/etc/turnserver.conf"
  [ -f "$conf" ] && [ ! -f "${conf}.tpbx-orig" ] && cp -a "$conf" "${conf}.tpbx-orig"
  {
    echo "# managed by TPBX -- STUN/TURN for the WebRTC softphone"
    echo "listening-port=3478"
    echo "tls-listening-port=5349"
    echo "fingerprint"
    echo "use-auth-secret"
    echo "static-auth-secret=${TPBX_TURN_SECRET}"
    echo "realm=${realm}"
    echo "cert=${cert_dir}/turn.crt"
    echo "pkey=${cert_dir}/turn.key"
    echo "min-port=49152"
    echo "max-port=49251"
    echo "no-cli"
    echo "no-tcp-relay"
    echo "no-multicast-peers"
    echo "stale-nonce=600"
    # SSRF hardening: never relay to loopback/private/link-local ranges.
    echo "denied-peer-ip=0.0.0.0-0.255.255.255"
    echo "denied-peer-ip=10.0.0.0-10.255.255.255"
    echo "denied-peer-ip=127.0.0.0-127.255.255.255"
    echo "denied-peer-ip=169.254.0.0-169.254.255.255"
    echo "denied-peer-ip=172.16.0.0-172.31.255.255"
    echo "denied-peer-ip=192.168.0.0-192.168.255.255"
    echo "denied-peer-ip=::1"
    echo "denied-peer-ip=fe80::-fe80::ffff:ffff:ffff:ffff"
    [ -n "$ext_ip" ] && echo "external-ip=${ext_ip}"
  } > "$conf"
  chmod 0640 "$conf"

  # Debian gates the daemon behind this flag.
  if [ -f /etc/default/coturn ]; then
    sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
    grep -q '^TURNSERVER_ENABLED=1' /etc/default/coturn || echo "TURNSERVER_ENABLED=1" >> /etc/default/coturn
  fi
  systemctl enable coturn >/dev/null 2>&1 || true
  systemctl restart coturn 2>/dev/null || service coturn restart 2>/dev/null || true
  info "coturn realm=${realm}${ext_ip:+, external-ip=${ext_ip}}"
}

# --------------------------------------------------------------- app service
# seed_dialplan creates the generated routing include if absent, owned by the
# service user (which rewrites it) and readable by Asterisk. Empty contexts so
# the `include =>` targets in extensions.conf resolve on first boot.
seed_dialplan() {
  install -d -o "$APP_USER" -g "$APP_USER" "$STATE_DIR"
  local f="${STATE_DIR}/extensions_tpbx.conf"
  if [ ! -f "$f" ]; then
    printf '; generated by TPBX (empty until routes are added)\n[tpbx-outbound]\n[tpbx-inbound]\n' > "$f"
  fi
  chown "$APP_USER":"$APP_USER" "$f" 2>/dev/null || true
  chmod 0644 "$f"
  info "routing dialplan include: $f"

  # Seed the managed PJSIP transports include so Asterisk has valid transports
  # on its very first boot (before the service regenerates it from the DB). The
  # service rewrites this file on every GUI transport change.
  local tf="${STATE_DIR}/pjsip_transports.conf"
  if [ ! -f "$tf" ]; then
    if [ -f "${REPO_DIR}/asterisk/pjsip_transports.conf" ]; then
      cp "${REPO_DIR}/asterisk/pjsip_transports.conf" "$tf"
    else
      printf '; generated by TPBX (regenerated from the database on start)\n' > "$tf"
    fi
  fi
  chown "$APP_USER":"$APP_USER" "$tf" 2>/dev/null || true
  chmod 0644 "$tf"
  info "transports include: $tf"
}

ensure_app_user() {
  if ! id -u "$APP_USER" >/dev/null 2>&1; then
    log "Creating system user '$APP_USER'"
    useradd --system --home "$STATE_DIR" --create-home --shell /usr/sbin/nologin "$APP_USER"
  fi
  install -d -o "$APP_USER" -g "$APP_USER" "$STATE_DIR"
  # Forward-looking: the service will later write managed includes + run the
  # Asterisk CLI, which requires membership in the asterisk group.
  usermod -aG asterisk "$APP_USER" 2>/dev/null || true
}

install_service() {
  log "Installing systemd service"
  cat > "$SERVICE_PATH" <<EOF
[Unit]
Description=TPBX Asterisk Control Console
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
EnvironmentFile=${ENV_FILE}
WorkingDirectory=${STATE_DIR}
ExecStart=${BIN_PATH} serve
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$APP_NAME" >/dev/null 2>&1 || true
}

# asterisk_service_dropin gives Asterisk a generous start timeout and a restart
# policy. The Debian unit is Type=notify; on a busy first boot Asterisk can take
# a while to signal readiness, and the default timeout may SIGKILL it. A longer
# timeout removes that failure mode.
asterisk_service_dropin() {
  local dir="/etc/systemd/system/asterisk.service.d"
  install -d "$dir"
  cat > "${dir}/tpbx.conf" <<'EOF'
# managed by TPBX
[Service]
TimeoutStartSec=180
Restart=on-failure
RestartSec=5
EOF
  # Remove any stale ODBC-era drop-in from earlier installs.
  rm -f "${dir}/tpbx-odbc.conf"
  systemctl daemon-reload
}

restart_asterisk() {
  log "Enabling + restarting Asterisk"
  asterisk_service_dropin
  systemctl enable asterisk >/dev/null 2>&1 || true
  systemctl restart asterisk 2>/dev/null || service asterisk restart || true

  # Give Asterisk a moment, then verify the realtime chain actually came up.
  sleep 3
  command -v asterisk >/dev/null 2>&1 || return 0

  if ! systemctl is-active --quiet asterisk; then
    warn "asterisk failed to start; recent logs:"
    journalctl -u asterisk -n 20 --no-pager 2>/dev/null || true
    warn "run: sudo asterisk -fcvvvvv   (foreground) to see the fatal error"
    return 0
  fi

  # Realtime backend up? (res_pjsip depends on it.) One reload retry in case
  # PostgreSQL settled a beat after Asterisk started.
  if ! asterisk -rx "pjsip show transports" 2>/dev/null | grep -q 'transport-'; then
    asterisk -rx "module reload res_config_pgsql.so" >/dev/null 2>&1 || true
    asterisk -rx "module reload res_pjsip.so" >/dev/null 2>&1 || true
    sleep 2
  fi

  local ok=1
  asterisk -rx "module show like res_config_pgsql" 2>/dev/null | grep -q 'Running' \
    && info "PostgreSQL realtime engine loaded" || { warn "res_config_pgsql not running"; ok=0; }
  asterisk -rx "pjsip show transports" 2>/dev/null | grep -q 'transport-' \
    && info "PJSIP transports are up" || { warn "PJSIP transports not loaded"; ok=0; }

  [ "$ok" -eq 1 ] || warn "Asterisk started but realtime/transports are not healthy -- run: sudo ./scripts/diagnose.sh"
}

# --------------------------------------------------------------- security
harden() {
  log "Applying security tuning"

  # 1. PostgreSQL: keep it on localhost and use scram-sha-256 password hashing.
  local pgconf pghba
  pgconf="$(sudo -u postgres psql -tAc 'SHOW config_file' 2>/dev/null || true)"
  if [ -n "$pgconf" ] && [ -f "$pgconf" ]; then
    sed -i "s/^#\?listen_addresses.*/listen_addresses = 'localhost'/" "$pgconf"
    grep -q "^password_encryption" "$pgconf" \
      && sed -i "s/^password_encryption.*/password_encryption = scram-sha-256/" "$pgconf" \
      || echo "password_encryption = scram-sha-256" >> "$pgconf"
    pghba="$(dirname "$pgconf")/pg_hba.conf"
    # Require md5/scram for local TCP, not 'trust'.
    [ -f "$pghba" ] && sed -i 's/^\(host\s\+all\s\+all\s\+127.0.0.1\/32\s\+\)trust/\1scram-sha-256/' "$pghba"
    systemctl restart postgresql >/dev/null 2>&1 || true

    # Re-hash the app role's password now that scram-sha-256 is enforced. If the
    # role was created earlier under a different password_encryption, its stored
    # secret would not satisfy the scram requirement in pg_hba and every DB
    # connection would fail -- taking realtime and the SIP transports with it.
    if [ -n "${TPBX_DB_PASSWORD:-}" ]; then
      for _ in $(seq 1 10); do
        sudo -u postgres psql -tc 'SELECT 1' >/dev/null 2>&1 && break
        sleep 1
      done
      sudo -u postgres psql -q -c "ALTER ROLE tpbx WITH PASSWORD '${TPBX_DB_PASSWORD}';" 2>/dev/null || true
    fi
    info "PostgreSQL bound to localhost, scram-sha-256 enforced"
  fi

  # 2. Lock down secret + config file permissions.
  chmod 0640 "$ENV_FILE" 2>/dev/null || true
  chgrp "$APP_USER" "$ENV_FILE" 2>/dev/null || true

  # 3. fail2ban: protect SSH always; add an Asterisk SIP jail (best-effort).
  if command -v fail2ban-server >/dev/null 2>&1; then
    cat > /etc/fail2ban/jail.d/tpbx.local <<'EOF'
[sshd]
enabled = true

[asterisk]
enabled  = true
maxretry = 5
findtime = 600
bantime  = 3600
EOF
    systemctl enable --now fail2ban >/dev/null 2>&1 || true
    systemctl restart fail2ban >/dev/null 2>&1 || true
    info "fail2ban enabled (sshd + asterisk jails)"
  fi

  configure_firewall
}

# configure_firewall is OFF by default: enabling ufw over SSH can lock you out
# if the SSH port is non-standard. Set TPBX_ENABLE_FIREWALL=yes to opt in; it
# always allows OpenSSH first.
configure_firewall() {
  if [ "${TPBX_ENABLE_FIREWALL:-no}" != "yes" ]; then
    warn "firewall not configured (set TPBX_ENABLE_FIREWALL=yes to enable ufw)"
    return
  fi
  command -v ufw >/dev/null 2>&1 || apt-get install -y -qq ufw >/dev/null
  log "Configuring ufw firewall"
  ufw --force reset >/dev/null
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow OpenSSH >/dev/null
  ufw allow "${HTTP_ADDR#:}"/tcp >/dev/null   # GUI/API
  ufw allow 5060/udp >/dev/null               # SIP UDP
  ufw allow 5060/tcp >/dev/null               # SIP TCP
  ufw allow 5061/tcp >/dev/null               # SIP TLS
  ufw allow 8089/tcp >/dev/null               # WSS (WebRTC signalling)
  ufw allow 10000:20000/udp >/dev/null        # RTP media
  ufw allow 3478 >/dev/null                   # STUN/TURN (udp+tcp)
  ufw allow 5349/tcp >/dev/null               # TURN over TLS
  ufw allow 49152:49251/udp >/dev/null        # coturn relay range
  ufw --force enable >/dev/null
  info "ufw enabled (SSH, GUI, SIP, WSS, RTP)"
}

# ----------------------------------------------------------------- credentials
write_credentials() {
  log "Writing credentials summary -> $CREDS_FILE"
  local ip fp
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fp="$(openssl x509 -in "${ASTERISK_KEYS_DIR}/tpbx.crt" -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2 || echo n/a)"

  cat > "$CREDS_FILE" <<EOF
================================================================
 TPBX -- Asterisk Control Console : CREDENTIALS & INSTALL REPORT
 Generated: $(date -u +%FT%TZ)   Host: $(hostname -f 2>/dev/null || hostname)
================================================================
KEEP THIS FILE SECRET. It contains every password for this install.
It is readable only by root (chmod 600). Copy it somewhere safe, then
you may delete it -- the live values also live in ${ENV_FILE}.

--- ACCESS ---------------------------------------------------
  Web console URL   : http://${ip:-<server-ip>}${HTTP_ADDR}
  GUI login user    : ${TPBX_ADMIN_USER:-admin}
  GUI login password: ${TPBX_ADMIN_PASSWORD:-<see ${ENV_FILE}>}
  Agent softphone   : http://${ip:-<server-ip>}${HTTP_ADDR}/phone
                      (agents sign in with their extension + SIP password)
  Service           : systemctl status ${APP_NAME}
  Live logs         : journalctl -u ${APP_NAME} -f

--- POSTGRESQL -----------------------------------------------
  Host / Port       : 127.0.0.1 : 5432  (localhost only)
  Database name     : tpbx
  Username          : tpbx
  Password          : ${TPBX_DB_PASSWORD}
  Connection URL    : ${TPBX_DATABASE_URL}
  Auth              : scram-sha-256

--- ASTERISK ARI (REST, localhost:8088) ----------------------
  Username          : ${TPBX_ARI_USER}
  Password          : ${TPBX_ARI_PASS}
  Stasis app        : ${TPBX_ARI_APP}

--- ASTERISK AMI (Manager, localhost:5038) -------------------
  Username          : ${TPBX_AMI_USER}
  Password          : ${TPBX_AMI_PASS}

--- TLS / WEBRTC ---------------------------------------------
  Certificate       : ${ASTERISK_KEYS_DIR}/tpbx.crt
  Private key       : ${ASTERISK_KEYS_DIR}/tpbx.key
  SHA-256 fingerprint: ${fp}
  Public domain     : ${TPBX_DOMAIN:-<none set -- self-signed>}
  Note              : $( [ -n "${TPBX_DOMAIN:-}" ] && echo "Let's Encrypt (auto-renewing) if issuance succeeded." || echo "self-signed. Set TPBX_DOMAIN + re-run install.sh for a browser-trusted cert (browsers reject self-signed WSS from remote clients).")

--- WEBRTC SOFTPHONE / TURN ----------------------------------
  Softphone URL     : http://${ip:-<server-ip>}${HTTP_ADDR}/phone
  Signalling (WSS)  : wss://${TPBX_DOMAIN:-${ip:-<server-ip>}}:8089/ws
  STUN              : stun:${TPBX_DOMAIN:-${ip:-<server-ip>}}:3478
  TURN              : turn:${TPBX_DOMAIN:-${ip:-<server-ip>}}:3478 / turns:...:5349
  TURN shared secret: ${TPBX_TURN_SECRET:-<see ${ENV_FILE}>}
  Note              : the backend mints short-lived TURN credentials from the
                      shared secret; agents never see a static TURN password.

--- LISTENING PORTS ------------------------------------------
  8080/tcp  TPBX GUI/API        (this app)
  8088/tcp  Asterisk ARI        (localhost only)
  8089/tcp  Asterisk WSS/WebRTC
  5038/tcp  Asterisk AMI        (localhost only)
  5060/udp+tcp  SIP
  5061/tcp  SIP TLS
  10000-20000/udp  RTP media
  3478/udp+tcp  STUN/TURN
  5349/tcp  TURN over TLS
  49152-49251/udp  coturn relay range

--- INSTALLED COMPONENTS -------------------------------------
  $($(go_bin) version 2>/dev/null || echo 'Go: n/a')
  Node $(node -v 2>/dev/null || echo n/a) / npm $(npm -v 2>/dev/null || echo n/a)
  $(sudo -u postgres psql -tAc 'SELECT version()' 2>/dev/null | head -c 40 || echo 'PostgreSQL: n/a')
  Asterisk $(asterisk -V 2>/dev/null | awk '{print $2}' || echo n/a)
  fail2ban $(fail2ban-server --version 2>/dev/null | head -n1 | awk '{print $2}' || echo n/a)

--- FILES ----------------------------------------------------
  Secrets / env     : ${ENV_FILE}
  This report       : ${CREDS_FILE}
  App binary        : ${BIN_PATH}
  Source checkout   : ${REPO_DIR}
  Asterisk config   : ${ASTERISK_DIR}/ (originals saved as *.tpbx-orig)

--- SECURITY NOTES -------------------------------------------
  * ARI + AMI are bound to 127.0.0.1 (never expose them).
  * fail2ban protects SSH and Asterisk from brute force.
  * Firewall (ufw): $( [ "${TPBX_ENABLE_FIREWALL:-no}" = yes ] && echo "enabled" || echo "NOT enabled -- run with TPBX_ENABLE_FIREWALL=yes or configure manually")
  * Change nothing here by hand; re-run ./install.sh to repair config.

--- UPGRADE --------------------------------------------------
  git pull && sudo ./upgrade.sh
================================================================
EOF
  chmod 0600 "$CREDS_FILE"
}

summary() {
  local ip; ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  printf '\n%s================ TPBX installed ================%s\n' "$GREEN$BOLD" "$OFF"
  printf '  Console : http://%s%s\n' "${ip:-<server-ip>}" "${HTTP_ADDR}"
  printf '  Phone   : http://%s%s/phone   (agent softphone)\n' "${ip:-<server-ip>}" "${HTTP_ADDR}"
  printf '  Service : systemctl status %s\n' "$APP_NAME"
  printf '  Logs    : journalctl -u %s -f\n' "$APP_NAME"
  printf '  %sCREDENTIALS: %s%s  <- all usernames/passwords\n' "$BOLD" "$CREDS_FILE" "$OFF"
  printf '  Secrets : %s\n' "$ENV_FILE"
  printf '  Upgrade : git pull && sudo ./upgrade.sh\n'
  printf '%s================================================%s\n\n' "$GREEN$BOLD" "$OFF"
}

# create_admin ensures the initial GUI admin account exists (idempotent; never
# overwrites a changed password).
create_admin() {
  load_env || return 0
  log "Ensuring GUI admin account"
  env TPBX_DATABASE_URL="$TPBX_DATABASE_URL" \
      TPBX_ADMIN_USER="${TPBX_ADMIN_USER:-admin}" \
      TPBX_ADMIN_PASSWORD="${TPBX_ADMIN_PASSWORD:-}" \
      "$BIN_PATH" create-admin || warn "could not create admin account (see logs)"
}

main() {
  require_root
  detect_os
  install_packages
  ensure_go
  ensure_node
  ensure_postgres
  provision_env
  provision_database
  # Harden (which restarts PostgreSQL for scram-sha-256/localhost binding) MUST
  # run before Asterisk starts. Otherwise the PostgreSQL restart drops
  # Asterisk's DB connection, realtime fails, and res_pjsip aborts loading its
  # SIP transports -- leaving nothing listening on 5060.
  harden
  provision_asterisk_config
  provision_letsencrypt
  provision_coturn
  ensure_app_user
  provision_sounds
  seed_dialplan
  build_app
  run_migrations
  create_admin
  install_service
  restart_service
  # Start Asterisk LAST, so it connects to a PostgreSQL that is in its final
  # state and will not be restarted underneath it.
  restart_asterisk
  write_credentials
  summary
}

main "$@"
