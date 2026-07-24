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

assert_launcher_channel() {
  local laptop_url="http://$UXTEST_LAPTOP_IP:$UXTEST_LAUNCHER_LAPTOP_PORT"
  local mini_url="http://$UXTEST_MINI_IP:$UXTEST_LAUNCHER_MINI_PORT"
  [ "$(a2a_card_name "$laptop_url" || true)" = "$UXTEST_LAUNCHER_NAME" ] ||
    die "GUI launcher A2A endpoint is absent; run launcher-channel-up.sh before reset"
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
  local banned='(invite|accept|login|principal|swm_|--link|workspace-id|opaque item)'
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
