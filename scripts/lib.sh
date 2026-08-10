#!/usr/bin/env bash
# scripts/lib.sh -- shared helpers for install.sh and upgrade.sh.
#
# Sourced, never executed directly. Provides logging, root checks, secret
# generation, path constants, and the shared build/migrate/service routines so
# install and upgrade stay in lockstep.

# The constants below are consumed by install.sh / upgrade.sh, which source
# this file. Linting analyses files in isolation and cannot see that
# cross-file use, hence this file-wide unused-variable suppression.
# shellcheck disable=SC2034
set -euo pipefail

# ------------------------------------------------------------------ constants
APP_NAME="tpbx"
APP_USER="tpbx"                         # system user the service runs as
ENV_FILE="/etc/tpbx/tpbx.env"           # secrets + runtime config (systemd EnvironmentFile)
CREDS_FILE="/root/tpbx-credentials.txt" # human-readable summary of everything installed
BIN_PATH="/usr/local/bin/tpbx"          # installed binary
SERVICE_PATH="/etc/systemd/system/tpbx.service"
STATE_DIR="/var/lib/tpbx"
ASTERISK_DIR="/etc/asterisk"
ASTERISK_KEYS_DIR="${ASTERISK_DIR}/keys"
ASTERISK_MODULES_DIR="/usr/lib/asterisk/modules"
# Uploaded IVR prompts live under Asterisk's sounds tree (language "en") so they
# can be played as tpbx/<name>. The service writes here; Asterisk reads here.
SOUNDS_DIR="${TPBX_SOUNDS_DIR:-/var/lib/asterisk/sounds/en/tpbx}"

GO_VERSION="1.25.0"                     # must satisfy go.mod (go 1.25.0)
NODE_MAJOR="20"                         # LTS
HTTP_ADDR="${TPBX_HTTP_ADDR:-:8080}"

# REPO_DIR is the checkout that contains these scripts. Resolved by the caller
# (install.sh / upgrade.sh) before sourcing dependent functions.
REPO_DIR="${REPO_DIR:-}"

# ------------------------------------------------------------------- logging
_c() { printf '\033[%sm' "$1"; }
GREEN=$(_c '0;32'); YELLOW=$(_c '1;33'); RED=$(_c '0;31'); BOLD=$(_c '1'); OFF=$(_c '0')

log()  { printf '%s==>%s %s\n' "$GREEN$BOLD" "$OFF" "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%swarn:%s %s\n' "$YELLOW" "$OFF" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }

require_root() {
  [ "$(id -u)" -eq 0 ] || die "must run as root (use sudo)"
}

# gen_secret prints a random URL-safe secret.
gen_secret() { openssl rand -hex 24; }

# arch_tag maps uname -m to Go's release naming.
arch_tag() {
  case "$(uname -m)" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
}

# --------------------------------------------------------------- environment
# load_env sources the persisted env file if present (secrets survive re-runs).
load_env() {
  if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
    return 0
  fi
  return 1
}

# ensure_env_kv appends KEY=VALUE to the env file if KEY is not already present,
# then reloads it. Used by upgrade.sh to backfill config keys added in newer
# releases without disturbing existing values.
ensure_env_kv() {
  local key="$1" val="$2"
  [ -f "$ENV_FILE" ] || return 0
  if ! grep -q "^${key}=" "$ENV_FILE"; then
    echo "${key}=${val}" >> "$ENV_FILE"
    info "added ${key}"
    load_env
  fi
}

# ensure_ffmpeg installs an audio converter so uploaded IVR prompts can be
# transcoded to the 8kHz/16-bit mono PCM WAV that Asterisk can actually play.
# No-op if ffmpeg or sox is already present.
ensure_ffmpeg() {
  if command -v ffmpeg >/dev/null 2>&1 || command -v sox >/dev/null 2>&1; then
    return 0
  fi
  log "Installing ffmpeg (for IVR prompt conversion)"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg >/dev/null 2>&1 ||
    warn "could not install ffmpeg; IVR prompts will be stored without conversion"
}

# provision_sounds creates the IVR prompt directory under Asterisk's sounds tree.
# The service (APP_USER) uploads WAVs here; Asterisk (asterisk user) plays them.
# Owning it APP_USER:asterisk with setgid means uploads inherit the asterisk
# group and stay readable by the PBX. Shared by install and upgrade.
provision_sounds() {
  local dir="${TPBX_SOUNDS_DIR:-$SOUNDS_DIR}"
  log "Provisioning IVR prompt directory: $dir"
  install -d "$dir"
  chown "$APP_USER":asterisk "$dir" 2>/dev/null || chown "$APP_USER":"$APP_USER" "$dir" 2>/dev/null || true
  chmod 2775 "$dir" 2>/dev/null || true
}

# --------------------------------------------------------------------- build
# go_bin returns the path to the go binary, preferring a system Go new enough,
# otherwise the one under /usr/local/go installed by ensure_go.
go_bin() {
  if command -v go >/dev/null 2>&1 && go version | grep -qE 'go1\.(2[5-9]|[3-9][0-9])'; then
    command -v go
  else
    echo "/usr/local/go/bin/go"
  fi
}

# build_app compiles the frontend and backend from REPO_DIR. Used by BOTH
# install and upgrade so the build is defined in exactly one place.
build_app() {
  [ -n "$REPO_DIR" ] || die "REPO_DIR not set"
  local go; go="$(go_bin)"

  log "Building frontend (admin console + agent softphone + extension)"
  ( cd "$REPO_DIR/web" && npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund )
  ( cd "$REPO_DIR/web" && npm run build )
  ( cd "$REPO_DIR/web" && npm run build:agent )
  ( cd "$REPO_DIR/web" && npm run build:ext )
  package_extension

  log "Building backend ($($go version 2>/dev/null || echo "$go"))"
  local ver; ver="$(cd "$REPO_DIR" && git describe --tags --always --dirty 2>/dev/null || echo dev)"
  ( cd "$REPO_DIR" && CGO_ENABLED=0 "$go" build -trimpath \
      -ldflags "-s -w -X main.version=${ver}" -o "$REPO_DIR/bin/tpbx" ./cmd/tpbx )

  install -m 0755 "$REPO_DIR/bin/tpbx" "$BIN_PATH"
  info "installed binary -> $BIN_PATH ($ver)"

  deploy_web
}

# package_extension zips the built extension into ready-to-install archives
# (one per browser) under web/dist/downloads, so they ship with the console and
# are downloadable from the dashboard. Best-effort: skipped if zip or the build
# is missing.
package_extension() {
  local ext="${REPO_DIR}/web/dist-ext"
  [ -d "$ext" ] || return 0
  if ! command -v zip >/dev/null 2>&1; then
    warn "zip not installed; skipping extension packaging"
    return 0
  fi
  local dl="${REPO_DIR}/web/dist/downloads"
  install -d "$dl"

  # Chrome: dist-ext as-is (manifest.json is the Chrome one), minus the Firefox
  # manifest.
  ( cd "$ext" && rm -f "$dl/tpbx-softphone-chrome.zip" &&
    zip -qr -X "$dl/tpbx-softphone-chrome.zip" . -x "manifest.firefox.json" )

  # Firefox: swap in the Firefox manifest as manifest.json.
  local tmp; tmp="$(mktemp -d)"
  cp -a "$ext/." "$tmp/"
  cp "$tmp/manifest.firefox.json" "$tmp/manifest.json"
  rm -f "$tmp/manifest.firefox.json"
  ( cd "$tmp" && rm -f "$dl/tpbx-softphone-firefox.zip" &&
    zip -qr -X "$dl/tpbx-softphone-firefox.zip" . )
  rm -rf "$tmp"
  info "packaged extension -> web/dist/downloads/{chrome,firefox}.zip"
}

# deploy_web copies the built frontend into STATE_DIR, owned by the service
# user. The running service must NOT depend on the repo checkout location: the
# repo may live under /root (mode 700) or a home dir the service cannot enter,
# so assets are served from /var/lib/tpbx instead.
deploy_web() {
  install -d -o "$APP_USER" -g "$APP_USER" "$STATE_DIR"
  rm -rf "${STATE_DIR}/web"
  install -d "${STATE_DIR}/web"
  cp -a "${REPO_DIR}/web/dist" "${STATE_DIR}/web/dist"
  if [ -d "${REPO_DIR}/web/dist-agent" ]; then
    cp -a "${REPO_DIR}/web/dist-agent" "${STATE_DIR}/web/dist-agent"
  fi
  chown -R "$APP_USER":"$APP_USER" "${STATE_DIR}/web"
  info "deployed frontend -> ${STATE_DIR}/web/dist (+ /phone softphone)"
}

# run_migrations applies pending DB migrations using the installed binary and
# the persisted env. Safe to call on every deploy.
run_migrations() {
  load_env || die "missing $ENV_FILE; run install.sh first"
  log "Applying database migrations"
  env TPBX_DATABASE_URL="$TPBX_DATABASE_URL" "$BIN_PATH" migrate
}

# restart_service reloads systemd and restarts the app.
restart_service() {
  log "Restarting service"
  systemctl daemon-reload
  systemctl restart "$APP_NAME"
  sleep 1
  if systemctl is-active --quiet "$APP_NAME"; then
    info "service is active"
  else
    warn "service is not active; recent logs:"
    journalctl -u "$APP_NAME" -n 20 --no-pager || true
    die "service failed to start"
  fi
}
