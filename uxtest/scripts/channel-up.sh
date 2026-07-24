#!/usr/bin/env bash

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "$0")" && pwd -P)/_lib.sh"

round="${1:-1}"
validate_round "$round"
assert_setup_exists "$round"

swarm_name="$(round_swarm "$round")"
human1="$(human1_name "$round")"
human2="$(human2_name "$round")"
run_dir="$UXTEST_MINI_HOME_ROOT/run"
mkdir -p "$run_dir"
chmod 700 "$run_dir"

card_name() {
  local url="$1"
  local body
  body="$(curl -fsS --max-time 3 "$url/.well-known/agent-card.json" 2>/dev/null)" ||
    return 1
  node -e '
    const value = JSON.parse(process.argv[1]);
    process.stdout.write(String(value.name ?? ""));
  ' "$body"
}

ensure_mini_server() {
  local expected="$1"
  local pid_file="$run_dir/a2a-18791.pid"
  local log_file="$run_dir/a2a-18791.log"
  local current
  current="$(card_name "http://127.0.0.1:18791" || true)"
  if [ "$current" = "$expected" ]; then
    say "Mini A2A endpoint already serves $expected on dedicated port 18791."
    return
  fi
  if [ -n "$current" ]; then
    [ -f "$pid_file" ] ||
      die "mini port 18791 serves '$current' but is not owned by this harness"
    old_pid="$(<"$pid_file")"
    case "$old_pid" in *[!0-9]*|'') die "invalid harness PID file: $pid_file" ;; esac
    kill -0 "$old_pid" 2>/dev/null ||
      die "mini port 18791 is live but its recorded harness PID is not"
    say "Replacing the prior uxtest A2A server '$current' on port 18791."
    kill "$old_pid"
    for _ in 1 2 3 4 5; do
      kill -0 "$old_pid" 2>/dev/null || break
      sleep 1
    done
    kill -0 "$old_pid" 2>/dev/null &&
      die "prior mini uxtest A2A server did not stop"
  fi
  nohup "$UXTEST_SWARM_BIN" serve \
    --name "$expected" \
    --swarm "$swarm_name" \
    --port 18791 \
    --bind 0.0.0.0 \
    --advertise-host "$UXTEST_MINI_IP" \
    >"$log_file" 2>&1 </dev/null &
  printf '%s\n' "$!" >"$pid_file"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ "$(card_name "http://127.0.0.1:18791" || true)" = "$expected" ] &&
      return
    sleep 1
  done
  die "mini A2A server failed its agent-card postcondition; see $log_file"
}

ensure_laptop_server() {
  local expected="$1"
  local state="$UXTEST_REMOTE_HOME_ROOT/run/round-a2a-18790.json"
  local pid_file="$UXTEST_REMOTE_HOME_ROOT/run/a2a-18790.pid"
  local url="http://$UXTEST_LAPTOP_IP:18790"

  laptop_gui_server_ready() {
    [ "$(a2a_card_name "$url" || true)" = "$expected" ] || return 1
    local raw
    raw="$(remote_zsh "test -f '$state' && cat '$state'")" || return 1
    local state_pid
    state_pid="$(
      gui_server_state_pid "$raw" "$expected" "$swarm_name" 18790
    )" || return 1
    local recorded_pid
    recorded_pid="$(remote_zsh "test -f '$pid_file' && cat '$pid_file'")" ||
      return 1
    [ "$recorded_pid" = "$state_pid" ] || return 1
    remote_zsh "kill -0 '$state_pid'" >/dev/null 2>&1
  }

  if laptop_gui_server_ready; then
    say "GUI-origin laptop A2A endpoint already serves $expected on port 18790."
    return
  fi

  say "Delegating $expected A2A server startup to GUI-session launcher $UXTEST_LAUNCHER_NAME."
  launcher_send \
    "Launcher-only channel task; you are not a study persona. Run exactly: UXTEST_HOME_ROOT=$UXTEST_REMOTE_HOME_ROOT UXTEST_MINI_HOME_ROOT=$UXTEST_REMOTE_HOME_ROOT UXTEST_REMOTE_HOME_ROOT=$UXTEST_REMOTE_HOME_ROOT UXTEST_REMOTE_SWARM_BIN=$UXTEST_REMOTE_SWARM_BIN $UXTEST_REMOTE_REPO/uxtest/scripts/serve-human2-gui.sh round $round. Once it completes, stay out of the round."

  local timeout="${UXTEST_GUI_SERVE_TIMEOUT_SECONDS:-60}"
  case "$timeout" in
    ''|*[!0-9]*|0) die "UXTEST_GUI_SERVE_TIMEOUT_SECONDS must be a positive integer" ;;
  esac
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if laptop_gui_server_ready; then
      say "GUI-origin laptop A2A endpoint verified for $expected."
      return
    fi
    "$UXTEST_SLEEP_BIN" 2
    elapsed=$((elapsed + 2))
  done
  die "$expected A2A server lacks verified GUI-cmux origin after ${timeout}s; inspect $state and $UXTEST_REMOTE_HOME_ROOT/run/a2a-18790.log"
}

wait_for_agent_remote "$swarm_name" "$human2" 5 ||
  die "$human2 is not joined; run launch-human2.sh $round before channel-up"

ensure_mini_server "$human1"
ensure_laptop_server "$human2"

say "Registering each round persona as the other's A2A colleague."
"$UXTEST_SWARM_BIN" register-a2a "$human2" \
  --endpoint "http://$UXTEST_LAPTOP_IP:18790" \
  --description "Human2 on Tom's laptop, UX round $round" \
  --force \
  --swarm "$swarm_name"
remote_zsh "
  '$UXTEST_REMOTE_SWARM_BIN' register-a2a '$human1' \
    --endpoint 'http://$UXTEST_MINI_IP:18791' \
    --description 'Human1 on the mini, UX round $round' \
    --force \
    --swarm '$swarm_name'
"

[ "$(card_name "http://127.0.0.1:18791")" = "$human1" ] ||
  die "mini agent card changed during registration"
laptop_card="$(curl -fsS --max-time 3 \
  "http://$UXTEST_LAPTOP_IP:18790/.well-known/agent-card.json")"
laptop_name="$(node -e '
  const value = JSON.parse(process.argv[1]);
  process.stdout.write(String(value.name ?? ""));
' "$laptop_card")"
[ "$laptop_name" = "$human2" ] ||
  die "laptop agent card changed during registration"

say "Round $round chat channel verified: $human1 ⇄ $human2; mini port 18790 untouched."
