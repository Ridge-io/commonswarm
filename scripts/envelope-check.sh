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
# The CEILING for swap used. `used` can never exceed `total`, and macOS moves `total` by a whole
# GB while you read it — so an ABSOLUTE trip on `used` is reachable or not depending on the
# swapfile count at the moment of reading. Measured three times in one evening at a fixed 8192
# trip: total 8192 (trip == ceiling, unreachable), total 9216 (reachable), total 6144
# (unreachable by 2048 MB). This value exists to let chk() detect that, not to gate anything.
SWAP_TOTAL_MB=$(sysctl -n vm.swapusage | sed -n 's/.*total = \([0-9.]*\)M.*/\1/p' | cut -d. -f1)
SWAP_TOTAL_GB=$(sysctl -n vm.swapusage | sed -n 's/.*total = \([0-9.]*\)M.*/\1/p' | awk '{printf "%.1f", $1/1024}')
DISK_GB=$(df -k / | awk 'NR==2{printf "%.1f", $4/1048576}')
HEADROOM_GB=$(awk -v d="$DISK_GB" -v s="$SWAP_TOTAL_GB" 'BEGIN{printf "%d", d+s}')
COMPRESSOR_GB=$(sysctl -n vm.compressor_bytes_used | awk '{printf "%.1f", $1/1073741824}')
RAM_GB=$(sysctl -n hw.memsize | awk '{printf "%.0f", $1/1073741824}')

RED=0
VACUOUS=0
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
  [ "$s" = "RED" ] && RED=1
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

echo "envelope: RAM ${RAM_GB}GB  compressor ${COMPRESSOR_GB}GB  swap_total ${SWAP_TOTAL_GB}GB  disk ${DISK_GB}GB   (diagnostics, not trips)"
chk "system free (worst of 3)"  "$FREE_PCT"     lt 30   "%"
chk "swap used (absolute)"      "$SWAP_USED_MB" gt 8192 "MB" "$SWAP_TOTAL_MB"
chk "swap headroom (disk+total)" "$HEADROOM_GB" lt 25   "GB"
echo
if [ "$RED" = 1 ]; then
  echo "RESULT: RED — reclaim before spawning."
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
