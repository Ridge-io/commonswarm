#!/usr/bin/env bash

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "$0")" && pwd -P)/_lib.sh"

round="${1:-}"
validate_round "$round"
assert_setup_exists "$round"
load_cloud_env
require_env UXTEST_HUMAN2_EMAIL

setup="$(round_setup_path "$round")"
[ "$(json_field "$setup" reset_complete)" = "true" ] ||
  die "round $round reset did not complete"

setup_mode="$(round_setup_mode "$round")"
validate_setup_mode "$setup_mode"
workspace_name="$(json_field "$setup" workspace_name)"

swarm_name="$(round_swarm "$round")"
human1="$(human1_name "$round")"
human2="$(human2_name "$round")"
parent="$UXTEST_MINI_HOME_ROOT/human1"
cwd="$parent/workspace"
spawn_state="$(persona_spawn_state_path human1 "$round")"

mkdir -p "$parent" "$cwd"
install -m 600 "$UXTEST_DIR/personas/human1-inviter.md" "$parent/CLAUDE.md"
assert_workspace_sweep "$cwd" "Human1"

brief_file="$(mktemp "${TMPDIR:-/tmp}/uxtest-human1-brief.XXXXXX")"
cleanup_brief() {
  rm -f "$brief_file"
}
trap cleanup_brief EXIT

node - "$brief_file" "$round" "$swarm_name" "$human1" "$human2" \
  "$UXTEST_HUMAN2_EMAIL" "$setup_mode" "$workspace_name" <<'NODE'
const fs = require("node:fs");
const [path, round, swarmName, human1, human2, email, setupMode, projectName] =
  process.argv.slice(2);
// §7.9: both framings state where the project stands and nothing about how to
// act on it. Seeded rounds must not send the persona hunting for a project that
// is already there; self-serve rounds must not tell them one exists when it does
// not — a brief that lies produces feedback about the lie. Neither names a verb.
const situation = setupMode === "self-serve"
  ? `Your team does not have its project set up here yet, and getting it going
is part of what you have to work out. Your team calls the project
\`${projectName}\`. Goal: get ${human2}'s agent working with you on it.`
  : `Your team's project is already set up for you. Goal: get ${human2}'s agent
working with you on it.`;
const brief = `# Round ${round} brief

You are ${human1}. Your colleague is ${human2}; their GitHub email is ${email}.
Your chat channel is the local swarm named \`${swarmName}\`. Send short colleague
messages with \`swarm send ${human2} "<message>" --swarm ${swarmName}\`.

${situation}

Start with only the product CLI \`cswarm\`, what it prints, and its help if you
genuinely need it. The study driver will not teach the mechanism.

After you believe the agents are working together, ask ${human2} to help agree
on an exact two-line daily handoff:

1. a plain-language status line;
2. a plain-language blocker-or-next-step line.

Save the exact agreed two lines in \`RESULT.md\`. Then write \`FEEDBACK.md\`
before any debrief. Honest confusion or a reasoned stop is more valuable than
forcing completion.
`;
fs.writeFileSync(path, brief, { mode: 0o600 });
NODE

# §7.9: lint the STAGED brief before it reaches the persona's trusted cwd. A lint
# that runs after delivery can only report a burn, never prevent one.
lint_brief "$brief_file"
install -m 600 "$brief_file" "$cwd/BRIEF.md"
audit_brief "$round" human1 "$cwd/BRIEF.md"
printf '%s\n' "$round" >"$parent/current-round"
chmod 600 "$parent/current-round"
assert_round_brief_only "$cwd" "Human1" "$round"

# ★ IDEMPOTENCE MEANS THE EVIDENCE IS RECORDED, NOT THAT A PROCESS WITH THAT NAME
# EXISTS (§7.9b). A bare presence check exits 0 leaving §7.6's join fields null,
# which silently defeats the join-latency record that makes degradation visible.
if [ -n "$(json_field "$setup" human1_joined_at || true)" ] &&
  [ -n "$(json_field "$setup" human1_join_latency_ms || true)" ] &&
  [ -n "$(json_field "$setup" human1_join_attempts || true)" ] &&
  "$UXTEST_SWARM_BIN" members --swarm "$swarm_name" 2>/dev/null |
    grep -Fq "$human1 ["; then
  say "$human1 is present AND this round already recorded observed-join evidence; launch is idempotently satisfied."
  exit 0
fi

say "Launching fresh Human1 persona $human1 ($setup_mode round) from swept trusted cwd $cwd."
PATH="$UXTEST_MINI_HOME_ROOT/bin:$PATH" \
  UXTEST_HOME_ROOT="$UXTEST_MINI_HOME_ROOT" \
  UXTEST_ROLE=human1 \
  UXTEST_ROUND="$round" \
  SWARM_CLOUD_URL="$SWARM_CLOUD_URL" \
  SWARM_CLOUD_ANON_KEY="$SWARM_CLOUD_ANON_KEY" \
  "$UXTEST_DIR/scripts/spawn-observed.sh" "$round" human1

node - "$setup" "$spawn_state" <<'NODE'
const fs = require("node:fs");
const [setupPath, statePath] = process.argv.slice(2);
const setup = JSON.parse(fs.readFileSync(setupPath, "utf8"));
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
if (state.observed !== true) throw new Error("Human1 join was not observed");
setup.human1_spawn_requested_at = state.spawn_requested_at;
setup.human1_joined_at = state.joined_at;
setup.human1_join_latency_ms = state.join_latency_ms;
setup.human1_join_attempts = state.join_attempts;
fs.writeFileSync(
  setupPath,
  `${JSON.stringify(setup, null, 2)}\n`,
  { mode: 0o600 },
);
NODE
say "$human1 joined $swarm_name from the swept trusted directory."
