#!/usr/bin/env bash

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "$0")" && pwd -P)/_lib.sh"

require_command curl
require_command node

local_run_dir="$UXTEST_MINI_HOME_ROOT/run"
local_pid_file="$local_run_dir/launcher-a2a-$UXTEST_LAUNCHER_MINI_PORT.pid"
local_log_file="$local_run_dir/launcher-a2a-$UXTEST_LAUNCHER_MINI_PORT.log"
local_url="http://$UXTEST_MINI_IP:$UXTEST_LAUNCHER_MINI_PORT"
laptop_url="http://$UXTEST_LAPTOP_IP:$UXTEST_LAUNCHER_LAPTOP_PORT"

mkdir -p "$local_run_dir"
chmod 700 "$local_run_dir"

ensure_local_driver_server() {
  local current
  current="$(a2a_card_name "$local_url" || true)"
  if [ "$current" = "$UXTEST_DRIVER_NAME" ]; then
    say "Mini launcher-control endpoint already serves $UXTEST_DRIVER_NAME."
    return
  fi
  if [ -n "$current" ]; then
    [ -f "$local_pid_file" ] ||
      die "mini launcher port serves '$current' but is not owned by this harness"
    local old_pid
    old_pid="$(<"$local_pid_file")"
    case "$old_pid" in *[!0-9]*|'') die "invalid launcher PID file" ;; esac
    kill -0 "$old_pid" 2>/dev/null ||
      die "mini launcher port is live but its recorded PID is not"
    kill "$old_pid"
    for _ in 1 2 3 4 5; do
      kill -0 "$old_pid" 2>/dev/null || break
      sleep 1
    done
    kill -0 "$old_pid" 2>/dev/null &&
      die "prior mini launcher A2A server did not stop"
  fi
  nohup "$UXTEST_SWARM_BIN" serve \
    --name "$UXTEST_DRIVER_NAME" \
    --swarm "$UXTEST_LAUNCHER_SWARM" \
    --port "$UXTEST_LAUNCHER_MINI_PORT" \
    --bind "$UXTEST_MINI_IP" \
    --advertise-host "$UXTEST_MINI_IP" \
    --description "UX harness driver; launcher control only" \
    >"$local_log_file" 2>&1 </dev/null &
  printf '%s\n' "$!" >"$local_pid_file"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ "$(a2a_card_name "$local_url" || true)" = "$UXTEST_DRIVER_NAME" ] &&
      return
    sleep 1
  done
  die "mini launcher-control A2A server failed; see $local_log_file"
}

base_members="$(remote_zsh \
  "$UXTEST_REMOTE_SWARM_BIN members --swarm '$UXTEST_LAUNCHER_SWARM'")"
printf '%s\n' "$base_members" | grep -Fq "$UXTEST_LAUNCHER_NAME [" ||
  die "persistent laptop GUI launcher $UXTEST_LAUNCHER_NAME is absent"

assert_gui_launcher_server
ensure_local_driver_server

say "Registering the dedicated two-way launcher control bridge."
"$UXTEST_SWARM_BIN" register-a2a "$UXTEST_DRIVER_NAME" \
  --endpoint "$local_url" \
  --description "Local UX harness driver identity" \
  --force \
  --swarm "$UXTEST_LAUNCHER_SWARM" >/dev/null
"$UXTEST_SWARM_BIN" register-a2a "$UXTEST_LAUNCHER_NAME" \
  --endpoint "$laptop_url" \
  --description "Persistent laptop GUI-session launcher" \
  --force \
  --swarm "$UXTEST_LAUNCHER_SWARM" >/dev/null
remote_zsh "
  '$UXTEST_REMOTE_SWARM_BIN' register-a2a '$UXTEST_DRIVER_NAME' \
    --endpoint '$local_url' \
    --description 'Mini UX harness driver; launcher control only' \
    --force \
    --swarm '$UXTEST_LAUNCHER_SWARM' >/dev/null
"

assert_launcher_channel
remote_driver="$(
  remote_zsh "$UXTEST_REMOTE_SWARM_BIN members --swarm '$UXTEST_LAUNCHER_SWARM'"
)" || die "laptop did not retain the A2A launcher-driver registration"
printf '%s\n' "$remote_driver" | grep -Fq "$UXTEST_DRIVER_NAME [a2a]" ||
  die "laptop launcher-driver A2A registration is absent"
say "Launcher channel verified: $UXTEST_DRIVER_NAME ⇄ $UXTEST_LAUNCHER_NAME; round persona bridges remain separate."
