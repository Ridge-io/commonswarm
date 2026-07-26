#!/bin/bash
# probe-check — refuse to report a probe result until the probe has been shown able to return a hit.
#
#   probe-check.sh "<positive-control-cmd>" "<subject-cmd>"
#
# Runs the POSITIVE CONTROL FIRST. The control must be a case that MUST produce a hit — a subject
# you constructed to contain the thing you are looking for. If it produces nothing, the probe
# cannot distinguish "absent" from "unmeasurable", and the subject's result is DISCARDED rather
# than reported.
#
#   exit 0  HIT       subject produced output, and the probe was proven able to
#   exit 1  CLEAN     subject produced nothing, and the probe was proven able to produce something
#   exit 2  VACUOUS   the control produced nothing. NO CONCLUSION ABOUT THE SUBJECT IS AVAILABLE.
#
# ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
# 2026-07-25. Five defects in one gate and seven failed measurements in one investigation shared
# a single shape: AN INSTRUMENT WHOSE NEGATIVE ANSWER WAS FIXED BEFORE THE MEASUREMENT BEGAN.
#
#   gates  failed on UNREACHABLE THRESHOLDS  -> `swap used > 8192MB` when used <= total = 6144
#   probes failed on UNREADABLE SUBJECTS     -> `ps -Ewwp` on a SIP-protected /bin binary: 0 tokens
#   probes failed on FILTERED INPUT          -> grep -E dropped the PATH fragment being searched for
#   probes failed on DEAD SUBJECTS           -> an unsigned `cp` of /bin/sleep, killed by macOS
#
# EVERY ONE RETURNED A CLEAN ZERO, and a clean zero is indistinguishable from a real negative at
# the output. Five seats ran one such probe and all five reported 0; the agreement was
# manufactured by the instrument. Two hosts agreed once — that was one defect run twice.
#
# The gate half of this got a mechanism the same night (`envelope-check.sh` asserts each trip lies
# inside its metric's attainable range and prints UNREACHABLE instead of GREEN). THIS IS THE
# CONTROL HALF. Same sentence, two domains: a bound is only as good as what caps it; a control is
# only valid for the class of subject it was run against.
#
# ── CHOOSING THE CONTROL, WHICH IS THE ENTIRE DIFFICULTY ─────────────────────────────────────
# The control must match the SUBJECT'S CLASS, not merely the question. Three real failures:
#   - `/bin/sleep` as a stand-in for a `claude` process: SIP withholds env from platform binaries,
#     so the control answers NO on a host where the answer is YES.
#   - a control hardened three times — env -i, then a plain child, then an own shell — each fixing
#     a real confound and each still a platform binary. RIGOUR ON THE WRONG AXIS IS CONFIDENCE
#     WITH NO COVERAGE. "I controlled for that" is not an answer to "what class was the subject?"
#   - `HOME=1` as a hit test: satisfiable by other text in the row. THE STRONG FORM IS A MARKER
#     YOU SET YOURSELF AND READ BACK — only that proves a TRUE positive rather than a coincidence.
#
# This script cannot check any of that for you. It enforces only that a genuine hit came back,
# which closes the vacuous half and not the wrong-object half: a control can be reached and still
# measure the wrong thing. That bound is Ledger's.
#
# ── ATTRIBUTION, AND IT IS LOAD-BEARING RATHER THAN POLITE ───────────────────────────────────
# THE MECHANISM HERE IS NOT LEDGER'S. It is positive-control-first — Lead6's old-string control
# from the tree grep, plus Atlas's marker form, generalised. Ledger stated the BOUND and declined
# the mechanism credit, and the distinction covers a case THIS SCRIPT CANNOT SEE:
#
#   POSITIVE CONTROL (here)   proves the probe CAN produce a hit.
#   FAIL-LOUDLY (Ledger's)    proves the probe IS WHAT PRODUCED IT.
#
# Ledger's form: substitute a deliberately-erroring instrument and confirm the SUBJECT reacts.
# The failure it catches and this one does not: if the script under test calls /usr/sbin/sysctl
# by ABSOLUTE PATH, a PATH shim is never invoked — and a positive control "routed through" that
# shim returns the real system's values, which look exactly like a legitimate hit. The control
# passes, you conclude your instrument works, and IT WAS NEVER IN THE PATH AT ALL. Ledger ran the
# fail-loudly form for precisely this reason and got SHIM-WAS-REACHED four times; no positive
# control would have told it that.
#
# TONIGHT PRODUCED INSTANCES OF BOTH: the SIP-protected /bin/sleep is the first class, an
# unreached PATH shim is the second. TWO MECHANISMS, ONE BUILT. The second is four lines and is
# not here. ★ This note exists because a successor would otherwise read Ledger's name, run this
# script, and believe the fail-loudly check is covered. It is not — a caveat lost in transit, in
# the file written to stop caveats being lost in transit.
#
# ── BUT FOR THE COMMONEST CASE THERE IS AN EXECUTABLE TELL (Pitch) ───────────────────────────
# Do not TRY TO REMEMBER which binaries macOS protects. CHECK. The SIP restriction is visible in
# the file flags, before you run anything:
#
#     ls -lO <binary> | awk '{print $5}'      # 5th field is the flags column
#
# Verified on this machine, and it predicts env-readability exactly — both directions:
#
#     /bin/sleep    restricted,compressed  ->  ps -Ewwp env tokens:  0
#     /bin/zsh      restricted,compressed  ->  (same class — the "own shell" control that failed)
#     /usr/bin/env  restricted,compressed  ->  0
#     node          -                      ->  82
#     claude        -                      ->  82
#
# ★ THIS SUPERSEDES THE RULE "use a claude process", and the reason is the whole point of this
# file: that rule is addressed to a reader who already understands the trap, and has to be
# recalled while doing something else. Tonight the recall failed every time it was tried —
# one agent hardened a control three times without leaving the defect, another re-derived a fact
# it had itself written down ninety minutes earlier. A FLAG YOU CAN READ IS NOT A RULE YOU HAVE
# TO REMEMBER, and it answers for binaries nobody has tested.
set -uo pipefail

[ $# -eq 2 ] || { echo "usage: probe-check.sh \"<positive-control-cmd>\" \"<subject-cmd>\"" >&2; exit 64; }
CONTROL=$1
SUBJECT=$2

# A control has to SAY something AND SUCCEED. Testing output alone was a real defect in the
# first version of this script, found by Pitch, and it was the worst possible one:
#
#     grep -c 'HOME=' on a SIP subject  ->  stdout "0", exit 1   <- NON-EMPTY. Passed as live.
#     grep -o 'HOME=' on a SIP subject  ->  stdout "",  exit 1   <- empty. Correctly rejected.
#
# `grep -c` ALWAYS writes a line, so an emptiness test can never fail against it — and `grep -c`
# is the exact form of the vacuous check five seats ran tonight, and the form this file's own
# header holds up as the canonical example. THE TOOL INHERITED THE DEFECT OF THE THING IT WAS
# BUILT TO CATCH, which is the fourth time in one evening a fix has carried the defect it fixed.
# So the reader most likely to be saved by this script — someone reaching for `grep -c` because
# that is what the write-up talks about — was the one reader it silently failed.
#
# Three conditions now, and the exit status is the one that catches counting commands:
CONTROL_OUT=$(eval "$CONTROL" 2>/dev/null); CONTROL_RC=$?
control_out=$CONTROL_OUT
control_trimmed=$(printf '%s' "$control_out" | tr -d '[:space:]')
if [ -z "$control_out" ] || [ "$CONTROL_RC" -ne 0 ] || [ "$control_trimmed" = "0" ]; then
  echo "VACUOUS — the positive control did not come back with a genuine hit."
  echo "  control: $CONTROL"
  [ -z "$control_out" ]        && echo "  reason:  produced no output"
  [ "$CONTROL_RC" -ne 0 ]      && echo "  reason:  exited $CONTROL_RC (a counting command still PRINTS on no match — 'grep -c' writes 0)"
  [ "$control_trimmed" = "0" ] && echo "  reason:  output was a bare zero, which is a count of nothing, not a hit"
  echo "  The probe has not been shown able to return a hit, so it cannot tell ABSENT from"
  echo "  UNMEASURABLE. The subject was not run. No conclusion is available."
  exit 2
fi

subject_out=$(eval "$SUBJECT" 2>/dev/null)
# printf '%s\n' not '%s': wc -l counts NEWLINES, so a single line with no trailing newline
# counts 0. Reporting "0 line(s)" beside a successful hit is a wrong number in the one place
# this script exists to make numbers trustworthy.
echo "control returned a hit ($(printf '%s\n' "$control_out" | wc -l | tr -d ' ') line(s)) — probe is live"
if [ -n "$subject_out" ]; then
  echo "HIT — subject matched:"
  printf '%s\n' "$subject_out" | sed 's/^/    /'
  exit 0
fi
echo "CLEAN — subject produced nothing, and the probe was proven able to produce something."
exit 1
