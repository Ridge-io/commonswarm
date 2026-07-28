#!/usr/bin/env bash

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "$0")" && pwd -P)/_lib.sh"

round="${1:-}"
validate_round "$round"
load_cloud_env
require_env UXTEST_OAUTH_CONSENT
require_command uuidgen
require_command git
require_command curl
require_command node

case "$UXTEST_OAUTH_CONSENT" in
  first|returning) ;;
  *) die "UXTEST_OAUTH_CONSENT must be first or returning" ;;
esac

output_dir="$(round_output_dir "$round")"
setup="$(round_setup_path "$round")"
swarm_name="$(round_swarm "$round")"
mkdir -p "$output_dir"

# A round has exactly one mode, and setup.json is where it is recorded. Requesting
# a different mode against an existing record would produce a setup.json whose
# fields describe two different rounds.
setup_mode="$(round_setup_mode "$round")"
validate_setup_mode "$setup_mode"
if [ -f "$setup" ] && [ "$setup_mode" != "$UXTEST_SETUP_MODE" ]; then
  die "round $round was already reset in '$setup_mode' mode but UXTEST_SETUP_MODE is '$UXTEST_SETUP_MODE'; use a new round number rather than changing a round's mode"
fi

if [ "$setup_mode" = "seeded" ]; then
  # Only the seeded path writes to the hosted database, so only it needs the
  # privileged credential here. (preflight.sh still takes its read-only
  # membership snapshot with DATABASE_URL in both modes — this narrows reset,
  # it does not make a round credential-free.)
  require_env DATABASE_URL
  require_env UXTEST_HUMAN1_UID
else
  say "Setup mode: self-serve. No project is provisioned; Human1 must create one with the product CLI, which is the thing under test."
  say "HONEST LIMIT: create_workspace is served only when SWARM_SELF_SERVE=1 in the target deployment's edge-function environment, and production does not set it. Against production this round measures the refusal, not a working front door. There is no probe that can tell 'self-serve disabled' from 'not permitted' — the server returns the same 403 — so this warning is not a gate and the report must say which of the two it observed."
fi

if [ -f "$output_dir/transcript.md" ] || [ -f "$output_dir/REPORT.md" ]; then
  die "round $round already has collected artifacts; use a new round number"
fi
assert_launcher_channel

if [ -f "$setup" ]; then
  workspace_name="$(json_field "$setup" workspace_name)"
  if [ "$setup_mode" = "seeded" ]; then
    # Still strict: a seeded re-reset with no recorded id must stop, not seed
    # against an empty one.
    workspace_id="$(json_field "$setup" workspace_id)"
  else
    # In self-serve mode there is no id to carry: only the persona can mint one,
    # and if a prior attempt did, the harness never learned it. The name — which
    # the brief hands them — is the only thing that carries across a re-reset.
    workspace_id=""
  fi
  say "Reusing round $round's existing additive workspace identity."
else
  short_random="$(uuidgen | tr '[:upper:]' '[:lower:]' | cut -c1-8)"
  workspace_name="uxtest-r${round}-${short_random}"
  if [ "$setup_mode" = "seeded" ]; then
    workspace_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
  else
    workspace_id=""
  fi
fi

if [ "$setup_mode" = "seeded" ]; then
  seed_sha="$(git -C "$UXTEST_REPO" hash-object src/cloud/seed.ts)"
else
  seed_sha=""
fi
coswarm_sha="$(<"$UXTEST_MINI_HOME_ROOT/product/SOURCE_SHA")"
laptop_coswarm_sha="$(
  remote_zsh "cat '$UXTEST_REMOTE_HOME_ROOT/product/SOURCE_SHA'"
)"
[ "$coswarm_sha" = "$laptop_coswarm_sha" ] ||
  die "FAIL CLOSED: mini/laptop copied cswarm hashes differ before reset"

node - "$setup" "$round" "$swarm_name" "$workspace_id" "$workspace_name" \
  "$seed_sha" "$coswarm_sha" "$laptop_coswarm_sha" \
  "$UXTEST_OAUTH_CONSENT" "$setup_mode" <<'NODE'
const fs = require("node:fs");
const [
  path, round, swarmName, workspaceId, workspaceName, seedSha, coswarmSha,
  laptopCoswarmSha, oauthConsent, setupMode,
] = process.argv.slice(2);
const current = fs.existsSync(path)
  ? JSON.parse(fs.readFileSync(path, "utf8"))
  : {};
const value = {
  ...current,
  round: Number(round),
  setup_mode: setupMode,
  swarm_name: swarmName,
  // null, not "", so a reader cannot mistake "the persona has not created it yet"
  // for "here is the id".
  workspace_id: workspaceId === "" ? null : workspaceId,
  workspace_name: workspaceName,
  seed_sha: seedSha === "" ? null : seedSha,
  coswarm_sha_mini: coswarmSha,
  coswarm_sha_laptop: laptopCoswarmSha,
  oauth_consent: oauthConsent,
  reset_started_at: new Date().toISOString(),
  reset_complete: false,
  human1_spawn_requested_at: null,
  human1_joined_at: null,
  human1_join_latency_ms: null,
  human1_join_attempts: null,
  human2_reset_dispatch_at: null,
  human2_reset_completed_at: null,
  human2_reset_via: null,
  human2_spawn_dispatch_at: null,
  human2_spawn_requested_at: null,
  human2_joined_at: null,
  human2_join_latency_ms: null,
  human2_join_attempts: null,
  human2_spawn_probe: null,
  fresh_human2_name: null,
  carryover: true,
};
fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
NODE

mini_node="$(<"$UXTEST_MINI_HOME_ROOT/product/NODE_BIN")"

if [ "$setup_mode" = "seeded" ]; then
  say "Seeding fresh fixture workspace '$workspace_name' (additive; no deletes)."
  token_dir="$(mktemp -d "${TMPDIR:-/tmp}/uxtest-seed.XXXXXX")"
  token_path="$token_dir/agent-token"
  cleanup_seed_dir() {
    rm -rf "$token_dir"
  }
  trap cleanup_seed_dir EXIT

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
else
  # Nothing is provisioned here on purpose. The name is reserved for the brief so
  # the round's rows stay identifiable as test data; the project itself only
  # exists if the persona succeeds in creating it.
  say "No fixture seeded. Round $round expects Human1 to create '$workspace_name' themselves; whether that happened is read back from the observed command log at collect, never assumed here."
fi

profile="$(profile_id)"
mini_profile="$HOME/.cswarm/credentials.d/$profile.profile.json"
remote_reset_state="$UXTEST_REMOTE_HOME_ROOT/human2/reset-state/r$round.json"

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

say "Delegating Human2 logout and keychain verification to GUI-session launcher $UXTEST_LAUNCHER_NAME."
remote_zsh "rm -f '$remote_reset_state'"
launcher_send \
  "Launcher-only reset task; you are not a study persona. Do not spawn a round agent. Run exactly: UXTEST_HOME_ROOT=$UXTEST_REMOTE_HOME_ROOT UXTEST_MINI_HOME_ROOT=$UXTEST_REMOTE_HOME_ROOT UXTEST_REMOTE_HOME_ROOT=$UXTEST_REMOTE_HOME_ROOT UXTEST_SWARM_BIN=$UXTEST_REMOTE_SWARM_BIN UXTEST_SECURITY_BIN=/usr/bin/security $UXTEST_REMOTE_REPO/uxtest/scripts/reset-human2-gui.sh $round $profile. Once it completes, stay out of the round."

node - "$setup" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const value = JSON.parse(fs.readFileSync(path, "utf8"));
value.human2_reset_dispatch_at = new Date().toISOString();
fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
NODE

gui_reset_timeout="${UXTEST_GUI_RESET_TIMEOUT_SECONDS:-120}"
case "$gui_reset_timeout" in
  ''|*[!0-9]*|0) die "UXTEST_GUI_RESET_TIMEOUT_SECONDS must be a positive integer" ;;
esac
gui_reset_elapsed=0
gui_reset_json=
while [ "$gui_reset_elapsed" -lt "$gui_reset_timeout" ]; do
  gui_reset_json="$(remote_zsh \
    "test -f '$remote_reset_state' && cat '$remote_reset_state' || true")"
  if [ -n "$gui_reset_json" ]; then
    gui_reset_status="$(
      printf '%s\n' "$gui_reset_json" |
        node -e '
          let raw = "";
          process.stdin.on("data", chunk => raw += chunk);
          process.stdin.on("end", () => {
            try {
              const value = JSON.parse(raw);
              process.stdout.write(String(value.status ?? ""));
            } catch {
              process.exitCode = 2;
            }
          });
        ' 2>/dev/null || true
    )"
    case "$gui_reset_status" in
      succeeded) break ;;
      failed)
        gui_reset_detail="$(
          printf '%s\n' "$gui_reset_json" |
            node -e '
              let raw = "";
              process.stdin.on("data", chunk => raw += chunk);
              process.stdin.on("end", () => {
                const value = JSON.parse(raw);
                process.stdout.write(String(value.detail ?? "unknown failure"));
              });
            '
        )"
        die "Human2 GUI-session reset failed: $gui_reset_detail"
        ;;
    esac
  fi
  "$UXTEST_SLEEP_BIN" 2
  gui_reset_elapsed=$((gui_reset_elapsed + 2))
done
[ "${gui_reset_status:-}" = "succeeded" ] ||
  die "Human2 GUI-session reset did not complete within ${gui_reset_timeout}s"

node - "$setup" "$gui_reset_json" "$round" "$profile" <<'NODE'
const fs = require("node:fs");
const [path, raw, roundRaw, profile] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(path, "utf8"));
const state = JSON.parse(raw);
if (
  state.status !== "succeeded" ||
  state.round !== Number(roundRaw) ||
  state.profile !== profile
) {
  throw new Error("Human2 GUI reset state does not match this round and profile");
}
value.human2_reset_completed_at = state.updated_at;
value.human2_reset_via = "dana-a2a-gui";
fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
NODE
say "Human2 cold-client reset was observed through the GUI launcher."

human1_workspace="$(persona_workspace human1)"
mkdir -p "$human1_workspace"
chmod 700 "$UXTEST_MINI_HOME_ROOT/human1" "$human1_workspace"
assert_workspace_sweep "$human1_workspace" "Human1"
if [ -d "$UXTEST_MINI_HOME_ROOT/logs/r$round" ]; then
  mkdir -p "$UXTEST_MINI_HOME_ROOT/archive/logs"
  mv "$UXTEST_MINI_HOME_ROOT/logs/r$round" \
    "$UXTEST_MINI_HOME_ROOT/archive/logs/r${round}-$(date -u +%Y%m%dT%H%M%SZ)"
fi

# ★ NEVER name a variable 'path' inside remote_zsh. In zsh `path` is a special
# array tied to $PATH, so `path=<dir>` REPLACES PATH with that single directory
# and every external command in the rest of the block vanishes. Verified live:
# `zsh -lic "path=/x; command -v mkdir"` -> NOT_FOUND; same block with
# `workspace_path` -> /bin/mkdir. remote_zsh runs zsh, not bash.
remote_zsh "
  set -e
  workspace_path='$UXTEST_REMOTE_HOME_ROOT/human2/workspace'
  mkdir -p \"\$workspace_path\"
  chmod 700 '$UXTEST_REMOTE_HOME_ROOT/human2' \"\$workspace_path\"
  '$UXTEST_REMOTE_REPO/uxtest/scripts/verify-persona-workspace.sh' \
    sweep \"\$workspace_path\" Human2
  if [ -d '$UXTEST_REMOTE_HOME_ROOT/logs/r$round' ]; then
    mkdir -p '$UXTEST_REMOTE_HOME_ROOT/archive/logs'
    mv '$UXTEST_REMOTE_HOME_ROOT/logs/r$round' \
      '$UXTEST_REMOTE_HOME_ROOT/archive/logs/r${round}-'\$(date -u +%Y%m%dT%H%M%SZ)
  fi
"

say "Creating clean per-round local swarm '$swarm_name'."
"$UXTEST_SWARM_BIN" create "$swarm_name" \
  --root "$human1_workspace" \
  --description "Isolated UX test round $round"
say "Creating the same clean per-round swarm on Tom's laptop."
remote_zsh "
  '$UXTEST_REMOTE_SWARM_BIN' create '$swarm_name' \
    --root '$UXTEST_REMOTE_HOME_ROOT/human2/workspace' \
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

# `swarm create` is create-or-update: it does NOT clear agents. A persona that
# joined during an aborted attempt survives a re-reset with zero messages, and
# launch-human{1,2}.sh would then find it already present. Assert agents too.
local_agents="$(
  sqlite3 "$HOME/.swarm/swarm.db" "
    SELECT count(*)
    FROM agents a JOIN swarms s ON s.id=a.swarm_id
    WHERE s.name='$swarm_name';
  "
)"
remote_agents="$(remote_zsh "
  sqlite3 ~/.swarm/swarm.db \"
    SELECT count(*)
    FROM agents a JOIN swarms s ON s.id=a.swarm_id
    WHERE s.name='$swarm_name';
  \"
")"
[ "$local_agents" = "0" ] && [ "$remote_agents" = "0" ] ||
  die "per-round swarm already has registered agents (mini=$local_agents, laptop=$remote_agents); a surviving persona is not a fresh round — choose a new round number"

node - "$setup" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const value = JSON.parse(fs.readFileSync(path, "utf8"));
value.reset_complete = true;
value.reset_completed_at = new Date().toISOString();
fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
NODE

if [ "$setup_mode" = "seeded" ]; then
  say "Round $round reset verified (seeded): cold clients, swept trusted persona directories, clean chat, fresh workspace $workspace_id."
else
  say "Round $round reset verified (self-serve): cold clients, swept trusted persona directories, clean chat, and no project — Human1 creates '$workspace_name' or the round stops there."
fi
