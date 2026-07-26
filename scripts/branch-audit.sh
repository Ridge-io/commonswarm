#!/bin/bash
# branch-audit — say which remote branches are DEBRIS and which are the ONLY COPY, before you prune.
#
#   scripts/branch-audit.sh            audit every remote branch
#   scripts/branch-audit.sh <branch>   audit one
#
#   exit 0  no branch is unsafe to prune (all absorbed, or none exist)
#   exit 1  at least one branch is the ONLY COPY of its content
#
# ── WHY THIS IS A SCRIPT AND NOT A TABLE IN A DOCUMENT ───────────────────────────────────────
# 2026-07-25. `git cherry origin/main <branch>` has TWO verdicts and they demand OPPOSITE actions:
#
#   0 unabsorbed  ->  the branch is DEBRIS THAT READS LIKE AN OPEN ITEM. Safe to delete, and
#                     leaving it makes successors think there is pending work. (Ledger)
#   N unabsorbed  ->  the branch is A RECORD THAT READS LIKE DEBRIS. Deleting it destroys the
#                     only copy of its content. (Ferry)
#
# A janitor counting worktrees and unpushed commits CANNOT TELL THESE APART, and neither could
# any seat that evening without running the test. One branch that night held the only copy of a
# runbook, a set of gate findings and a persona fixture; another held nothing not already on main.
# They looked identical from the outside.
#
# It is a script rather than a published table because the answer MOVES. A table produced at
# 20:07 said "vane/launch-audit: behind 0"; by 20:10 main had advanced and the true answer was
# "behind 1". A correction posted after a claim does not reach a reader who does not rewind —
# so the durable form is the MEASUREMENT, kept next to the thing it protects, not the result.
#
# ── TWO TRAPS, BOTH PAID FOR ─────────────────────────────────────────────────────────────────
#
# TRAP 2, found by this script on its FIRST RUN: the merge-safety column originally used
# `git diff --name-status main <branch>` and reported "merging deletes 15 file(s)" for a branch
# that a real merge does not touch at all. TWO-DOT DIFF IS NOT A MERGE PREVIEW — it compares two
# tips, so every file added to main after the branch's base appears as a deletion. `git merge-tree`
# computes the actual result against the merge base; on that same branch it reports ZERO deletions
# and three additions. Vane hit this independently the same evening and retracted the scare.
# A false alarm here has a destructive default in the other direction — it argues against landing
# the only copy of someone's work.
#
# TRAP 1: the first version of this loop enumerated refs/remotes/origin and printed a row for
# `refs/remotes/origin/HEAD` reading "0 unabsorbed — safe to delete". THE NUMBER WAS CORRECT AND
# THE ROW SHOULD NOT HAVE EXISTED: HEAD is not a branch, and the verdict attached to it told the
# reader to delete their remote. Hence the `/` guard and the explicit HEAD exclusion below —
# validate the OBJECT TYPE before attaching a destructive verdict to a correct measurement.
set -uo pipefail

git fetch origin --prune --quiet 2>/dev/null || true
BASE=origin/main
ONLY_COPY=0

refs=$(git for-each-ref --format='%(refname:short)' refs/remotes/origin \
       | grep '/' | grep -vE "^origin/HEAD$|^${BASE#origin/}$|^origin/main$")
[ $# -eq 1 ] && refs=$(printf '%s\n' "$refs" | grep -E "(^|/)$1$" || true)

if [ -z "$refs" ]; then echo "no remote branches to audit (besides $BASE)"; exit 0; fi

printf "%-30s %11s %7s  %s\n" BRANCH UNABSORBED BEHIND VERDICT
for b in $refs; do
  plus=$(git cherry "$BASE" "$b" 2>/dev/null | grep -c '^+')
  behind=$(git rev-list --count "$b".."$BASE" 2>/dev/null || echo '?')
  # merge-tree, NOT two-dot diff: see TRAP 2. Falls back to "?" on older git rather than lying.
  mt=$(git merge-tree --write-tree "$BASE" "$b" 2>/dev/null | head -1)
  if [ -n "$mt" ]; then dels=$(git diff --name-status "$BASE" "$mt" 2>/dev/null | grep -c '^D'); else dels="?"; fi
  if [ "$plus" = "0" ]; then
    v="ABSORBED — safe to delete"
  else
    ONLY_COPY=1
    v="ONLY COPY — DO NOT PRUNE"
    case "$dels" in
      0) : ;;
      \?) v="$v · merge preview unavailable (git too old for merge-tree --write-tree)" ;;
      *) v="$v · WARNING: a real merge deletes $dels file(s) from $BASE" ;;
    esac
  fi
  printf "%-30s %11s %7s  %s\n" "${b#origin/}" "$plus" "$behind" "$v"
done

echo
echo "BEHIND is informational — a branch behind $BASE is not unsafe to keep or to merge. The"
echo "WARNING column is computed with git merge-tree, not a two-dot diff, because a two-dot diff"
echo "reports every file added to $BASE since the branch's base as a deletion. 'Is the document"
echo "right' and 'is the branch safe to land' are different questions."
exit "$ONLY_COPY"
