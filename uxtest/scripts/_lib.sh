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
UXTEST_REMOTE_REPO="${UXTEST_REMOTE_REPO:-/Users/tom/Developer/Ridge.io/cloud-swarm}"
UXTEST_MINI_HOME_ROOT="${UXTEST_MINI_HOME_ROOT:-$HOME/uxtest}"
UXTEST_REMOTE_HOME_ROOT="${UXTEST_REMOTE_HOME_ROOT:-/Users/tom/uxtest}"

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
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if "$UXTEST_SWARM_BIN" members --swarm "$swarm" 2>/dev/null |
      grep -Fq "$name ["; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}

wait_for_agent_remote() {
  local swarm="$1"
  local name="$2"
  local timeout="${3:-90}"
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if remote_zsh "$UXTEST_REMOTE_SWARM_BIN members --swarm '$swarm'" 2>/dev/null |
      grep -Fq "$name ["; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}
