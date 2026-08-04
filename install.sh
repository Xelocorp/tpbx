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
#   1. Installs OS packages (PostgreSQL, Asterisk, unixODBC, build tools)
#   2. Installs pinned Go + Node toolchains (only if missing/too old)
#   3. Generates secrets once and writes /etc/tpbx/tpbx.env
#   4. Creates the tpbx PostgreSQL role + database (owned by the app role)
#   5. Wires ODBC (odbcinst.ini / odbc.ini)
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
    ca-certificates curl git build-essential openssl \
    postgresql postgresql-contrib \
    unixodbc odbc-postgresql \
    asterisk asterisk-modules asterisk-config \
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

# ensure_realtime_module makes sure the PJSIP realtime backend (res_config_odbc)
# is actually present. res_pjsip reads its endpoints from realtime, so without
# this module it fails to start and no SIP transports bind. res_odbc alone is
# NOT enough -- res_config_odbc is the config/realtime engine on top of it.
ensure_realtime_module() {
  ASTERISK_MODULES_DIR="$(detect_module_dir)"
  info "Asterisk modules dir: ${ASTERISK_MODULES_DIR:-<not found>}"
  if [ ! -f "${ASTERISK_MODULES_DIR}/res_config_odbc.so" ]; then
    log "Installing Asterisk ODBC realtime module"
    apt-get install -y -qq asterisk-modules >/dev/null 2>&1 || true
  fi
  if [ -f "${ASTERISK_MODULES_DIR}/res_config_odbc.so" ]; then
    info "res_config_odbc realtime module present"
  elif [ -f "${ASTERISK_MODULES_DIR}/res_config_pgsql.so" ]; then
    warn "res_config_odbc missing but res_config_pgsql is available"
    warn "(native PostgreSQL realtime). ODBC realtime will be unavailable."
  else
    warn "res_config_odbc.so NOT found -- PJSIP realtime cannot work."
    warn "res_pjsip will fail to load its endpoints. Install the module that"
    warn "provides res_config_odbc for your Asterisk build, then re-run install."
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
    return
  fi
  log "Generating secrets -> $ENV_FILE"
  install -d -m 0750 "$(dirname "$ENV_FILE")"

  TPBX_DB_PASSWORD="$(gen_secret)"
  local ari_pass ami_pass
  ari_pass="$(gen_secret)"
  ami_pass="$(gen_secret)"

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

# ---------------------------------------------------------------------- ODBC
provision_odbc() {
  log "Configuring ODBC"
  local driver
  driver="$(find /usr/lib -name 'psqlodbcw.so' 2>/dev/null | head -n1)"
  [ -n "$driver" ] || die "psqlODBC driver not found (odbc-postgresql package)"
  local setup
  setup="$(find /usr/lib -name 'libodbcpsqlS.so' 2>/dev/null | head -n1)"

  cat > /etc/odbcinst.ini <<EOF
[PostgreSQL]
Description = PostgreSQL ODBC driver
Driver      = ${driver}
Setup       = ${setup:-${driver}}
EOF

  cat > /etc/odbc.ini <<EOF
[tpbx-pg]
Description = TPBX PostgreSQL
Driver      = PostgreSQL
Servername  = 127.0.0.1
Port        = 5432
Database    = tpbx
Username    = tpbx
Password    = ${TPBX_DB_PASSWORD}
EOF
  info "ODBC DSN 'tpbx-pg' configured"
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
# fixed file. res_odbc + res_config_odbc must load before res_pjsip.
write_modules_conf() {
  [ -d "${ASTERISK_MODULES_DIR:-}" ] || ASTERISK_MODULES_DIR="$(detect_module_dir)"
  local mc="${ASTERISK_DIR}/modules.conf"
  [ -f "$mc" ] && [ ! -f "${mc}.tpbx-orig" ] && cp -a "$mc" "${mc}.tpbx-orig"
  {
    echo "; managed by TPBX -- preloads the realtime stack before res_pjsip"
    echo "[modules]"
    echo "autoload = yes"
    [ -f "${ASTERISK_MODULES_DIR}/res_odbc.so" ] && echo "preload = res_odbc.so"
    [ -f "${ASTERISK_MODULES_DIR}/res_config_odbc.so" ] && echo "preload = res_config_odbc.so"
  } > "$mc"
  chown root:asterisk "$mc" 2>/dev/null || true
  chmod 0640 "$mc"
  if [ -f "${ASTERISK_MODULES_DIR}/res_config_odbc.so" ]; then
    info "modules.conf preloads res_odbc + res_config_odbc"
  else
    warn "modules.conf written WITHOUT res_config_odbc (module missing)"
  fi
}

provision_asterisk_config() {
  log "Installing Asterisk configuration"
  install -d "$ASTERISK_DIR"
  for f in res_odbc.conf extconfig.conf sorcery.conf \
           cdr_adaptive_odbc.conf cel_odbc.conf ari.conf manager.conf \
           pjsip_transports.conf; do
    render_conf "$f"
  done

  write_modules_conf

  # Ensure pjsip.conf includes the managed transports.
  local pjsip="${ASTERISK_DIR}/pjsip.conf"
  touch "$pjsip"
  if ! grep -q 'pjsip_transports.conf' "$pjsip"; then
    printf '\n; --- managed by TPBX ---\n#include "pjsip_transports.conf"\n' >> "$pjsip"
    info "added transports include to pjsip.conf"
  fi

  # Enable CEL (needed for cel_odbc to record anything).
  local cel="${ASTERISK_DIR}/cel.conf"
  if [ ! -f "$cel" ] || ! grep -qE '^\s*enable\s*=\s*yes' "$cel"; then
    [ -f "$cel" ] && [ ! -f "${cel}.tpbx-orig" ] && cp -a "$cel" "${cel}.tpbx-orig"
    printf '[general]\nenable=yes\napps=all\nevents=all\n' > "$cel"
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

# --------------------------------------------------------------- app service
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

restart_asterisk() {
  log "Enabling + restarting Asterisk"
  systemctl enable --now asterisk >/dev/null 2>&1 || service asterisk start || true
  systemctl restart asterisk 2>/dev/null || service asterisk restart || true

  # Verify SIP transports actually came up. If realtime/ODBC was briefly
  # unavailable, res_pjsip can load without its transports; a reload of
  # res_odbc then res_pjsip recovers it once PostgreSQL is reachable.
  sleep 2
  if command -v asterisk >/dev/null 2>&1; then
    if ! asterisk -rx "pjsip show transports" 2>/dev/null | grep -q 'transport-'; then
      warn "no PJSIP transports after start; reloading res_odbc + res_pjsip"
      asterisk -rx "module reload res_odbc.so" >/dev/null 2>&1 || true
      asterisk -rx "module reload res_pjsip.so" >/dev/null 2>&1 || true
      sleep 1
    fi
    if asterisk -rx "pjsip show transports" 2>/dev/null | grep -q 'transport-'; then
      info "PJSIP transports are up"
    else
      warn "PJSIP transports still not loaded -- run scripts/diagnose.sh"
    fi
  fi
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
    # secret would not satisfy the scram requirement in pg_hba and every ODBC
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
  chmod 0600 /etc/odbc.ini 2>/dev/null || true

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
  ufw allow 8089/tcp >/dev/null               # WSS (WebRTC)
  ufw allow 10000:20000/udp >/dev/null        # RTP media
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
  Note              : self-signed. Replace with a CA-signed cert for
                      production WebRTC (browsers reject self-signed WSS).

--- LISTENING PORTS ------------------------------------------
  8080/tcp  TPBX GUI/API        (this app)
  8088/tcp  Asterisk ARI        (localhost only)
  8089/tcp  Asterisk WSS/WebRTC
  5038/tcp  Asterisk AMI        (localhost only)
  5060/udp+tcp  SIP
  5061/tcp  SIP TLS
  10000-20000/udp  RTP media

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
  printf '  Service : systemctl status %s\n' "$APP_NAME"
  printf '  Logs    : journalctl -u %s -f\n' "$APP_NAME"
  printf '  %sCREDENTIALS: %s%s  <- all usernames/passwords\n' "$BOLD" "$CREDS_FILE" "$OFF"
  printf '  Secrets : %s\n' "$ENV_FILE"
  printf '  Upgrade : git pull && sudo ./upgrade.sh\n'
  printf '%s================================================%s\n\n' "$GREEN$BOLD" "$OFF"
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
  provision_odbc
  # Harden (which restarts PostgreSQL for scram-sha-256/localhost binding) MUST
  # run before Asterisk starts. Otherwise the PostgreSQL restart drops
  # Asterisk's ODBC connection, realtime fails, and res_pjsip aborts loading its
  # SIP transports -- leaving nothing listening on 5060.
  harden
  provision_asterisk_config
  ensure_app_user
  build_app
  run_migrations
  install_service
  restart_service
  # Start Asterisk LAST, so it connects to a PostgreSQL that is in its final
  # state and will not be restarted underneath it.
  restart_asterisk
  write_credentials
  summary
}

main "$@"
