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
# TRAP 3, found by Vane and Sable AFTER this landed, and it had a live hazard behind it: the
# merge column alone is the wrong question for this repo. `git rev-list --count --merges main`
# is ZERO across 184 commits — nothing here has ever been merged. Work lands by squash or
# cherry-pick, and a SQUASH HAS NO MERGE BASE: for every path it touches it replaces main's
# version wholesale. The original WARNING counted only D (a file vanishing) and would have
# cleared a branch whose `M package.json` reverts `"private": true` — re-enabling `npm publish`
# on a repo the operator had just ruled must stay private. Ferry published the D-only form as
# the check and retracted it; Vane supplied the correct one. Both columns are now printed and
# the footer says which method each answers.
#
# TRAP 4: there is a THIRD question and the first two do not cover it. A successor who CHECKS
# OUT the branch sees its tree, not a merge result and not a squash. Ferry's findings file lived
# on a branch and told readers to run three tools that do not exist in that tree — true of main,
# false of where the reader stands. The instrument is the two-dot D-list, which is WRONG for a
# merge and CORRECT here; verified against `git cat-file -e` ground truth rather than assumed.
# The two-dot diff was never broken. It answers a question nobody had named.
#
# ── FOUR TRAPS, ALL PAID FOR ─────────────────────────────────────────────────────────────────
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

printf "%-26s %6s %6s  %s\n" BRANCH UNABS BEHIND "LANDING / READING"
for b in $refs; do
  plus=$(git cherry "$BASE" "$b" 2>/dev/null | grep -c '^+')
  behind=$(git rev-list --count "$b".."$BASE" 2>/dev/null || echo '?')

  # MERGE column — merge-tree against the merge base. NOT a two-dot diff: see TRAP 2.
  mt=$(git merge-tree --write-tree "$BASE" "$b" 2>/dev/null | head -1)
  if [ -n "$mt" ]; then
    md=$(git diff --name-status "$BASE" "$mt" 2>/dev/null | grep -c '^D')
    [ "$md" = "0" ] && mv_="merge: clean" || mv_="merge: LOSES $md file(s)"
  else
    mv_="merge: preview unavailable"
  fi

  # SQUASH column — see TRAP 3. NOT cherry-pick: a cherry-pick replays each commit, so its
  # safety is the STABLE per-commit question above (does any commit delete, which lanes), not
  # this two-dot line. Sable caught the label; the measurement was always squash-only. A squash has no merge base, so for every path it
  # touches it substitutes the branch's content wholesale. EVERY A/M/D is a candidate revert of
  # whatever main did to that file since. D-only is the degenerate case and misses the rest.
  sq=$(git diff --name-status "$BASE" "$b" 2>/dev/null | awk '$1 ~ /^[AMD]/ {print $NF}')
  sqn=$(printf '%s' "$sq" | grep -c . || true)
  if [ "$sqn" = "0" ]; then sv="squash: clean"
  else sv="squash: $sqn path(s) REPLACED — verify each: $(printf '%s' "$sq" | tr '\n' ' ' | cut -c1-60)"; fi

  # ── STABLE half (Face 19, Vane): a property of the COMMITS outlives a property of the diff.
  # These do not change when $BASE moves, so they are the only answers with no shelf life.
  mb=$(git merge-base "$BASE" "$b" 2>/dev/null)
  cdel=$(git log --diff-filter=D --oneline "$mb".."$b" 2>/dev/null | wc -l | tr -d ' ')
  lanes=$(git log --format= --name-only "$mb".."$b" 2>/dev/null | grep -v '^$' | cut -d/ -f1 | sort -u | tr '\n' ' ')
  [ "$cdel" = "0" ] && cv="commits: none delete · lanes: $lanes" \
                    || cv="commits: $cdel DELETE something · lanes: $lanes"

  # READER column — TRAP 4. What a successor who CHECKS OUT this branch actually sees. The
  # two-dot D-list is the WRONG instrument for a merge and the RIGHT one here: files on $BASE
  # absent from the branch's tree are exactly what a reader will not find. Verified against
  # ground truth (git cat-file -e) rather than assumed. Ferry hit this personally — a findings
  # file on a branch told successors to run tools that do not exist in the tree they are in.
  rd=$(git diff --name-status "$BASE" "$b" 2>/dev/null | awk '$1=="D"{print $2}')
  rdn=$(printf '%s' "$rd" | grep -c . || true)
  if [ "$rdn" = "0" ]; then rv="reader: sees all of $BASE"
  else rv="reader: MISSING $rdn file(s) present on $BASE"; fi

  if [ "$plus" = "0" ]; then
    verdict="ABSORBED — safe to delete"
    printf "%-26s %6s %6s  %s\n" "${b#origin/}" "$plus" "$behind" "$verdict"
  else
    ONLY_COPY=1
    printf "%-26s %6s %6s  %s\n" "${b#origin/}" "$plus" "$behind" "ONLY COPY — keep"
    printf "%-26s %6s %6s    STABLE  %s\n" "" "" "" "$cv"
    printf "%-26s %6s %6s    decays  %s\n" "" "" "" "$mv_"
    printf "%-26s %6s %6s    decays  %s\n" "" "" "" "$sv"
    printf "%-26s %6s %6s    decays  %s\n" "" "" "" "$rv"
  fi
done

echo
echo "STABLE lines are properties of the COMMITS and do not change when $BASE moves — the only"
echo "answers here with no shelf life (Face 19, Vane). Everything marked 'decays' is TIP-RELATIVE"
echo "and is false again as soon as anyone lands anything: those answers changed four times in"
echo "ninety minutes on one branch. RUN THIS AT THE MOMENT OF LANDING, NOT BEFORE REPORTING"
echo "READINESS — an owner cannot clear a branch in advance because the hazard is $BASE moving."
echo
echo "PRUNE verdict is the UNABS column alone: 0 = absorbed debris, N = the only copy."
echo "LANDING and READING are SEPARATE questions, and the three lines below answer three DIFFERENT ones."
echo "  merge  — computed with git merge-tree against the merge base. Safe, or it conflicts loudly."
echo "  squash — every A/M/D path is a candidate revert of main's version. THERE IS NO SAFETY RAIL;"
echo "           the listed paths must be checked by hand. This repo has 0 merges in 184 commits,"
echo "           so SQUASH IS THE COLUMN THAT MATCHES HOW WORK ACTUALLY LANDS HERE."
echo "  cherry-pick — NOT measured by the squash line. A cherry-pick replays commits, so its"
echo "           safety is the STABLE pair above: no commit deletes, and the lanes are known."
echo "  reader — what a successor who CHECKS OUT the branch sees. Files on main that are absent"
echo "           from its tree. This is the two-dot D-list: wrong for a merge, RIGHT here."
echo "Silence in the merge line is not a general clearance. 'Is the document right' and 'is the"
echo "branch safe to land, by the method you will actually use' are different questions."
exit "$ONLY_COPY"
