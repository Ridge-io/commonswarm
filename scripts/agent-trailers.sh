#!/usr/bin/env bash
# Emit the agent-authorship trailer block for the commit being written.
#
# WHY TRAILERS AND NOT LABELS. `git log --format='%(trailers:key=Agent-Model,valueonly)'` returns
# the whole history in one command, offline, with no API. Labels live in GitHub, and this repo has
# already moved once (2026-08-10, Ridge-io/commonswarm) in a way that changed every SHA. Anything
# stored outside the object graph would not have survived that.
#
# THE ONE RULE THAT MAKES THIS WORTH DOING: the model string is READ FROM THE RUNTIME, never
# typed. A hand-typed model name is a claim with no control on it, and it goes stale the day the
# seat is upgraded — silently, and in the direction that makes the audit flattering. Where a
# runtime exposes nothing we can trust, this script emits the `unknown` sentinel and says so in
# Agent-Model-Source. A wrong automatic answer is worse than an absent one (AGENTS.md,
# "Onboarding: ask for the minimum, detect the rest").
#
# SCOPE: this tags work FROM NOW ON. Commits made before the hook existed cannot be labelled
# reliably and must NOT be backfilled with guesses — see docs/development/agent-trailers.md.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/agent-trailer-vocab.sh
. "$script_dir/lib/agent-trailer-vocab.sh"

# Detector results. A detector sets the ones it can establish and leaves the rest empty.
detected_model=""
detected_family=""
detected_tool=""
detected_source=""

# ---------------------------------------------------------------------------
# Detectors
#
# Each returns 0 when it identified its runtime (even if it could only establish the family), and
# 1 when this is not that runtime. Setting detected_model is OPTIONAL: a detector that recognises
# its runtime but cannot read the model leaves it empty, and the caller fills in the `unknown`
# sentinel with source `none`. That split is the point — "an agent wrote this and we could not
# read which" is a different fact from "no agent wrote this".
# ---------------------------------------------------------------------------

# NOT ONE OF THE FOUR RUNTIMES EXPORTS ITS MODEL AS AN ENVIRONMENT VARIABLE. Enumerated on this
# machine 2026-09-04 by running `env` inside a live session of each, and by scanning the installed
# binaries for the variable names they set. Three of the four can still be recovered, always by
# the same shape: an env var carries a SESSION ID, and an on-disk session record written by that
# runtime carries the model. That indirection is what makes this a measurement rather than a
# guess, so each detector below joins the two rather than reading a config default.
#
# WHY NOT THE CONFIG FILE. ~/.codex/config.toml and ~/.grok/config.toml both record a `model`, and
# both record the CONFIGURED DEFAULT ONLY. `codex exec -m <other>` and an in-session `/model`
# switch do not change them. Reading either would produce a confident wrong answer on exactly the
# lanes worth auditing — the ones where somebody deliberately chose a different model.

# Claude Code. MEASURED on this machine 2026-09-04.
#
# The environment does NOT carry the model. Enumerated: CLAUDECODE, CLAUDE_CODE_ENTRYPOINT,
# CLAUDE_CODE_SESSION_ID, CLAUDE_AGENT_SDK_VERSION, AI_AGENT, CLAUDE_CODE_EXECPATH, CLAUDE_PID,
# CLAUDE_EFFORT. Not one of them names the model, so there is nothing to read out of env and any
# value derived from env alone would be a guess. CLAUDE_AGENT_SDK_VERSION is the SDK version
# (0.3.257), NOT the CLI version (2.1.257) — do not conflate them.
#
# The session transcript does carry it, per assistant message, as `.message.model`. The file is
# ~/.claude/projects/<cwd-with-slashes-as-dashes>/<session-id>.jsonl and it is appended LIVE
# (measured: 114 rows -> 471 rows during one session), so the last row is the model serving the
# turn that is committing right now. That matters when a seat is upgraded mid-session.
#
# GLOB THE PROJECT DIRS, do not derive one from $PWD. The directory is keyed by the cwd the
# session STARTED in, which is not the cwd at commit time whenever the agent works in a worktree —
# which is the normal case here (AGENTS.md "Sprint hygiene": one worktree per lane).
detect_claude_code() {
  [ "${CLAUDECODE:-}" = "1" ] || return 1
  detected_family=anthropic
  detected_tool="claude-code"

  local session="${CLAUDE_CODE_SESSION_ID:-}"
  # AI_AGENT is `claude-code_2-1-257_agent`; the transcript's own .version is preferred below.
  if [ -n "${AI_AGENT:-}" ]; then
    local from_env="${AI_AGENT#claude-code_}"
    from_env="${from_env%_agent}"
    if [ "$from_env" != "${AI_AGENT:-}" ]; then
      detected_tool="claude-code ${from_env//-/.}"
    fi
  fi

  [ -n "$session" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0

  local transcript=""
  local candidate
  for candidate in "${HOME}"/.claude/projects/*/"${session}.jsonl"; do
    [ -f "$candidate" ] || continue
    transcript="$candidate"
    break
  done
  [ -n "$transcript" ] || return 0

  # isSidechain rows are Task subagents writing into this file. Their model is not this session's
  # model, so the main chain is the correct filter. A subagent that commits runs this script in
  # ITS own session, where its own rows are main-chain — which is how rule 2 ("record who wrote
  # the diff, not who ran the command") holds without anyone passing a flag.
  # PLACEHOLDER ROWS ARE NOT MODELS. Measured 2026-09-04 in a live transcript on this host: 56
  # main-chain assistant rows carried `.message.model` = "<synthetic>", which the harness writes for
  # turns it injects rather than a model serving. Taking the last row blindly would put `<synthetic>`
  # into the audit as if it were a model id, on any commit made straight after one. A model id is
  # never wrapped in angle brackets, so those rows are dropped and the last REAL one is used; if
  # every row is a placeholder, nothing is set and the caller falls through to the unknown sentinel.
  local model version
  model="$(jq -r 'select(.type=="assistant" and .isSidechain != true and .message.model != null)
                  | .message.model
                  | select(test("^<.*>$") | not)' "$transcript" 2>/dev/null | tail -1 || true)"
  [ -n "$model" ] && [ "$model" != "null" ] && detected_model="$model" && detected_source=runtime-transcript

  version="$(jq -r 'select(.version != null) | .version' "$transcript" 2>/dev/null | tail -1 || true)"
  [ -n "$version" ] && [ "$version" != "null" ] && detected_tool="claude-code $version"
  return 0
}

# OpenAI Codex CLI. MEASURED 2026-09-04 against codex-cli 0.147.0.
#
# CODEX_THREAD_ID is the session id and is also the uuid in the rollout filename. The rollout
# records `turn_context` PER TURN, so the LAST one is the model serving the turn that is
# committing — an in-session /model switch is picked up, which the first line would miss.
# `session_meta` carries cli_version and model_provider.
#
# There is no CODEX_MODEL. The full exported set is CODEX_CI, CODEX_MANAGED_BY_NPM,
# CODEX_MANAGED_PACKAGE_ROOT and CODEX_THREAD_ID, confirmed by scanning the Rust binary for
# CODEX_[A-Z0-9_]+ (30 names, none naming a model).
detect_codex() {
  [ -n "${CODEX_THREAD_ID:-}" ] || return 1
  detected_tool="codex"
  command -v jq >/dev/null 2>&1 || return 0

  local rollout=""
  local candidate
  # The sessions tree is ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<thread-id>.jsonl.
  for candidate in "${HOME}"/.codex/sessions/*/*/*/"rollout-"*"-${CODEX_THREAD_ID}.jsonl"; do
    [ -f "$candidate" ] || continue
    rollout="$candidate"
    break
  done
  [ -n "$rollout" ] || return 0

  local version provider model
  version="$(jq -r 'select(.type=="session_meta") | .payload.cli_version // empty' "$rollout" 2>/dev/null | head -1 || true)"
  [ -n "$version" ] && detected_tool="codex $version"

  # Read the provider rather than assuming openai: codex can be pointed at another provider, and
  # the family must describe the MODEL, not the tool that ran it.
  provider="$(jq -r 'select(.type=="session_meta") | .payload.model_provider // empty' "$rollout" 2>/dev/null | head -1 || true)"

  model="$(jq -r 'select(.type=="turn_context") | .payload.model // empty' "$rollout" 2>/dev/null | tail -1 || true)"
  if [ -n "$model" ]; then
    detected_model="$model"
    detected_source=runtime-transcript
    if [ -n "$provider" ] && agent_trailer_contains "$provider" AGENT_TRAILER_FAMILIES; then
      detected_family="$provider"
    else
      detected_family=openai
    fi
  fi
  return 0
}

# xAI Grok CLI. MEASURED 2026-09-04 against grok 1.0.13.
#
# GROK_SESSION_ID names a DIRECTORY under ~/.grok/sessions/<percent-encoded-cwd>/. Match on the
# directory name rather than reconstructing grok's percent-encoding of the cwd, which encodes `/`
# as %2F but leaves `.` alone and is easy to get wrong by hand.
#
# There is no GROK_MODEL. The exported set is GROK_AGENT, GROK_MANAGED_BY_NPM and GROK_SESSION_ID;
# the ~200 GROK_* names in the binary are inputs it READS, not values it exports.
detect_grok() {
  [ -n "${GROK_SESSION_ID:-}" ] || return 1
  detected_tool="grok"

  # The version is not exported and not in the session record, so it costs one subprocess.
  # Measured at 70ms, and </dev/null is required — grok errors with "Device not configured" when
  # its stdin is not a terminal it can open.
  local version
  version="$(grok --version </dev/null 2>/dev/null | head -1 | awk '{print $2}' || true)"
  [ -n "$version" ] && detected_tool="grok $version"

  command -v jq >/dev/null 2>&1 || return 0
  local dir="" candidate
  for candidate in "${HOME}"/.grok/sessions/*/"${GROK_SESSION_ID}"; do
    [ -d "$candidate" ] || continue
    dir="$candidate"
    break
  done
  [ -n "$dir" ] || return 0

  local model
  model="$(jq -r '.current_model_id // empty' "$dir/summary.json" 2>/dev/null || true)"
  if [ -n "$model" ]; then
    detected_model="$model"
    detected_family=xai
    detected_source=runtime-config
  fi
  return 0
}

# The Gemini/Antigravity reviewer CLI, which is `agy` and NOT `gemini`.
#
# MODEL DELIBERATELY NOT READ. Measured 2026-09-04 against agy 1.1.26, every candidate source
# failed in a way that would produce a WRONG value rather than no value:
#   - the child env (ANTIGRAVITY_*) carries conversation, trajectory and project ids, no model;
#   - no ~/.agy exists, and neither ~/.gemini/settings.json nor
#     ~/.gemini/antigravity-cli/settings.json records a selected model;
#   - the CLI log prints the --model FLAG, which is empty when the flag is not passed;
#   - the per-conversation SQLite trajectory records an INTERNAL ALIAS that does not round-trip:
#     a session launched with `--model gemini-3.1-pro-high` stored `gemini-pro-agent`, and others
#     stored `gemini-pro-default` or the placeholder enum MODEL_PLACEHOLDER_M318.
# So agy gets the `unknown` sentinel and an honest source. A lane that needs agy's model must
# declare it with CSWARM_AGENT_MODEL.
#
# FAMILY IS ALSO NOT SET, and that is not an oversight. `agy models` lists 15 ids including
# claude-opus-4-6-thinking and gpt-oss-120b-medium, so the tool being Google's does NOT make the
# model Google's. Agent-Family describes the model; with no model read, the family is unknown.
detect_agy() {
  [ -n "${ANTIGRAVITY_AGENT:-}" ] || return 1
  detected_tool="agy"
  # The only one of the four runtimes that hands its version straight to a child process.
  if [ -n "${ANTIGRAVITY_LS_VERSION:-}" ]; then
    detected_tool="agy ${ANTIGRAVITY_LS_VERSION#cli-}"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------

run_detectors() {
  local entry detector
  for entry in "${AGENT_TRAILER_RUNTIMES[@]}"; do
    detector="$(agent_trailer_runtime_detector "$entry")"
    if "$detector"; then return 0; fi
  done
  return 1
}

# How many runtimes claim to be here. Inheritance is symmetric — a codex parent leaves
# CODEX_THREAD_ID in a grok child exactly as a Claude Code parent leaves CLAUDE_* — so a count
# above one means the environment CANNOT say which runtime is innermost. The probe order still
# decides, because it is right for the nesting this repo runs, but the answer stops calling itself
# a clean measurement. Reading the count is the only way to know the difference; the order alone
# cannot tell a nested lane from a plain one.
count_runtime_markers() {
  local entry marker n=0
  for entry in "${AGENT_TRAILER_RUNTIMES[@]}"; do
    marker="$(agent_trailer_runtime_marker "$entry")"
    [ -n "${!marker:-}" ] && n=$((n + 1))
  done
  printf '%s' "$n"
}

# Explicit declaration beats detection, and is recorded as `declared` so the audit can tell an
# assertion from a measurement. This is how rule 2 is served when a LEAD commits a diff that a
# lane on another model actually wrote: the lead states that lane's model rather than letting the
# lead's own runtime sign for work it did not do.
resolve() {
  if [ -n "${CSWARM_AGENT_MODEL:-}" ]; then
    detected_model="${CSWARM_AGENT_MODEL}"
    detected_family="${CSWARM_AGENT_FAMILY:-unknown}"
    detected_tool="${CSWARM_AGENT_TOOL:-}"
    detected_source=declared
    # The escape hatch: a commit a person wrote by hand.
    if [ "$detected_model" = "$AGENT_TRAILER_MODEL_NO_AGENT" ] && [ -z "${CSWARM_AGENT_FAMILY:-}" ]; then
      detected_family=human
    fi
    return
  fi

  run_detectors || true

  # Downgrade the honesty field when more than one runtime was visible. The model above may belong
  # to a PARENT session, and a reader weighing the audit needs to be told that rather than left to
  # assume a clean read. Only a runtime-* source is downgraded: `none` is already the weakest value
  # and `declared` was never a measurement.
  case "$detected_source" in
    runtime-*)
      if [ "$(count_runtime_markers)" -gt 1 ]; then
        detected_source=runtime-ambiguous
      fi
      ;;
  esac

  if [ -z "$detected_model" ]; then
    detected_model="$AGENT_TRAILER_MODEL_UNKNOWN"
    detected_source=none
  fi
  [ -n "$detected_family" ] || detected_family=unknown
  [ -n "$detected_source" ] || detected_source=none
}

agent_name() {
  if [ -n "${CSWARM_AGENT_NAME:-}" ]; then printf '%s' "${CSWARM_AGENT_NAME}"; return; fi
  git config user.name 2>/dev/null || true
}

emit() {
  resolve
  local name
  name="$(agent_name)"

  [ -n "$name" ] && printf 'Agent-Name: %s\n' "$name"
  printf 'Agent-Model: %s\n' "$detected_model"
  printf 'Agent-Family: %s\n' "$detected_family"
  [ -n "$detected_tool" ] && printf 'Agent-Tool: %s\n' "$detected_tool"
  printf 'Agent-Model-Source: %s\n' "$detected_source"
  # Rule 3. Set CSWARM_HUMAN_EDIT=1 when a person changed the diff an agent produced, so the
  # audit does not credit a model for work a human did.
  if [ -n "${CSWARM_HUMAN_EDIT:-}" ] && [ "${CSWARM_HUMAN_EDIT}" != "0" ]; then
    printf 'Agent-Human-Edit: yes\n'
  fi
  return 0
}

usage() {
  cat <<MSG
usage: $0 [--emit | --detect | --help]

  --emit     print the trailer block for this commit (default)
  --detect   print the resolved fields as key=value, for debugging

Supported runtimes: $(agent_trailer_join $(agent_trailer_runtime_ids | tr '\n' ' '))
Model sources:      $(agent_trailer_join "${AGENT_TRAILER_SOURCES[@]}")
Families:           $(agent_trailer_join "${AGENT_TRAILER_FAMILIES[@]}")

Overrides (use when a lead commits a diff another model wrote):
  CSWARM_AGENT_MODEL   model id; recorded with source 'declared'
  CSWARM_AGENT_FAMILY  one of the families above
  CSWARM_AGENT_TOOL    tool and version, e.g. 'codex 0.4.2'
  CSWARM_AGENT_NAME    seat name; defaults to git config user.name
  CSWARM_HUMAN_EDIT=1  a person edited the diff an agent produced

For a commit with no agent author at all:
  CSWARM_AGENT_MODEL=$AGENT_TRAILER_MODEL_NO_AGENT git commit ...
MSG
}

case "${1:---emit}" in
  --emit) emit ;;
  --detect)
    resolve
    printf 'model=%s\nfamily=%s\ntool=%s\nsource=%s\n' \
      "$detected_model" "$detected_family" "$detected_tool" "$detected_source"
    ;;
  --help | -h) usage ;;
  *) usage >&2; exit 2 ;;
esac
