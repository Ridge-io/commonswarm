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
  local current
  current="$(curl -fsS --max-time 3 \
    "http://$UXTEST_LAPTOP_IP:18790/.well-known/agent-card.json" 2>/dev/null |
    node -e '
      let raw = "";
      process.stdin.on("data", chunk => raw += chunk);
      process.stdin.on("end", () => {
        if (!raw) return;
        const value = JSON.parse(raw);
        process.stdout.write(String(value.name ?? ""));
      });
    ' || true)"
  if [ "$current" = "$expected" ]; then
    say "Laptop A2A endpoint already serves $expected on port 18790."
    return
  fi
  if [ -n "$current" ]; then
    say "Replacing the prior laptop uxtest A2A server '$current' on port 18790."
  fi
  remote_zsh "
    set -e
    run='$UXTEST_REMOTE_HOME_ROOT/run'
    mkdir -p \"\$run\"
    chmod 700 \"\$run\"
    pid_file=\"\$run/a2a-18790.pid\"
    if curl -fsS --max-time 2 http://127.0.0.1:18790/.well-known/agent-card.json >/dev/null 2>&1; then
      test -f \"\$pid_file\" || {
        echo 'port 18790 is occupied by a non-harness process' >&2
        exit 42
      }
      old_pid=\$(cat \"\$pid_file\")
      case \"\$old_pid\" in *[!0-9]*|'') exit 43 ;; esac
      kill -0 \"\$old_pid\"
      kill \"\$old_pid\"
      for i in 1 2 3 4 5; do
        kill -0 \"\$old_pid\" 2>/dev/null || break
        sleep 1
      done
      ! kill -0 \"\$old_pid\" 2>/dev/null
    fi
    nohup '$UXTEST_REMOTE_SWARM_BIN' serve \
      --name '$expected' \
      --swarm '$swarm_name' \
      --port 18790 \
      --bind 0.0.0.0 \
      --advertise-host '$UXTEST_LAPTOP_IP' \
      >\"\$run/a2a-18790.log\" 2>&1 </dev/null &
    echo \$! >\"\$pid_file\"
  "
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    current="$(curl -fsS --max-time 3 \
      "http://$UXTEST_LAPTOP_IP:18790/.well-known/agent-card.json" 2>/dev/null |
      node -e '
        let raw = "";
        process.stdin.on("data", chunk => raw += chunk);
        process.stdin.on("end", () => {
          if (!raw) return;
          const value = JSON.parse(raw);
          process.stdout.write(String(value.name ?? ""));
        });
      ' || true)"
    [ "$current" = "$expected" ] && return
    sleep 1
  done
  die "laptop A2A server failed its agent-card postcondition"
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
