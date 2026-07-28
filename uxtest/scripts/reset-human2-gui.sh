#!/usr/bin/env bash

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "$0")" && pwd -P)/_lib.sh"

round="${1:-}"
expected_profile="${2:-}"
validate_round "$round"
[ -n "$expected_profile" ] || die "reset-human2-gui requires the expected profile id"
[ -n "${UXTEST_HOME_ROOT:-}" ] ||
  die "reset-human2-gui requires UXTEST_HOME_ROOT"

config="$UXTEST_HOME_ROOT/config/cloud.env"
[ -f "$config" ] || die "Human2 cloud config is missing"
# shellcheck disable=SC1090
source "$config"
require_env SWARM_CLOUD_URL
require_env SWARM_CLOUD_ANON_KEY
require_command node
require_command "$UXTEST_SECURITY_BIN"

profile="$(profile_id)"
[ "$profile" = "$expected_profile" ] ||
  die "Human2 reset profile does not match the requested cloud target"

state="$UXTEST_HOME_ROOT/human2/reset-state/r$round.json"
profile_path="$UXTEST_HOME_ROOT/../.cswarm/credentials.d/$profile.profile.json"
node_file="$UXTEST_HOME_ROOT/product/NODE_BIN"
cli="$UXTEST_HOME_ROOT/product/dist/cli.js"
[ -f "$node_file" ] || die "Human2 copied Node path is missing"
[ -f "$cli" ] || die "Human2 copied cswarm build is missing"
node_bin="$(<"$node_file")"
[ -x "$node_bin" ] || die "Human2 copied Node binary is unavailable"

mkdir -p "$(dirname "$state")"
chmod 700 "$(dirname "$state")"

write_state() {
  local status="$1"
  local detail="${2:-}"
  node - "$state" "$round" "$profile" "$status" "$detail" <<'NODE'
const fs = require("node:fs");
const [path, roundRaw, profile, status, detail] = process.argv.slice(2);
const value = {
  round: Number(roundRaw),
  profile,
  status,
  detail: detail || null,
  updated_at: new Date().toISOString(),
};
fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
NODE
}

fail_reset() {
  write_state failed "$*"
  die "$*"
}

write_state running
set +e
logout_output="$(
  SWARM_CLOUD_URL="$SWARM_CLOUD_URL" \
    SWARM_CLOUD_ANON_KEY="$SWARM_CLOUD_ANON_KEY" \
    "$node_bin" "$cli" logout 2>&1
)"
logout_status=$?
set -e
[ "$logout_status" -eq 0 ] ||
  fail_reset "Human2 GUI-session logout failed (exit $logout_status): $logout_output"

rm -f "$profile_path"
[ ! -e "$profile_path" ] ||
  fail_reset "Human2 profile sidecar survived GUI-session reset"
if "$UXTEST_SECURITY_BIN" find-generic-password \
  -a "refresh:$profile" \
  -s com.commonswarm.cli >/dev/null 2>&1; then
  fail_reset "Human2 keychain credential survived GUI-session reset"
fi

write_state succeeded
say "Human2 GUI-session reset verified: logout, profile sidecar, and keychain are cold."
