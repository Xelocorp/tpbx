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
  provision_softphone
  provision_softphone_apk

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

# provision_softphone places the Windows softphone installer where the console
# serves downloads (web/dist/downloads), so the dashboard "Softphone for Windows"
# button works. The .exe is built by the build-softphone GitHub Actions job (on
# Windows), not here; this wires an already-produced installer in, trying, in
# order:
#   1. TPBX_SOFTPHONE_EXE       -- copy the installer from this local path;
#   2. TPBX_SOFTPHONE_EXE_URL   -- download the installer from this URL;
#   3. TPBX_GITHUB_TOKEN        -- fetch the release asset from GitHub (the CI
#        job publishes a rolling "softphone-latest" release). Repo defaults to
#        Xelocorp/tpbx (TPBX_GITHUB_REPO) and tag to softphone-latest
#        (TPBX_SOFTPHONE_RELEASE_TAG). A read-only token is enough;
#   4. a local build at desktop/release/xelovoice-softphone-setup.exe.
# Best-effort and non-fatal: if none is available the button shows a
# "not published" state instead of 404ing.
provision_softphone() {
  local dl="${REPO_DIR}/web/dist/downloads"
  local dest="${dl}/xelovoice-softphone-setup.exe"
  install -d "$dl"

  if [ -n "${TPBX_SOFTPHONE_EXE:-}" ] && [ -f "$TPBX_SOFTPHONE_EXE" ]; then
    cp -f "$TPBX_SOFTPHONE_EXE" "$dest"
    info "provisioned softphone installer from local path -> web/dist/downloads"
    return 0
  fi
  if [ -n "${TPBX_SOFTPHONE_EXE_URL:-}" ]; then
    if command -v curl >/dev/null 2>&1 && curl -fsSL "$TPBX_SOFTPHONE_EXE_URL" -o "$dest"; then
      info "provisioned softphone installer from URL -> web/dist/downloads"
    else
      warn "could not download softphone installer from TPBX_SOFTPHONE_EXE_URL"
    fi
    return 0
  fi
  if [ -n "${TPBX_GITHUB_TOKEN:-}" ] && command -v curl >/dev/null 2>&1; then
    provision_release_asset "$dest" "xelovoice-softphone-setup.exe" && return 0
  fi
  if [ -f "${REPO_DIR}/desktop/release/xelovoice-softphone-setup.exe" ]; then
    cp -f "${REPO_DIR}/desktop/release/xelovoice-softphone-setup.exe" "$dest"
    info "provisioned softphone installer from local build -> web/dist/downloads"
    return 0
  fi
  info "no softphone installer to provision (button shows 'not published')"
}

# provision_softphone_apk mirrors provision_softphone for the Android build:
#   - TPBX_SOFTPHONE_APK       -- copy the .apk from this local path;
#   - TPBX_SOFTPHONE_APK_URL   -- download the .apk from this URL;
#   - TPBX_GITHUB_TOKEN        -- fetch the apk asset from the softphone-latest
#                                 release (same token/repo/tag as the installer);
#   - a local android/app/build/outputs/apk/release/*.apk.
provision_softphone_apk() {
  local dl="${REPO_DIR}/web/dist/downloads"
  local dest="${dl}/xelovoice-softphone.apk"
  install -d "$dl"

  if [ -n "${TPBX_SOFTPHONE_APK:-}" ] && [ -f "$TPBX_SOFTPHONE_APK" ]; then
    cp -f "$TPBX_SOFTPHONE_APK" "$dest"
    info "provisioned softphone apk from local path -> web/dist/downloads"
    return 0
  fi
  if [ -n "${TPBX_SOFTPHONE_APK_URL:-}" ]; then
    if command -v curl >/dev/null 2>&1 && curl -fsSL "$TPBX_SOFTPHONE_APK_URL" -o "$dest"; then
      info "provisioned softphone apk from URL -> web/dist/downloads"
    else
      warn "could not download softphone apk from TPBX_SOFTPHONE_APK_URL"
    fi
    return 0
  fi
  if [ -n "${TPBX_GITHUB_TOKEN:-}" ] && command -v curl >/dev/null 2>&1; then
    provision_release_asset "$dest" "xelovoice-softphone.apk" && return 0
  fi
  local built
  built="$(ls "${REPO_DIR}"/android/app/build/outputs/apk/release/*.apk 2>/dev/null | head -1 || true)"
  if [ -n "$built" ] && [ -f "$built" ]; then
    cp -f "$built" "$dest"
    info "provisioned softphone apk from local build -> web/dist/downloads"
    return 0
  fi
  info "no softphone apk to provision (button shows 'not published')"
}

# provision_release_asset downloads a named asset from a GitHub Release using
# TPBX_GITHUB_TOKEN, streaming it via the assets API (works for private repos).
# It reads the release by tag (default softphone-latest, which the CI keeps
# pointed at the newest build) and matches the asset by filename. jq-free: it
# walks the ordered stream of asset "url"/"name" tokens (each asset object lists
# its url before its name), so the right asset is picked even with several.
#   $1 = destination path, $2 = asset filename to fetch.
provision_release_asset() {
  local dest="$1" want="$2"
  local repo="${TPBX_GITHUB_REPO:-Xelocorp/tpbx}"
  local tag="${TPBX_SOFTPHONE_RELEASE_TAG:-softphone-latest}"
  local api="https://api.github.com/repos/${repo}/releases/tags/${tag}"

  local json asset_url
  json="$(curl -fsSL \
    -H "Authorization: Bearer ${TPBX_GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$api" 2>/dev/null)" || { warn "softphone: release '${tag}' not found in ${repo}"; return 1; }

  asset_url="$(printf '%s' "$json" \
    | grep -oE '"url": *"[^"]*/releases/assets/[0-9]+"|"name": *"[^"]*"' \
    | sed -E 's/"url": *"([^"]*)"/URL \1/; s/"name": *"([^"]*)"/NAME \1/' \
    | awk -v want="$want" '$1=="URL"{u=$2} $1=="NAME" && $2==want {print u; exit}')"
  if [ -z "$asset_url" ]; then
    warn "softphone: no asset '${want}' on release '${tag}'"
    return 1
  fi

  if curl -fSL \
      -H "Authorization: Bearer ${TPBX_GITHUB_TOKEN}" \
      -H "Accept: application/octet-stream" \
      "$asset_url" -o "$dest"; then
    info "provisioned ${want} from release '${tag}' -> web/dist/downloads"
    return 0
  fi
  warn "softphone: failed to download '${want}' from release '${tag}'"
  return 1
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
