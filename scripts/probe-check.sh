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
# This script cannot check any of that for you. It enforces only that SOMETHING came back, which
# closes the vacuous half and not the wrong-object half: a control can be reached and still
# measure the wrong thing. Bound stated by Ledger, whose mechanism this is.
set -uo pipefail

[ $# -eq 2 ] || { echo "usage: probe-check.sh \"<positive-control-cmd>\" \"<subject-cmd>\"" >&2; exit 64; }
CONTROL=$1
SUBJECT=$2

control_out=$(eval "$CONTROL" 2>/dev/null)
if [ -z "$control_out" ]; then
  echo "VACUOUS — the positive control returned nothing."
  echo "  control: $CONTROL"
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
