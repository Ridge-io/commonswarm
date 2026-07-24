#!/usr/bin/env bash

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "$0")" && pwd -P)/_lib.sh"

round="${1:-}"
role="${2:-}"
validate_round "$round"

case "$role" in
  human1)
    name="$(human1_name "$round")"
    ;;
  human2)
    name="$(human2_name "$round")"
    ;;
  *)
    die "spawn-observed role must be human1 or human2"
    ;;
esac

swarm_name="$(round_swarm "$round")"
cwd="$(persona_workspace "$role")"
state="$(persona_spawn_state_path "$role" "$round")"
timeout="${UXTEST_JOIN_TIMEOUT_SECONDS:-30}"
attempt_limit="${UXTEST_JOIN_ATTEMPTS:-3}"
poll="${UXTEST_JOIN_POLL_SECONDS:-2}"

for value in "$timeout" "$attempt_limit" "$poll"; do
  case "$value" in
    ''|*[!0-9]*|0) die "join timeout, attempts, and poll values must be positive integers" ;;
  esac
done

assert_round_brief_only "$cwd" "$role" "$round"
require_command "$UXTEST_CMUX_BIN"
mkdir -p "$(dirname "$state")"
chmod 700 "$(dirname "$state")"

started_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
spawn_requested_at="$(
  node -e 'process.stdout.write(new Date(Number(process.argv[1])).toISOString())' \
    "$started_ms"
)"

set +e
spawn_output="$(
  PATH="${UXTEST_HOME_ROOT:-$UXTEST_MINI_HOME_ROOT}/bin:$PATH" \
    UXTEST_HOME_ROOT="${UXTEST_HOME_ROOT:-$UXTEST_MINI_HOME_ROOT}" \
    UXTEST_ROLE="$role" \
    UXTEST_ROUND="$round" \
    "$UXTEST_SWARM_BIN" spawn \
      --agent claude \
      --name "$name" \
      --cwd "$cwd" \
      --swarm "$swarm_name" \
      --terminal cmux 2>&1
)"
spawn_status=$?
set -e

surface="$(
  printf '%s\n' "$spawn_output" |
    sed -n 's/.*\(surface:[A-Za-z0-9._-][A-Za-z0-9._-]*\).*/\1/p' |
    tail -n 1
)"
workspace="$(
  printf '%s\n' "$spawn_output" |
    sed -n 's/.*\(workspace:[A-Za-z0-9._-][A-Za-z0-9._-]*\).*/\1/p' |
    tail -n 1
)"

write_state() {
  local observed="$1"
  local attempts="$2"
  local joined_ms="${3:-}"
  local error="${4:-}"
  node - "$state" "$role" "$round" "$name" "$swarm_name" "$cwd" \
    "$surface" "$workspace" "$spawn_requested_at" "$started_ms" \
    "$observed" "$attempts" "$joined_ms" "$error" <<'NODE'
const fs = require("node:fs");
const [
  path, role, round, name, swarm, cwd, surface, workspace,
  requestedAt, startedRaw, observedRaw, attemptsRaw, joinedRaw, error,
] = process.argv.slice(2);
const started = Number(startedRaw);
const joined = joinedRaw ? Number(joinedRaw) : null;
const value = {
  role,
  round: Number(round),
  name,
  swarm,
  cwd,
  surface: surface || null,
  workspace: workspace || null,
  spawn_requested_at: requestedAt,
  joined_at: joined === null ? null : new Date(joined).toISOString(),
  join_latency_ms: joined === null ? null : Math.max(0, joined - started),
  join_attempts: Number(attemptsRaw),
  observed: observedRaw === "true",
  error: error || null,
};
fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
NODE
}

if [ "$spawn_status" -ne 0 ]; then
  write_state false 1 "" "swarm spawn exited $spawn_status"
  printf '%s\n' "$spawn_output" >&2
  die "$name spawn command failed"
fi
attempt=1
while true; do
  if wait_for_agent_local "$swarm_name" "$name" "$timeout" "$poll"; then
    joined_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
    write_state true "$attempt" "$joined_ms"
    say "$name registration observed after attempt $attempt."
    exit 0
  fi
  if [ "$attempt" -ge "$attempt_limit" ]; then
    write_state false "$attempt" "" "membership was not observed after bounded join attempts"
    die "$name did not register in $swarm_name after $attempt attempts"
  fi
  if [ -z "$surface" ]; then
    write_state false "$attempt" "" "spawn output did not identify a cmux surface"
    printf '%s\n' "$spawn_output" >&2
    die "$name was not observed and spawn returned no cmux surface; registration cannot be retried safely"
  fi
  attempt=$((attempt + 1))
  say "$name was not observed; re-sending /join-swarm to $surface (attempt $attempt/$attempt_limit)."
  cmux_args=()
  [ -z "$workspace" ] || cmux_args+=(--workspace "$workspace")
  "$UXTEST_CMUX_BIN" send "${cmux_args[@]}" --surface "$surface" \
    "/join-swarm $name --swarm $swarm_name"
  "$UXTEST_CMUX_BIN" send-key "${cmux_args[@]}" --surface "$surface" Enter
done
