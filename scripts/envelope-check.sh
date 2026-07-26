#!/bin/bash
# Envelope gate — read before spawning anything. Any RED = reclaim first.
#
# Each condition has a FIXED denominator and measures something the others do not.
#
# NOT USED, and why:
#   swap utilisation %  — denominator is count(swapfile)*1GB, which macOS moves by a full GB
#                         inside a 12s window (Vane, measured). Changes faster than it is read.
#   raw disk free       — NOT independent of swap. The swapfiles ARE the disk: disk_free and
#                         swap_total are one quantity with the sign flipped (Vane). Measured
#                         across this session, components moved 9.0 GB and 7.2 GB while
#                         disk_free+swap_total held to 0.29 GB on unrounded readings.
#                         A raw-disk gate reports the swap excursion twice; it does not bound it.
#   pageout rate        — needs two samples, noisy. Level gates, not rate.
#   swap used, ABSOLUTE — REMOVED 2026-07-25 after Atlas caught it inheriting the very defect
#                         this gate replaced. `used` cannot exceed `total`, and `total` is
#                         count(swapfile)*1GB which macOS GROWS IN RESPONSE TO PRESSURE. So
#                         `used > 8192MB` was UNREACHABLE whenever total <= 8192 — the live
#                         state at the time of the fix (total 6144MB) — and became reachable
#                         only after macOS had already grown the file. It fired on the
#                         mitigation, not the pressure: the same shape as the ~12GB charter
#                         gate this replaced, one threshold lower. Replaced by memory-under-
#                         duress below, whose denominator is physical RAM and cannot move.
#
# ALWAYS df -k, never df -h: -h rounds to whole GB, and a sum of two rounded readings carries
# +/-1 GB — which is the entire apparent "slow disk decline" reported earlier tonight.
set -uo pipefail

# free% is an INTEGER with a ~1-point spread, so a threshold placed on a value the machine
# actually sits at makes the gate a coin: measured 25 rapid samples reading 34 or 35 against a
# 35% trip = 40% RED / 60% GREEN on an unchanged machine. Two fixes, both needed:
#   1. worst-of-3 — fails safe toward "do not spawn", kills the residual flap.
#   2. threshold moved 35 -> 30 — it now SEPARATES observed states (28-29% under real pressure
#      tonight, 34-36% marginal-but-working, 64% recovered) instead of bisecting the idle range.
FREE_PCT=$(for _ in 1 2 3; do memory_pressure 2>/dev/null | sed -n 's/.*free percentage: *\([0-9]*\)%.*/\1/p'; done | sort -n | head -1)
SWAP_USED_MB=$(sysctl -n vm.swapusage | sed -n 's/.*used = \([0-9.]*\)M.*/\1/p' | cut -d. -f1)
SWAP_TOTAL_MB=$(sysctl -n vm.swapusage | sed -n 's/.*total = \([0-9.]*\)M.*/\1/p' | cut -d. -f1)
# Memory under duress = compressed + swapped out, against PHYSICAL RAM (Ledger).
# >100% means the machine is holding more than its physical memory in duress storage.
# Session evidence: 119% and 112% at the two real excursions; 40-63% otherwise. It fires on
# pressure, which is what the absolute-MB arm could not do.
#
# ★ WORDING CORRECTED PER ATLAS, and the correction matters because the strong version is
# FALSIFIABLE ON A QUIET MACHINE. This arm is NOT "reachable at any swap_total" in the sense of
# having comfortable margin everywhere. The accurate claim is narrower: THE NUMERATOR IS NO
# LONGER BOUNDED BELOW THE TRIP. Its cap is compressor_max + swap_total, which still contains
# swap_total — the dependency on the moving bound is REDUCED, NOT REMOVED. At low swap totals,
# firing requires a compressor excursion larger than any observed this session (Atlas measured
# a ~75% practical ceiling at total 6144 MB, holding compressor constant, against a 100% trip).
# A successor who checks the strong claim on an idle machine finds ~71% and reasonably distrusts
# the arm. This is the same trap as the charter's "unreachable by construction": an overstated
# justification protects the defect it is defending against.
DURESS_PCT=$(awk -v c="$(sysctl -n vm.compressor_bytes_used)" -v s="$SWAP_USED_MB" \
  -v r="$(sysctl -n hw.memsize)" 'BEGIN{printf "%d", 100*(c + s*1048576)/r}')
# HARD ceiling for the arm above: compressor cannot exceed RAM and swap_used cannot exceed
# swap_total, so duress% <= 100*(RAM + swap_total)/RAM. Passed to chk() so the reachability
# assertion covers THIS arm too — the mechanism must watch the replacement, not just the
# thing it replaced. Measured now: 156% against a 100% trip, so the arm is genuinely reachable.
DURESS_MAX_PCT=$(awk -v r="$(sysctl -n hw.memsize)" -v st="$SWAP_TOTAL_MB" \
  'BEGIN{printf "%d", 100*(r + st*1048576)/r}')
SWAP_TOTAL_GB=$(sysctl -n vm.swapusage | sed -n 's/.*total = \([0-9.]*\)M.*/\1/p' | awk '{printf "%.1f", $1/1024}')
DISK_GB=$(df -k / | awk 'NR==2{printf "%.1f", $4/1048576}')
HEADROOM_GB=$(awk -v d="$DISK_GB" -v s="$SWAP_TOTAL_GB" 'BEGIN{printf "%d", d+s}')
COMPRESSOR_GB=$(sysctl -n vm.compressor_bytes_used | awk '{printf "%.1f", $1/1073741824}')
RAM_GB=$(sysctl -n hw.memsize | awk '{printf "%.0f", $1/1073741824}')

RED=0
VACUOUS=0
# The names of the arms that tripped, accumulated so the VERDICT can carry its own reason.
# WHY: on 2026-07-25 this gate returned a genuine RED that was never attributed, because the
# reader piped it to `tail -2` — which keeps the blank line and the verdict and discards both
# the three condition lines AND the diagnostic header. The finding survived; its reason did not,
# and a transient's reason cannot be re-measured. "Use the full output, not a tail" is a rule
# aimed at the memory of whoever runs this at 3am. Naming the arm in the verdict needs nobody to
# remember anything, and a `tail -1` still says what to reclaim. (Vane and Atlas, independently.)
RED_ARMS=""
# chk label value op threshold unit [attainable-bound]
#
# The 6th argument is the EXTREME the metric can reach IN THE TRIP DIRECTION — the max for a
# `gt` trip, the min for an `lt` one. When it is supplied, chk asserts the trip lies inside the
# attainable range and prints UNREACHABLE instead of GREEN when it does not.
#
# WHY THIS EXISTS: this gate is on its fifth defect and FOUR of the five were arms that could
# not fire — an absolute 12 GB trip against a dynamic swap total, a ratio whose denominator was
# the swapfile count on a shared disk, a threshold sitting inside the instrument's quantisation,
# and this one. Every time, the arm printed GREEN and the GREEN was not evidence. A gate that
# cannot fail is worse than no gate, because it is READ as a gate.
#
# So this is not another calibration. THE THRESHOLDS ARE UNCHANGED. It is the mechanism that
# makes the next miscalibration announce itself instead of being found by an agent an hour later.
chk() {
  if [ "$3" = "lt" ]; then [ "$2" -lt "$4" ] && s=RED || s=GREEN
  else [ "$2" -gt "$4" ] && s=RED || s=GREEN; fi
  [ "$s" = "RED" ] && { RED=1; RED_ARMS="${RED_ARMS:+$RED_ARMS, }$1"; }
  if [ -n "${6:-}" ]; then
    if { [ "$3" = "gt" ] && [ "$6" -le "$4" ]; } || { [ "$3" = "lt" ] && [ "$6" -ge "$4" ]; }; then
      s="UNREACHABLE"; VACUOUS=1
      printf "  %-27s %8s%-3s (trip: %s %s)  %s — cannot fire; %s is %s%s\n" \
        "$1" "$2" "$5" "$3" "$4$5" "$s" "$([ "$3" = gt ] && echo max || echo min)" "$6" "$5"
      return
    fi
  fi
  printf "  %-27s %8s%-3s (trip: %s %s)  %s\n" "$1" "$2" "$5" "$3" "$4$5" "$s"
}

echo "envelope: RAM ${RAM_GB}GB  compressor ${COMPRESSOR_GB}GB  swap_total ${SWAP_TOTAL_GB}GB  swap_used ${SWAP_USED_MB}MB  disk ${DISK_GB}GB   (diagnostics, not trips)"
chk "system free (worst of 3)"  "$FREE_PCT"     lt 30   "%"
chk "memory under duress"       "$DURESS_PCT"   gt 100  "%"  "$DURESS_MAX_PCT"
chk "swap headroom (disk+total)" "$HEADROOM_GB" lt 25   "GB"
echo
if [ "$RED" = 1 ]; then
  echo "RESULT: RED (${RED_ARMS}) — reclaim before spawning."
elif [ "$VACUOUS" = 1 ]; then
  # Deliberately NOT exit 1: a vacuous arm is not evidence of pressure, and a gate that blocks
  # every spawn until someone re-tunes it is a gate that gets ignored. The arms that CAN fire
  # are green; the point is that the count is smaller than it looks.
  echo "RESULT: GREEN on the arms that can fire — but at least one arm is UNREACHABLE and its"
  echo "        GREEN is NOT EVIDENCE. Safe to spawn on a narrower basis than this gate implies."
else
  echo "RESULT: GREEN — safe to spawn."
fi
exit "$RED"
