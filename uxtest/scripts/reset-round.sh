#!/usr/bin/env bash

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "$0")" && pwd -P)/_lib.sh"

round="${1:-}"
validate_round "$round"
load_cloud_env
require_env DATABASE_URL
require_env UXTEST_HUMAN1_UID
require_env UXTEST_OAUTH_CONSENT
require_command uuidgen
require_command git

case "$UXTEST_OAUTH_CONSENT" in
  first|returning) ;;
  *) die "UXTEST_OAUTH_CONSENT must be first or returning" ;;
esac

output_dir="$(round_output_dir "$round")"
setup="$(round_setup_path "$round")"
swarm_name="$(round_swarm "$round")"
mkdir -p "$output_dir"

if [ -f "$output_dir/transcript.md" ] || [ -f "$output_dir/REPORT.md" ]; then
  die "round $round already has collected artifacts; use a new round number"
fi

if [ -f "$setup" ]; then
  workspace_id="$(json_field "$setup" workspace_id)"
  workspace_name="$(json_field "$setup" workspace_name)"
  say "Reusing round $round's existing additive workspace identity."
else
  workspace_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
  short_random="$(uuidgen | tr '[:upper:]' '[:lower:]' | cut -c1-8)"
  workspace_name="uxtest-r${round}-${short_random}"
fi

seed_sha="$(git -C "$UXTEST_REPO" hash-object src/cloud/seed.ts)"
coswarm_sha="$(<"$UXTEST_MINI_HOME_ROOT/product/SOURCE_SHA")"
laptop_coswarm_sha="$(
  remote_zsh "cat '$UXTEST_REMOTE_HOME_ROOT/product/SOURCE_SHA'"
)"
[ "$coswarm_sha" = "$laptop_coswarm_sha" ] ||
  die "FAIL CLOSED: mini/laptop copied coswarm hashes differ before reset"

node - "$setup" "$round" "$swarm_name" "$workspace_id" "$workspace_name" \
  "$seed_sha" "$coswarm_sha" "$laptop_coswarm_sha" \
  "$UXTEST_OAUTH_CONSENT" <<'NODE'
const fs = require("node:fs");
const [
  path, round, swarmName, workspaceId, workspaceName, seedSha, coswarmSha,
  laptopCoswarmSha, oauthConsent,
] = process.argv.slice(2);
const current = fs.existsSync(path)
  ? JSON.parse(fs.readFileSync(path, "utf8"))
  : {};
const value = {
  ...current,
  round: Number(round),
  swarm_name: swarmName,
  workspace_id: workspaceId,
  workspace_name: workspaceName,
  seed_sha: seedSha,
  coswarm_sha_mini: coswarmSha,
  coswarm_sha_laptop: laptopCoswarmSha,
  oauth_consent: oauthConsent,
  reset_started_at: new Date().toISOString(),
  reset_complete: false,
};
fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
NODE

say "Seeding fresh fixture workspace '$workspace_name' (additive; no deletes)."
token_dir="$(mktemp -d "${TMPDIR:-/tmp}/uxtest-seed.XXXXXX")"
token_path="$token_dir/agent-token"
cleanup_seed_dir() {
  rm -rf "$token_dir"
}
trap cleanup_seed_dir EXIT

mini_node="$(<"$UXTEST_MINI_HOME_ROOT/product/NODE_BIN")"
seed_json="$(
  DATABASE_URL="$DATABASE_URL" \
    SEED_TOKEN_OUT="$token_path" \
    "$mini_node" "$UXTEST_MINI_HOME_ROOT/product/dist/cli.js" \
      seed-fixture \
      --uid "$UXTEST_HUMAN1_UID" \
      --workspace-id "$workspace_id" \
      --workspace-name "$workspace_name" \
      --display-name "UX Test Human 1" \
      --agent-name "uxtest-fixture-r$round"
)"
printf '%s\n' "$seed_json" |
  node -e '
    let raw = "";
    process.stdin.on("data", chunk => raw += chunk);
    process.stdin.on("end", () => {
      const value = JSON.parse(raw);
      if (value.workspaceId !== process.argv[1]) {
        throw new Error("seed returned a different workspace_id");
      }
      if (value.workspaceName !== process.argv[2]) {
        throw new Error("seed returned a different workspace name");
      }
    });
  ' "$workspace_id" "$workspace_name"
rm -f "$token_path"
say "Fixture seed verified; its one-time agent credential was destroyed."

profile="$(profile_id)"
mini_profile="$HOME/.coswarm/credentials.d/$profile.profile.json"
remote_profile="/Users/tom/.coswarm/credentials.d/$profile.profile.json"

say "Logging Human1 out locally and removing only this target's profile sidecar."
set +e
mini_logout="$(
  SWARM_CLOUD_URL="$SWARM_CLOUD_URL" \
    SWARM_CLOUD_ANON_KEY="$SWARM_CLOUD_ANON_KEY" \
    "$mini_node" "$UXTEST_MINI_HOME_ROOT/product/dist/cli.js" logout 2>&1
)"
mini_logout_status=$?
set -e
[ "$mini_logout_status" -eq 0 ] ||
  die "mini logout failed: $mini_logout"
rm -f "$mini_profile"
[ ! -e "$mini_profile" ] || die "mini profile sidecar survived reset"

say "Logging Human2 out remotely and removing only this target's profile sidecar."
remote_zsh "
  set -e
  source '$UXTEST_REMOTE_HOME_ROOT/config/cloud.env'
  node_bin=\$(cat '$UXTEST_REMOTE_HOME_ROOT/product/NODE_BIN')
  \"\$node_bin\" '$UXTEST_REMOTE_HOME_ROOT/product/dist/cli.js' logout
  rm -f '$remote_profile'
  test ! -e '$remote_profile'
"

archive_persona_dir() {
  local role="$1"
  local path="$UXTEST_MINI_HOME_ROOT/$role/r$round"
  if [ -d "$path" ]; then
    local archive="$UXTEST_MINI_HOME_ROOT/archive/$role"
    mkdir -p "$archive"
    mv "$path" "$archive/r${round}-$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  mkdir -p "$path"
  [ -z "$(find "$path" -mindepth 1 -maxdepth 1 -print -quit)" ] ||
    die "$path is not empty after reset"
}

archive_persona_dir human1
if [ -d "$UXTEST_MINI_HOME_ROOT/logs/r$round" ]; then
  mkdir -p "$UXTEST_MINI_HOME_ROOT/archive/logs"
  mv "$UXTEST_MINI_HOME_ROOT/logs/r$round" \
    "$UXTEST_MINI_HOME_ROOT/archive/logs/r${round}-$(date -u +%Y%m%dT%H%M%SZ)"
fi

remote_zsh "
  set -e
  path='$UXTEST_REMOTE_HOME_ROOT/human2/r$round'
  if [ -d \"\$path\" ]; then
    archive='$UXTEST_REMOTE_HOME_ROOT/archive/human2'
    mkdir -p \"\$archive\"
    mv \"\$path\" \"\$archive/r${round}-\$(date -u +%Y%m%dT%H%M%SZ)\"
  fi
  mkdir -p \"\$path\"
  test -z \"\$(find \"\$path\" -mindepth 1 -maxdepth 1 -print -quit)\"
  if [ -d '$UXTEST_REMOTE_HOME_ROOT/logs/r$round' ]; then
    mkdir -p '$UXTEST_REMOTE_HOME_ROOT/archive/logs'
    mv '$UXTEST_REMOTE_HOME_ROOT/logs/r$round' \
      '$UXTEST_REMOTE_HOME_ROOT/archive/logs/r${round}-'\$(date -u +%Y%m%dT%H%M%SZ)
  fi
"

say "Creating clean per-round local swarm '$swarm_name'."
"$UXTEST_SWARM_BIN" create "$swarm_name" \
  --root "$UXTEST_MINI_HOME_ROOT/human1/r$round" \
  --description "Isolated UX test round $round"
say "Creating the same clean per-round swarm on Tom's laptop."
remote_zsh "
  '$UXTEST_REMOTE_SWARM_BIN' create '$swarm_name' \
    --root '$UXTEST_REMOTE_HOME_ROOT/human2/r$round' \
    --description 'Isolated UX test round $round'
"

local_messages="$(
  sqlite3 "$HOME/.swarm/swarm.db" "
    SELECT count(*)
    FROM messages m JOIN swarms s ON s.id=m.swarm_id
    WHERE s.name='$swarm_name';
  "
)"
remote_messages="$(remote_zsh "
  sqlite3 ~/.swarm/swarm.db \"
    SELECT count(*)
    FROM messages m JOIN swarms s ON s.id=m.swarm_id
    WHERE s.name='$swarm_name';
  \"
")"
[ "$local_messages" = "0" ] && [ "$remote_messages" = "0" ] ||
  die "per-round swarm already contains chat history; choose a new round number"

node - "$setup" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const value = JSON.parse(fs.readFileSync(path, "utf8"));
value.reset_complete = true;
value.reset_completed_at = new Date().toISOString();
fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
NODE

say "Round $round reset verified: cold clients, empty persona directories, clean chat, fresh workspace $workspace_id."
