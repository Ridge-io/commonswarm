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
cwd="$parent/r$round"

say "Staging Human2 persona rules outside the repository."
remote_zsh "mkdir -p '$parent' '$cwd' && chmod 700 '$parent' '$cwd'"
rsync -a "$UXTEST_DIR/personas/human2-invitee.md" \
  "$UXTEST_REMOTE:$parent/CLAUDE.md"
remote_zsh "chmod 600 '$parent/CLAUDE.md'"

unexpected="$(remote_zsh "
  find '$cwd' -mindepth 1 -maxdepth 1 ! -name BRIEF.md -print -quit
")"
[ -z "$unexpected" ] ||
  die "Human2 round cwd contains data other than BRIEF.md: $unexpected"

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
remote_zsh "chmod 600 '$cwd/BRIEF.md'"
lint_brief "$brief_file"
audit_brief "$round" human2 "$brief_file"

entry_count="$(remote_zsh "
  find '$cwd' -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' '
")"
[ "$entry_count" = "1" ] ||
  die "Human2 round cwd is not isolated to BRIEF.md"

if wait_for_agent_remote "$swarm_name" "$human2" 2; then
  say "$human2 is already present; fresh-persona launch is idempotently satisfied."
  exit 0
fi

base_members="$(remote_zsh "$UXTEST_REMOTE_SWARM_BIN members --swarm uxtest")"
printf '%s\n' "$base_members" | grep -Fq "Dana [" || die \
  "persistent GUI-session launcher Dana is absent. On the laptop in cmux run: mkdir -p ~/uxtest/human2/launcher && cd ~/uxtest/human2/launcher && swarm spawn --agent claude --name Dana --cwd ~/uxtest/human2/launcher --swarm uxtest --terminal cmux"

say "Asking the persistent GUI-session Dana tab to spawn virgin-context $human2."
remote_zsh "
  '$UXTEST_REMOTE_SWARM_BIN' register-a2a UxDriver \
    --endpoint 'http://$UXTEST_MINI_IP:18791' \
    --description 'Local UX harness driver; launcher control only' \
    --force \
    --swarm uxtest >/dev/null
  SWARM_AGENT_NAME=UxDriver SWARM_NAME=uxtest \
    '$UXTEST_REMOTE_SWARM_BIN' send --swarm uxtest Dana \
    'Launcher-only control task; you are not a study persona. Run: source $UXTEST_REMOTE_HOME_ROOT/config/cloud.env && PATH=$UXTEST_REMOTE_HOME_ROOT/bin:\$PATH UXTEST_HOME_ROOT=$UXTEST_REMOTE_HOME_ROOT UXTEST_ROLE=human2 UXTEST_ROUND=$round $UXTEST_REMOTE_SWARM_BIN spawn --agent claude --name $human2 --cwd $cwd --swarm $swarm_name --terminal cmux. Once it joins, stay out of the round.'
"

node - "$setup" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const value = JSON.parse(fs.readFileSync(path, "utf8"));
value.human2_spawn_requested_at = new Date().toISOString();
fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
NODE

if ! wait_for_agent_remote "$swarm_name" "$human2" 90; then
  node - "$setup" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const value = JSON.parse(fs.readFileSync(path, "utf8"));
value.human2_spawn_probe = "failed";
value.carryover = true;
fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
NODE
  die "virgin-context $human2 did not join. Do not run R2+ as regression; inspect the persistent Dana launcher in the laptop GUI and use a manual fresh tab rather than SSH Claude."
fi

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
value.human2_joined_at = new Date().toISOString();
value.fresh_human2_name = name;
value.carryover = false;
fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
NODE
say "Virgin-context spawn probe PASSED: $human2 joined on a distinct cmux surface; carryover=false."
