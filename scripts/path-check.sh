#!/bin/bash
# path-check — prove your instrument was actually in the subject's path before trusting what it said.
#
#   path-check.sh <tool-name> "<subject-cmd>"
#
#   exit 0  IN PATH      the subject invoked <tool-name> through PATH, so a shim of it is reached
#   exit 1  NOT IN PATH  the subject never resolved <tool-name> through PATH — a shim would be
#                        BYPASSED, and any measurement taken through one is of the real system
#
# ── WHY THIS IS A SEPARATE QUESTION FROM probe-check.sh ──────────────────────────────────────
# `probe-check.sh` asks CAN THIS PROBE PRODUCE A HIT — a positive control, run first, refusing to
# report the subject if the control comes back empty. It closes the vacuous-probe class.
#
# It does not close this one. A probe can be perfectly capable of hitting and still never have
# been consulted. Concretely, from 2026-07-25: three gate cases were "verified" through a PATH
# shim for `sysctl`. Had the gate called `/usr/sbin/sysctl` by absolute path, the shim would
# never have been invoked — and a POSITIVE CONTROL ROUTED THROUGH THAT SHIM WOULD HAVE RETURNED
# THE REAL SYSTEM'S VALUES, which look exactly like a legitimate hit. Control passes, you
# conclude your instrument works, and it was never in the path at all.
#
#   probe-check  proves the probe CAN hit.
#   path-check   proves the probe is WHAT HIT.
#
# Same night, two classes, both real: a SIP-protected `/bin/sleep` control is the first;
# an absolute-path call bypassing a PATH shim is the second.
#
# ── HOW ──────────────────────────────────────────────────────────────────────────────────────
# Put a deliberately-failing <tool-name> first on PATH, run the subject, and look for its marker.
# NOTHING is inferred from the subject's own exit status or output — a subject that swallows
# errors, or one that never needed the tool, both look identical from outside. Only the marker
# proves the shim was entered.
#
# ── WHAT THIS DOES NOT PROVE, and it is the same bound as probe-check's ───────────────────────
# It proves the instrument was REACHED. It does not prove it covers the right subset: on
# 2026-07-25 a reached `sysctl` shim still left `memory_pressure` and `df` running live, so one
# gate arm varied and two were merely observed — reported as three cases. REACHABILITY AND
# COVERAGE ARE SEPARATE QUESTIONS. Run this once per tool you intend to shim, not once per test.
set -uo pipefail

[ $# -eq 2 ] || { echo "usage: path-check.sh <tool-name> \"<subject-cmd>\"" >&2; exit 64; }
TOOL=$1
SUBJECT=$2
MARKER="PATHCHECK_${TOOL}_REACHED_$$"

SHIMDIR=$(mktemp -d) || exit 70
trap 'rm -rf "$SHIMDIR"' EXIT
printf '#!/bin/bash\necho "%s" >&2\nexit 7\n' "$MARKER" > "$SHIMDIR/$TOOL"
chmod +x "$SHIMDIR/$TOOL"

# stderr is what we read; the subject's own stdout/exit are deliberately ignored.
subject_err=$(PATH="$SHIMDIR:$PATH" eval "$SUBJECT" 2>&1 >/dev/null)

if printf '%s' "$subject_err" | grep -q "$MARKER"; then
  hits=$(printf '%s\n' "$subject_err" | grep -c "$MARKER")
  echo "IN PATH — subject invoked '$TOOL' through PATH ($hits time(s)); a shim of it is reached."
  echo "  Reachability only. It does not follow that shimming '$TOOL' covers everything you vary."
  exit 0
fi
echo "NOT IN PATH — subject never resolved '$TOOL' through PATH."
echo "  subject: $SUBJECT"
echo "  A shim of '$TOOL' would be BYPASSED. Any measurement you took through one was of the"
echo "  real system, and a positive control run through it would have looked like a hit."
exit 1
