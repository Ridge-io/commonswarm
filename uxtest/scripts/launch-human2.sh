#!/usr/bin/env bash

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "$0")" && pwd -P)/_lib.sh"

round="${1:-}"
validate_round "$round"
assert_setup_exists "$round"

setup="$(round_setup_path "$round")"
[ "$(json_field "$setup" reset_complete)" = "true" ] ||
  die "round $round reset did not complete"

swarm_name="$(round_swarm "$round")"
human1="$(human1_name "$round")"
human2="$(human2_name "$round")"
parent="$UXTEST_REMOTE_HOME_ROOT/human2"
cwd="$parent/workspace"
spawn_state="$(persona_spawn_state_path human2 "$round")"

say "Staging Human2 persona rules outside the repository."
remote_zsh "mkdir -p '$parent' '$cwd' && chmod 700 '$parent' '$cwd'"
rsync -a "$UXTEST_DIR/personas/human2-invitee.md" \
  "$UXTEST_REMOTE:$parent/CLAUDE.md"
remote_zsh "chmod 600 '$parent/CLAUDE.md'"
remote_zsh "
  '$UXTEST_REMOTE_REPO/uxtest/scripts/verify-persona-workspace.sh' \
    sweep '$cwd' Human2
"

brief_file="$(mktemp "${TMPDIR:-/tmp}/uxtest-human2-brief.XXXXXX")"
cleanup_brief() {
  rm -f "$brief_file"
}
trap cleanup_brief EXIT
node - "$brief_file" "$round" "$swarm_name" "$human1" "$human2" <<'NODE'
const fs = require("node:fs");
const [path, round, swarmName, human1, human2] = process.argv.slice(2);
const brief = `# Round ${round} brief

You are ${human2}. Your colleague is ${human1}.
Your chat channel is the local swarm named \`${swarmName}\`. Reply with
\`swarm send ${human1} "<message>" --swarm ${swarmName}\`.

Goal: respond naturally when ${human1} tries to get your agent working with
their project. Use only what ${human1} sends and what \`coswarm\` itself says.
Prefer the obvious action or a short colleague question over reading a long
help page.

After you believe the agents are working together, help ${human1} agree on an
exact two-line daily handoff: one plain-language status line and one
plain-language blocker-or-next-step line.

Save the exact agreed two lines in \`RESULT.md\`. Then write \`FEEDBACK.md\`
before any debrief. Honest confusion or a reasoned stop is more valuable than
forcing completion.
`;
fs.writeFileSync(path, brief, { mode: 0o600 });
NODE
rsync -a "$brief_file" "$UXTEST_REMOTE:$cwd/BRIEF.md"
remote_zsh "
  chmod 600 '$cwd/BRIEF.md'
  printf '%s\n' '$round' >'$parent/current-round'
  chmod 600 '$parent/current-round'
"
lint_brief "$brief_file"
audit_brief "$round" human2 "$brief_file"
remote_zsh "
  '$UXTEST_REMOTE_REPO/uxtest/scripts/verify-persona-workspace.sh' \
    round '$cwd' Human2 '$round'
"

if wait_for_agent_remote "$swarm_name" "$human2" 2; then
  say "$human2 is already present; fresh-persona launch is idempotently satisfied."
  exit 0
fi

base_members="$(remote_zsh "$UXTEST_REMOTE_SWARM_BIN members --swarm uxtest")"
printf '%s\n' "$base_members" | grep -Fq "Dana [" || die \
  "persistent GUI-session launcher Dana is absent. On the laptop in cmux run: mkdir -p ~/uxtest/human2/launcher && cd ~/uxtest/human2/launcher && swarm spawn --agent claude --name Dana --cwd ~/uxtest/human2/launcher --swarm uxtest --terminal cmux"

say "Asking the persistent GUI-session Dana tab to spawn virgin-context $human2."
remote_zsh "rm -f '$spawn_state'"
remote_zsh "
  '$UXTEST_REMOTE_SWARM_BIN' register-a2a UxDriver \
    --endpoint 'http://$UXTEST_MINI_IP:18791' \
    --description 'Local UX harness driver; launcher control only' \
    --force \
    --swarm uxtest >/dev/null
  SWARM_AGENT_NAME=UxDriver SWARM_NAME=uxtest \
    '$UXTEST_REMOTE_SWARM_BIN' send --swarm uxtest Dana \
    'Launcher-only control task; you are not a study persona. Run exactly: source $UXTEST_REMOTE_HOME_ROOT/config/cloud.env && PATH=$UXTEST_REMOTE_HOME_ROOT/bin:\$PATH UXTEST_HOME_ROOT=$UXTEST_REMOTE_HOME_ROOT UXTEST_MINI_HOME_ROOT=$UXTEST_REMOTE_HOME_ROOT UXTEST_REMOTE_HOME_ROOT=$UXTEST_REMOTE_HOME_ROOT UXTEST_SWARM_BIN=$UXTEST_REMOTE_SWARM_BIN UXTEST_CMUX_BIN=/Applications/cmux.app/Contents/Resources/bin/cmux UXTEST_ROLE=human2 UXTEST_ROUND=$round UXTEST_JOIN_TIMEOUT_SECONDS=${UXTEST_JOIN_TIMEOUT_SECONDS:-30} UXTEST_JOIN_ATTEMPTS=${UXTEST_JOIN_ATTEMPTS:-3} UXTEST_JOIN_POLL_SECONDS=${UXTEST_JOIN_POLL_SECONDS:-2} $UXTEST_REMOTE_REPO/uxtest/scripts/spawn-observed.sh $round human2. Once it completes, stay out of the round.'
"

node - "$setup" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const value = JSON.parse(fs.readFileSync(path, "utf8"));
value.human2_spawn_dispatch_at = new Date().toISOString();
fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
NODE

join_timeout="${UXTEST_JOIN_TIMEOUT_SECONDS:-30}"
join_attempts="${UXTEST_JOIN_ATTEMPTS:-3}"
total_timeout=$((join_timeout * join_attempts + 30))
if ! wait_for_agent_remote "$swarm_name" "$human2" "$total_timeout"; then
  node - "$setup" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const value = JSON.parse(fs.readFileSync(path, "utf8"));
value.human2_spawn_probe = "failed";
value.carryover = true;
fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
NODE
  die "virgin-context $human2 did not register after bounded observed-join retries; inspect Dana and the spawn state at $spawn_state"
fi

spawn_state_json="$(remote_zsh "cat '$spawn_state'")" ||
  die "$human2 registered but the observed-spawn state is missing"
printf '%s\n' "$spawn_state_json" | node -e '
  const fs = require("node:fs");
  let raw = "";
  process.stdin.on("data", (chunk) => raw += chunk);
  process.stdin.on("end", () => {
    const setupPath = process.argv[1];
    const setup = JSON.parse(fs.readFileSync(setupPath, "utf8"));
    const state = JSON.parse(raw);
    if (state.observed !== true) {
      throw new Error("Human2 helper did not observe registration");
    }
    setup.human2_spawn_requested_at = state.spawn_requested_at;
    setup.human2_joined_at = state.joined_at;
    setup.human2_join_latency_ms = state.join_latency_ms;
    setup.human2_join_attempts = state.join_attempts;
    fs.writeFileSync(
      setupPath,
      `${JSON.stringify(setup, null, 2)}\n`,
      { mode: 0o600 },
    );
  });
' "$setup"

spawn_evidence="$(remote_zsh "
  sqlite3 -json ~/.swarm/swarm.db \"
    SELECT a.name, a.agent_type, a.surface_id, a.joined_at
    FROM agents a JOIN swarms s ON s.id=a.swarm_id
    WHERE (s.name='uxtest' AND a.name='Dana')
       OR (s.name='$swarm_name' AND a.name='$human2')
    ORDER BY a.joined_at;
  \"
")"
printf '%s\n' "$spawn_evidence" | node -e '
  let raw = "";
  process.stdin.on("data", chunk => raw += chunk);
  process.stdin.on("end", () => {
    const rows = JSON.parse(raw);
    const launcher = rows.find(row => row.name === "Dana");
    const persona = rows.find(row => row.name === process.argv[1]);
    if (!launcher || !persona) throw new Error("spawn evidence is incomplete");
    if (persona.agent_type !== "cmux") throw new Error("round persona is not a cmux agent");
    if (launcher.surface_id === persona.surface_id) {
      throw new Error("round persona reused the launcher surface");
    }
  });
' "$human2"

node - "$setup" "$human2" <<'NODE'
const fs = require("node:fs");
const [path, name] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(path, "utf8"));
value.human2_spawn_probe = "passed-distinct-cmux-surface";
value.fresh_human2_name = name;
value.carryover = false;
fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
NODE
say "Virgin-context spawn probe PASSED: $human2 joined on a distinct cmux surface; carryover=false."
