#!/usr/bin/env bash

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "$0")" && pwd -P)/_lib.sh"

round="${1:-}"
validate_round "$round"
assert_setup_exists "$round"

setup="$(round_setup_path "$round")"
output_dir="$(round_output_dir "$round")"
swarm_name="$(round_swarm "$round")"
human1="$(human1_name "$round")"
human2="$(human2_name "$round")"

[ -f "$UXTEST_MINI_HOME_ROOT/human1/r$round/FEEDBACK.md" ] ||
  die "Human1 has not written pre-debrief FEEDBACK.md"
[ -f "$UXTEST_MINI_HOME_ROOT/human1/r$round/JOURNAL.md" ] ||
  die "Human1 has not written JOURNAL.md"
remote_zsh "
  test -f '$UXTEST_REMOTE_HOME_ROOT/human2/r$round/FEEDBACK.md'
  test -f '$UXTEST_REMOTE_HOME_ROOT/human2/r$round/JOURNAL.md'
" || die "Human2 has not written both pre-debrief FEEDBACK.md and JOURNAL.md"

say "Collecting laptop evidence through memory-only stdout; raw capabilities are never staged."
remote_zsh "
  node '$UXTEST_REMOTE_REPO/uxtest/scripts/collect-remote.mjs' \
    '$round' '$swarm_name' '$human1' '$human2' '$UXTEST_REMOTE_HOME_ROOT'
" |
  node "$UXTEST_DIR/scripts/collect-round.mjs" \
    "$round" \
    "$UXTEST_DIR" \
    "$UXTEST_MINI_HOME_ROOT" \
    "$setup" \
    "$output_dir" \
    "$human1" \
    "$human2"

for artifact in \
  transcript.md \
  human1-feedback.md \
  human2-feedback.md \
  metrics.json \
  REPORT.md; do
  [ -s "$output_dir/$artifact" ] ||
    die "collector postcondition failed: $artifact is missing or empty"
done

node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const required = [
    "wall_clock_link_to_connected",
    "command_interval_timeline",
    "coswarm_invocations",
    "nonzero_exits",
    "unique_error_strings",
    "help_invocations",
    "completed_without_help",
    "help_requests_to_partner",
    "partner_rescued_steps",
    "time_to_first_coswarm",
    "time_to_first_accept_attempt",
    "command_sequence",
    "golden_path_distance",
    "used_link_stdin",
    "used_positional_link",
    "link_inspected",
    "task_completed",
    "gave_up",
    "gave_up_reason",
    "coswarm_sha_mini",
    "coswarm_sha_laptop",
    "workspace_id",
    "seed_sha",
    "oauth_consent",
    "carryover",
    "isolation_void",
  ];
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    throw new Error(`metrics schema missing: ${missing.join(", ")}`);
  }
  if (value.coswarm_sha_mini !== value.coswarm_sha_laptop) {
    throw new Error("version skew survived into collection");
  }
' "$output_dir/metrics.json"

say "Round $round collected and verified in $output_dir."
