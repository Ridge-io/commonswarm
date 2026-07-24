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

swarm_name="$(round_swarm "$round")"
human1="$(human1_name "$round")"
human2="$(human2_name "$round")"
parent="$UXTEST_MINI_HOME_ROOT/human1"
cwd="$parent/r$round"

mkdir -p "$parent" "$cwd"
install -m 600 "$UXTEST_DIR/personas/human1-inviter.md" "$parent/CLAUDE.md"

unexpected="$(
  find "$cwd" -mindepth 1 -maxdepth 1 ! -name BRIEF.md -print -quit
)"
[ -z "$unexpected" ] ||
  die "Human1 round cwd contains data other than BRIEF.md: $unexpected"

node - "$cwd/BRIEF.md" "$round" "$swarm_name" "$human1" "$human2" \
  "$UXTEST_HUMAN2_EMAIL" <<'NODE'
const fs = require("node:fs");
const [path, round, swarmName, human1, human2, email] = process.argv.slice(2);
const brief = `# Round ${round} brief

You are ${human1}. Your colleague is ${human2}; their GitHub email is ${email}.
Your chat channel is the local swarm named \`${swarmName}\`. Send short colleague
messages with \`swarm send ${human2} "<message>" --swarm ${swarmName}\`.

Your team's project is already set up for you. Goal: get ${human2}'s agent
working with you on it. Start with only the product CLI \`coswarm\`, what it
prints, and its help if you genuinely need it. The study driver will not teach
the mechanism.

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

lint_brief "$cwd/BRIEF.md"
audit_brief "$round" human1 "$cwd/BRIEF.md"

entry_count="$(find "$cwd" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')"
[ "$entry_count" = "1" ] && [ -f "$cwd/BRIEF.md" ] ||
  die "Human1 round cwd is not isolated to BRIEF.md"

if "$UXTEST_SWARM_BIN" members --swarm "$swarm_name" 2>/dev/null |
  grep -Fq "$human1 ["; then
  say "$human1 is already present; launch is idempotently satisfied."
  exit 0
fi

say "Launching fresh Human1 persona $human1 from isolated cwd $cwd."
PATH="$UXTEST_MINI_HOME_ROOT/bin:$PATH" \
  UXTEST_HOME_ROOT="$UXTEST_MINI_HOME_ROOT" \
  UXTEST_ROLE=human1 \
  UXTEST_ROUND="$round" \
  SWARM_CLOUD_URL="$SWARM_CLOUD_URL" \
  SWARM_CLOUD_ANON_KEY="$SWARM_CLOUD_ANON_KEY" \
  "$UXTEST_SWARM_BIN" spawn \
    --agent claude \
    --name "$human1" \
    --cwd "$cwd" \
    --swarm "$swarm_name" \
    --terminal cmux

wait_for_agent_local "$swarm_name" "$human1" 45 ||
  die "$human1 did not join $swarm_name after spawn"
say "$human1 joined $swarm_name from the isolated round directory."
