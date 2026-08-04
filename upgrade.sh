#!/usr/bin/env bash
#
# upgrade.sh -- upgrade an existing TPBX install in place.
#
#   Usage:  git pull && sudo ./upgrade.sh
#           sudo ./upgrade.sh --no-pull      # if you already pulled/deployed
#
# Steps: pull latest source -> rebuild backend + frontend -> apply new database
# migrations -> restart the service. It is safe to re-run and it does NOT touch
# generated secrets or GUI-managed Asterisk config (transports, certs). If new
# Asterisk config templates ship, re-run install.sh to sync them.

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export REPO_DIR
# shellcheck source=scripts/lib.sh
. "${REPO_DIR}/scripts/lib.sh"

PULL=yes
[ "${1:-}" = "--no-pull" ] && PULL=no

pull_latest() {
  [ "$PULL" = yes ] || { info "skipping git pull (--no-pull)"; return; }
  [ -d "${REPO_DIR}/.git" ] || { warn "not a git checkout; skipping pull"; return; }
  log "Pulling latest source"
  local before after
  before="$(git -C "$REPO_DIR" rev-parse HEAD)"
  # Fast-forward only: never silently create merge commits on the server.
  git -C "$REPO_DIR" pull --ff-only
  after="$(git -C "$REPO_DIR" rev-parse HEAD)"
  if [ "$before" = "$after" ]; then
    info "already at latest ($after)"
  else
    info "updated ${before:0:8} -> ${after:0:8}"
  fi
}

main() {
  require_root
  [ -f "$ENV_FILE" ] || die "no existing install found ($ENV_FILE missing); run ./install.sh first"
  load_env

  pull_latest
  build_app       # shared with install.sh -- one definition of "build"
  run_migrations  # applies only migrations not yet recorded
  restart_service

  log "Upgrade complete"
  info "version: $($BIN_PATH version 2>/dev/null || echo unknown)"
  info "logs:    journalctl -u ${APP_NAME} -f"
}

main "$@"
