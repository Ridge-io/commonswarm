#!/usr/bin/env bash

set -euo pipefail

UXTEST_SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
UXTEST_DIR="$(cd "$UXTEST_SCRIPTS_DIR/.." && pwd -P)"
UXTEST_REPO="$(cd "$UXTEST_DIR/.." && pwd -P)"
UXTEST_REMOTE="${UXTEST_REMOTE:-tom@100.95.177.37}"
UXTEST_MINI_IP="${UXTEST_MINI_IP:-100.127.131.115}"
UXTEST_LAPTOP_IP="${UXTEST_LAPTOP_IP:-100.95.177.37}"
UXTEST_SWARM_BIN="${UXTEST_SWARM_BIN:-/Users/yulanbot/Developer/Ridge.io/swarm/bin/swarm}"
UXTEST_REMOTE_SWARM_BIN="${UXTEST_REMOTE_SWARM_BIN:-/opt/homebrew/bin/swarm}"
UXTEST_CMUX_BIN="${UXTEST_CMUX_BIN:-cmux}"
UXTEST_SECURITY_BIN="${UXTEST_SECURITY_BIN:-security}"
UXTEST_REMOTE_REPO="${UXTEST_REMOTE_REPO:-/Users/tom/Developer/Ridge.io/cloud-swarm}"
UXTEST_MINI_HOME_ROOT="${UXTEST_MINI_HOME_ROOT:-$HOME/uxtest}"
UXTEST_REMOTE_HOME_ROOT="${UXTEST_REMOTE_HOME_ROOT:-/Users/tom/uxtest}"
UXTEST_SLEEP_BIN="${UXTEST_SLEEP_BIN:-sleep}"
UXTEST_LAUNCHER_SWARM="${UXTEST_LAUNCHER_SWARM:-uxtest}"
UXTEST_LAUNCHER_NAME="${UXTEST_LAUNCHER_NAME:-Dana}"
UXTEST_DRIVER_NAME="${UXTEST_DRIVER_NAME:-UxDriver}"
UXTEST_LAUNCHER_LAPTOP_PORT="${UXTEST_LAUNCHER_LAPTOP_PORT:-18791}"
UXTEST_LAUNCHER_MINI_PORT="${UXTEST_LAUNCHER_MINI_PORT:-18792}"
# seeded  — reset-round.sh provisions Human1's project through the privileged
#           seed-fixture bridge. The only mode that completes end to end today.
# self-serve — nothing is provisioned; Human1 creates the project with the CLI,
#           so the round measures the actual front door. Gated server-side.
UXTEST_SETUP_MODE="${UXTEST_SETUP_MODE:-seeded}"

say() {
  printf '[uxtest] %s\n' "$*"
}

die() {
  printf '[uxtest] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"
}

require_env() {
  local name="$1"
  [ -n "${!name:-}" ] || die "required environment variable is unset: $name"
}

validate_round() {
  local round="${1:-}"
  case "$round" in
    ''|*[!0-9]*|0) die "round must be a positive integer" ;;
  esac
}

round_swarm() {
  printf 'uxtest-r%s' "$1"
}

validate_setup_mode() {
  case "${1:-}" in
    seeded|self-serve) ;;
    *) die "setup mode must be 'seeded' or 'self-serve', not '${1:-}'" ;;
  esac
}

# The round's own setup.json is the authority for which mode it ran in; the env
# var only decides a round that has not been reset yet. Reading the export after
# the fact would report the shell's intent, not the round that happened.
round_setup_mode() {
  local round="$1"
  local setup
  setup="$(round_setup_path "$round")"
  if [ -f "$setup" ]; then
    local recorded
    recorded="$(json_field "$setup" setup_mode 2>/dev/null || true)"
    # setup.json written before this field existed can only have been seeded:
    # nothing else was implemented then.
    printf '%s' "${recorded:-seeded}"
    return 0
  fi
  printf '%s' "$UXTEST_SETUP_MODE"
}

human1_name() {
  printf 'Avery-r%s' "$1"
}

human2_name() {
  printf 'Dana-r%s' "$1"
}

round_output_dir() {
  printf '%s/rounds/%s' "$UXTEST_DIR" "$1"
}

round_setup_path() {
  printf '%s/setup.json' "$(round_output_dir "$1")"
}

persona_workspace() {
  local role="$1"
  case "$role" in
    human1) printf '%s/human1/workspace' "$UXTEST_MINI_HOME_ROOT" ;;
    human2) printf '%s/human2/workspace' "$UXTEST_REMOTE_HOME_ROOT" ;;
    *) die "unknown persona role: $role" ;;
  esac
}

persona_spawn_state_path() {
  local role="$1"
  local round="$2"
  case "$role" in
    human1) printf '%s/human1/spawn-state/r%s.json' "$UXTEST_MINI_HOME_ROOT" "$round" ;;
    human2) printf '%s/human2/spawn-state/r%s.json' "$UXTEST_REMOTE_HOME_ROOT" "$round" ;;
    *) die "unknown persona role: $role" ;;
  esac
}

assert_workspace_sweep() {
  local path="$1"
  local label="$2"
  mkdir -p "$path"
  local unexpected
  unexpected="$(
    find "$path" -mindepth 1 -maxdepth 1 ! -name BRIEF.md -print -quit
  )"
  [ -z "$unexpected" ] ||
    die "$label trusted workspace contains prior-round or stray data: $unexpected; collect the prior round before launching another"
  if [ -L "$path/BRIEF.md" ] ||
    { [ -e "$path/BRIEF.md" ] && [ ! -f "$path/BRIEF.md" ]; }; then
    die "$label trusted workspace BRIEF.md is not a regular file"
  fi
}

assert_round_brief_only() {
  local path="$1"
  local label="$2"
  local round="$3"
  assert_workspace_sweep "$path" "$label"
  [ -f "$path/BRIEF.md" ] ||
    die "$label trusted workspace is missing BRIEF.md"
  local entry_count
  entry_count="$(find "$path" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')"
  [ "$entry_count" = "1" ] ||
    die "$label trusted workspace is not isolated to BRIEF.md"
  [ "$(sed -n '1p' "$path/BRIEF.md")" = "# Round $round brief" ] ||
    die "$label trusted workspace contains a BRIEF.md for the wrong round"
}

load_cloud_env() {
  if [ -f "$UXTEST_REPO/.env.cloud" ]; then
    # shellcheck disable=SC1091
    source "$UXTEST_REPO/.env.cloud"
  fi
  require_env SWARM_CLOUD_URL
  require_env SWARM_CLOUD_ANON_KEY
}

remote_zsh() {
  local command="$1"
  local quoted
  printf -v quoted '%q' "$command"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$UXTEST_REMOTE" "zsh -lic $quoted"
}

a2a_card_name() {
  local base_url="$1"
  local body
  body="$(curl -fsS --max-time 3 \
    "$base_url/.well-known/agent-card.json" 2>/dev/null)" ||
    return 1
  node -e '
    const value = JSON.parse(process.argv[1]);
    process.stdout.write(String(value.name ?? ""));
  ' "$body"
}

gui_server_state_pid() {
  local raw="$1"
  local expected_name="$2"
  local expected_swarm="$3"
  local expected_port="$4"
  node -e '
    const value = JSON.parse(process.argv[1]);
    if (
      value.origin !== "gui-cmux" ||
      value.name !== process.argv[2] ||
      value.swarm !== process.argv[3] ||
      value.bind !== process.argv[4] ||
      value.port !== Number(process.argv[5]) ||
      typeof value.surface_id !== "string" ||
      value.surface_id.length === 0 ||
      !Number.isInteger(value.pid) ||
      value.pid < 1
    ) process.exit(1);
    process.stdout.write(String(value.pid));
  ' "$raw" "$expected_name" "$expected_swarm" \
    "$UXTEST_LAPTOP_IP" "$expected_port"
}

assert_gui_launcher_server() {
  local laptop_url="http://$UXTEST_LAPTOP_IP:$UXTEST_LAUNCHER_LAPTOP_PORT"
  local state="$UXTEST_REMOTE_HOME_ROOT/run/launcher-a2a-$UXTEST_LAUNCHER_LAPTOP_PORT.json"
  local pid_file="$UXTEST_REMOTE_HOME_ROOT/run/launcher-a2a-$UXTEST_LAUNCHER_LAPTOP_PORT.pid"
  local remedy="On the laptop, inside Dana's GUI cmux session, run exactly: UXTEST_HOME_ROOT=$UXTEST_REMOTE_HOME_ROOT $UXTEST_REMOTE_REPO/uxtest/scripts/serve-human2-gui.sh launcher"
  [ "$(a2a_card_name "$laptop_url" || true)" = "$UXTEST_LAUNCHER_NAME" ] ||
    die "GUI-origin Dana launcher endpoint is absent. An SSH-started server cannot push through the cmux socket. $remedy"
  local raw
  raw="$(remote_zsh "test -f '$state' && cat '$state'")" ||
    die "Dana's endpoint lacks GUI-origin evidence. An SSH-started server may accept and queue A2A but cannot push through cmux. $remedy"
  local state_pid
  state_pid="$(
    gui_server_state_pid "$raw" "$UXTEST_LAUNCHER_NAME" \
      "$UXTEST_LAUNCHER_SWARM" "$UXTEST_LAUNCHER_LAPTOP_PORT"
  )" || die "Dana's launcher state is not valid GUI-cmux evidence. $remedy"
  local recorded_pid
  recorded_pid="$(remote_zsh "test -f '$pid_file' && cat '$pid_file'")" ||
    die "Dana's launcher PID evidence is missing. $remedy"
  [ "$recorded_pid" = "$state_pid" ] ||
    die "Dana's launcher PID does not match its GUI-origin evidence. $remedy"
  remote_zsh "kill -0 '$state_pid'" 2>/dev/null ||
    die "Dana's GUI-origin launcher process is not alive. $remedy"
}

assert_launcher_channel() {
  local mini_url="http://$UXTEST_MINI_IP:$UXTEST_LAUNCHER_MINI_PORT"
  assert_gui_launcher_server
  [ "$(a2a_card_name "$mini_url" || true)" = "$UXTEST_DRIVER_NAME" ] ||
    die "mini launcher-driver A2A endpoint is absent; run launcher-channel-up.sh before reset"
  local identity
  identity="$(
    SWARM_AGENT_NAME="$UXTEST_DRIVER_NAME" \
      SWARM_NAME="$UXTEST_LAUNCHER_SWARM" \
      "$UXTEST_SWARM_BIN" whoami --swarm "$UXTEST_LAUNCHER_SWARM" 2>/dev/null
  )" || die "launcher-driver identity is not registered locally; run launcher-channel-up.sh"
  printf '%s\n' "$identity" | grep -Fq "Name: $UXTEST_DRIVER_NAME" ||
    die "launcher-driver identity resolved to the wrong agent"
  printf '%s\n' "$identity" | grep -Fq "Type: a2a" ||
    die "launcher-driver identity is not A2A-backed"
}

launcher_send() {
  local message="$1"
  assert_launcher_channel
  SWARM_AGENT_NAME="$UXTEST_DRIVER_NAME" \
    SWARM_NAME="$UXTEST_LAUNCHER_SWARM" \
    "$UXTEST_SWARM_BIN" send \
      --swarm "$UXTEST_LAUNCHER_SWARM" \
      "$UXTEST_LAUNCHER_NAME" \
      "$message"
}

bundle_sha() {
  local dist_dir="$1"
  (
    cd "$dist_dir"
    find . -type f -print0 |
      LC_ALL=C sort -z |
      xargs -0 shasum -a 256 |
      shasum -a 256 |
      awk '{print $1}'
  )
}

profile_id() {
  printf '%s' "$SWARM_CLOUD_URL" | shasum -a 256 | awk '{print substr($1,1,24)}'
}

json_field() {
  local path="$1"
  local field="$2"
  node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const parts = process.argv[2].split(".");
    let cursor = value;
    for (const part of parts) cursor = cursor?.[part];
    if (cursor === undefined || cursor === null) process.exit(2);
    process.stdout.write(String(cursor));
  ' "$path" "$field"
}

assert_setup_exists() {
  local path
  path="$(round_setup_path "$1")"
  [ -f "$path" ] || die "round $1 has not been reset; run reset-round.sh $1 first"
}

lint_brief() {
  local path="$1"
  # \bnew\b|\bcreate\b|\binit\b close the self-serve hole: a brief that has to say
  # the project is absent is one careless verb away from saying how to make one.
  # Word-bounded so "renewal" and "creative" do not fire; both briefs are clean of
  # all three today, so a hit means someone just wrote the mechanism in.
  local banned='(invite|accept|login|principal|swm_|--link|workspace-id|opaque item|\bnew\b|\bcreate\b|\binit\b)'
  if LC_ALL=C grep -Eiq "$banned" "$path"; then
    die "rendered BRIEF.md violates the §7.9 leakage lint"
  fi
}

audit_brief() {
  local round="$1"
  local role="$2"
  local source="$3"
  local destination="$(round_output_dir "$round")/briefs"
  mkdir -p "$destination"
  install -m 600 "$source" "$destination/$role-BRIEF.md"
}

wait_for_agent_local() {
  local swarm="$1"
  local name="$2"
  local timeout="${3:-45}"
  local poll="${4:-2}"
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if "$UXTEST_SWARM_BIN" members --swarm "$swarm" 2>/dev/null |
      grep -Fq "$name ["; then
      return 0
    fi
    "$UXTEST_SLEEP_BIN" "$poll"
    elapsed=$((elapsed + poll))
  done
  return 1
}

wait_for_agent_remote() {
  local swarm="$1"
  local name="$2"
  local timeout="${3:-90}"
  local poll="${4:-2}"
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if remote_zsh "$UXTEST_REMOTE_SWARM_BIN members --swarm '$swarm'" 2>/dev/null |
      grep -Fq "$name ["; then
      return 0
    fi
    "$UXTEST_SLEEP_BIN" "$poll"
    elapsed=$((elapsed + poll))
  done
  return 1
}
