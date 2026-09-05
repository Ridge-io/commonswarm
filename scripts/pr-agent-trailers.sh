#!/usr/bin/env bash
# Build the agent-authorship block for a PR body, GENERATED from the commits the PR contains.
#
# The PR body is never the source of truth — the commits are. This script only summarises them, so
# a PR block can never disagree with the history it describes. Typing this block by hand would
# reintroduce exactly the drift the trailers were adopted to remove (AGENTS.md, "An enumeration
# inside a message must be generated, not typed").
#
# Usage:
#   scripts/pr-agent-trailers.sh origin/main..HEAD
#   gh pr create --body "$(git log --format=%B -1)$(scripts/pr-agent-trailers.sh origin/main..HEAD)"
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/agent-trailer-vocab.sh
. "$script_dir/lib/agent-trailer-vocab.sh"

range="${1:-}"
if [ -z "$range" ]; then
  echo "usage: $0 <git-range>   e.g. origin/main..HEAD" >&2
  exit 2
fi

if ! git rev-list "$range" >/dev/null 2>&1; then
  echo "pr-agent-trailers: COULD NOT RUN — cannot resolve range $range" >&2
  exit 2
fi

# One line per non-merge commit: model, family, tool, source. Tab-separated so the aggregation
# below cannot be confused by spaces inside a value.
rows() {
  local sha
  while IFS= read -r sha; do
    [ -n "$sha" ] || continue
    [ "$(git show -s --format='%p' "$sha" | wc -w | tr -d ' ')" -gt 1 ] && continue
    printf '%s\t%s\t%s\t%s\n' \
      "$(git show -s --format='%(trailers:key=Agent-Model,valueonly)' "$sha" | head -1 | sed -e 's/[[:space:]]*$//')" \
      "$(git show -s --format='%(trailers:key=Agent-Family,valueonly)' "$sha" | head -1 | sed -e 's/[[:space:]]*$//')" \
      "$(git show -s --format='%(trailers:key=Agent-Tool,valueonly)' "$sha" | head -1 | sed -e 's/[[:space:]]*$//')" \
      "$(git show -s --format='%(trailers:key=Agent-Model-Source,valueonly)' "$sha" | head -1 | sed -e 's/[[:space:]]*$//')"
  done < <(git rev-list "$range")
}

total="$(git rev-list --no-merges "$range" | wc -l | tr -d ' ')"
if [ "$total" -eq 0 ]; then
  echo "pr-agent-trailers: no non-merge commits in $range" >&2
  exit 0
fi

printf '## Agent authorship\n\n'
printf 'Generated from the %s commit(s) in `%s` by `scripts/pr-agent-trailers.sh`. Do not edit by hand.\n\n' \
  "$total" "$range"
printf '| commits | model | family | tool | model source |\n'
printf '|---:|---|---|---|---|\n'

# Aggregate with awk so values containing spaces survive. Sorted by commit count, descending.
# `sort | uniq -c` is NOT used here: it re-splits on whitespace and would break "claude-code 2.1.257".
rows | awk -F'\t' '
  { key = $1 "\t" $2 "\t" $3 "\t" $4; n[key]++ }
  END {
    for (k in n) printf "%d\t%s\n", n[k], k
  }
' | sort -rn -k1,1 | awk -F'\t' '
  {
    model  = ($2 == "" ? "(absent)" : $2)
    family = ($3 == "" ? "(absent)" : $3)
    tool   = ($4 == "" ? "(absent)" : $4)
    source = ($5 == "" ? "(absent)" : $5)
    printf "| %d | `%s` | %s | %s | %s |\n", $1, model, family, tool, source
  }
'

printf '\n'

# The honesty line. `declared` means somebody asserted the model; `runtime-*` means it was read off
# the runtime. A reader weighing this audit needs to know which, and burying it would defeat the
# purpose of recording the source at all.
#
# `runtime-ambiguous` is deliberately NOT counted as measured. It means more than one runtime's
# variables were visible, so the model may belong to a parent session; folding it into the measured
# count would inflate exactly the number a reader trusts most.
measured="$(rows | awk -F'\t' '$4 ~ /^runtime-/ && $4 != "runtime-ambiguous" { n++ } END { print n + 0 }')"
ambiguous="$(rows | awk -F'\t' '$4 == "runtime-ambiguous" { n++ } END { print n + 0 }')"
declared="$(rows | awk -F'\t' '$4 == "declared" { n++ } END { print n + 0 }')"
unread="$(rows | awk -F'\t' '$4 == "none" || $4 == "" { n++ } END { print n + 0 }')"
printf '%s of %s commit(s) had the model read from the runtime; %s read from a runtime that could not be told apart from a parent session; %s declared by hand; %s not established.\n' \
  "$measured" "$total" "$ambiguous" "$declared" "$unread"
