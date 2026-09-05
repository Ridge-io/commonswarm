#!/usr/bin/env bash
# Shared vocabulary for the agent-authorship commit trailers.
#
# THIS FILE IS THE ONLY DEFINITION. scripts/agent-trailers.sh (emit),
# scripts/check-agent-trailers.sh (gate) and scripts/pr-agent-trailers.sh (PR body) all source it.
#
# AGENTS.md, "An enumeration inside a message must be generated, not typed": every user-facing
# list in those scripts — required keys, accepted families, accepted sources, supported runtimes —
# is BUILT FROM THE ARRAYS BELOW at print time. Never retype one of these lists into a message,
# a doc example that claims to be exhaustive, or a test expectation. Add the value here and the
# sentences follow. tests/p1-cli/agent-trailers.test.ts fails when a script's printed list and
# this file disagree.
#
# shellcheck shell=bash

# ---------------------------------------------------------------------------
# Trailer keys
# ---------------------------------------------------------------------------

# The keys the gate REQUIRES on every commit. Adding one here makes the gate stricter and updates
# the failure message that names them; it does not need an edit anywhere else.
AGENT_TRAILER_REQUIRED_KEYS=(
  Agent-Model
  Agent-Family
)

# Keys the emitter may produce. Superset of the required ones.
AGENT_TRAILER_EMITTED_KEYS=(
  Agent-Name
  Agent-Model
  Agent-Family
  Agent-Tool
  Agent-Model-Source
)

# Optional keys the gate tolerates but never requires. `Agent-Human-Edit` marks a diff a person
# changed after an agent produced it. `Reviewed-By-Model` records a D-036 review arm and may
# repeat; git keeps every occurrence of a repeated trailer key.
AGENT_TRAILER_OPTIONAL_KEYS=(
  Agent-Human-Edit
  Reviewed-By-Model
)

# ---------------------------------------------------------------------------
# Accepted values
# ---------------------------------------------------------------------------

# Model families. `human` and `unknown` are values, not absences — see the two sentinel models.
AGENT_TRAILER_FAMILIES=(
  anthropic
  openai
  xai
  google
  human
  unknown
)

# How the model string was obtained. This is the audit's own honesty field: it says whether the
# model name was MEASURED off the runtime or merely ASSERTED by whoever ran the commit.
#   runtime-transcript  read out of the agent's own live session transcript
#   runtime-env         read out of an environment variable the runtime itself set
#   runtime-config      read out of the runtime's on-disk selected-model config
#   declared            a human or a lead supplied it via CSWARM_AGENT_* (an assertion, not a read)
#   none                nothing readable; the model is the `unknown` sentinel
AGENT_TRAILER_SOURCES=(
  runtime-transcript
  runtime-env
  runtime-config
  declared
  none
)

# Two sentinel model values, deliberately distinct because they answer different audit questions.
#   none     no agent wrote this commit; a person did. The escape hatch.
#   unknown  an agent wrote it and the runtime exposed nothing we could trust.
# Both PASS the gate. A wrong-but-plausible model name would also pass, which is exactly why
# emitting one is forbidden: the sentinels keep bad data out of the audit instead of hiding it.
AGENT_TRAILER_MODEL_NO_AGENT=none
AGENT_TRAILER_MODEL_UNKNOWN=unknown

# ---------------------------------------------------------------------------
# Runtime detectors
# ---------------------------------------------------------------------------

# Runtimes the emitter can identify, IN PROBE ORDER. Each entry is `<id>|<detector function>`; the
# function lives in scripts/agent-trailers.sh and is named here so the "supported runtimes"
# sentence in --help is generated from this list.
#
# THE ORDER IS LOAD-BEARING AND claude-code MUST BE LAST. Measured 2026-09-04: a Claude Code
# session that shells out to `grok` or `agy` leaves every CLAUDE_* variable in the child's
# environment — the grok and agy probes both reported the PARENT's CLAUDE_CODE_SESSION_ID. A
# detector that tested CLAUDECODE first would label every nested lane as Claude Code and sign
# another family's work with Anthropic's name, which is the exact defect AGENTS.md warns about
# under "Onboarding": CLAUDE_CODE_ENTRYPOINT can be inherited by a Codex child and mislabel it.
# The nested runtimes are probed first because their own variables are only present when they are
# the innermost runtime.
AGENT_TRAILER_RUNTIMES=(
  'codex|detect_codex'
  'grok|detect_grok'
  'agy|detect_agy'
  'claude-code|detect_claude_code'
)

# ---------------------------------------------------------------------------
# Helpers that build sentences out of the arrays above
# ---------------------------------------------------------------------------

# Join the remaining arguments with ", ".
agent_trailer_join() {
  local out=""
  local item
  for item in "$@"; do
    if [ -z "$out" ]; then out="$item"; else out="$out, $item"; fi
  done
  printf '%s' "$out"
}

# The runtime ids only, without their families or detector names.
agent_trailer_runtime_ids() {
  local entry
  for entry in "${AGENT_TRAILER_RUNTIMES[@]}"; do
    printf '%s\n' "${entry%%|*}"
  done
}

# True when $1 is an element of the array named by $2.
agent_trailer_contains() {
  local needle="$1" array_name="$2"
  local -a values
  eval "values=(\"\${${array_name}[@]}\")"
  local value
  for value in "${values[@]}"; do
    [ "$value" = "$needle" ] && return 0
  done
  return 1
}

# ---------------------------------------------------------------------------
# Grace: a commit whose own tree has no hook
# ---------------------------------------------------------------------------

# A COMMIT WHOSE OWN TREE DOES NOT CONTAIN THE HOOK IS NOT REQUIRED TO CARRY TRAILERS.
#
# Why any grace at all. The workflow resolves only the commits a push or PR ADDS, which keeps
# history out of it. That is not enough on its own: a pull_request event checks `base.sha..HEAD`,
# which contains every commit a branch already had before this landed. Enumerated 2026-09-04 on
# this checkout — eleven branches carried twenty non-merge commits with no Agent-Model between
# them, and every one would have failed the first time it was pushed or opened as a PR, for work
# written before the rule existed.
#
# WHY NOT A DATE. A cutoff timestamp was built first and does not survive contact with concurrent
# lanes. Measured on the same checkout: six of those twenty commits were authored AFTER the hour
# this feature was written, by five lanes that were running at that moment off an older `main`.
# Their checkouts had no hook and could not have had one, so a date-based cutoff failed work for a
# rule that did not exist where it was written. Moving the date forward does not fix it either: a
# cutoff in the future skips every commit and leaves the gate green while checking nothing.
#
# The commit's own tree answers the question exactly, with no clock and nothing to maintain. If
# `scripts/hooks/prepare-commit-msg` is not in the tree the commit records, the author could not
# have installed it from this repo, so the trailer is not required. Once this lands on `main`,
# every commit built on it carries the hook in its tree and is checked. There is no cutoff to
# update, nothing to move forward, and no window in which the rule is wrong.
#
# SCOPE. Deleting the hook would grant a commit grace. That is the same accident-guard scope as
# everything else here — it catches a checkout that never had the hook, not somebody who means to
# evade it — and unlike a back-dated author date, deleting the hook is a visible line in the diff.
#
# The path is a constant because three places need to agree on it: this gate, the `hooks:install`
# script in package.json, and the doc. tests/p1-cli/agent-trailers.test.ts fails when they differ,
# and the self-test fails when the path names no file, which is what would silently turn every
# commit into a skipped one.
AGENT_TRAILER_HOOK_DIR=scripts/hooks
AGENT_TRAILER_HOOK_PATH="${AGENT_TRAILER_HOOK_DIR}/prepare-commit-msg"
