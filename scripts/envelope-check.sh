#!/bin/bash
# Envelope gate — read before spawning anything.
# Three trip conditions, each with a FIXED denominator. Any one RED = reclaim first.
# Deliberately does NOT use swap utilisation %: its denominator is count(swapfile)*1GB,
# which macOS changes by a full GB inside a 12-second window (Vane, measured).
set -uo pipefail

FREE_PCT=$(memory_pressure 2>/dev/null | sed -n 's/.*free percentage: *\([0-9]*\)%.*/\1/p')
SWAP_USED_MB=$(sysctl -n vm.swapusage | sed -n 's/.*used = \([0-9.]*\)M.*/\1/p' | cut -d. -f1)
DISK_GB=$(df -k / | awk 'NR==2{printf "%d", $4/1048576}')
COMPRESSOR_GB=$(sysctl -n vm.compressor_bytes_used | awk '{printf "%.1f", $1/1073741824}')
RAM_GB=$(sysctl -n hw.memsize | awk '{printf "%.0f", $1/1073741824}')

RED=0
chk() { # name value op threshold unit
  if [ "$3" = "lt" ]; then [ "$2" -lt "$4" ] && s=RED || s=GREEN
  else [ "$2" -gt "$4" ] && s=RED || s=GREEN; fi
  [ "$s" = RED ] && RED=1
  printf "  %-22s %6s %-3s  (trip: %s %s %s)  %s\n" "$1" "$2$5" "" "$3" "$4" "$5" "$s"
}

echo "envelope:  RAM ${RAM_GB}GB   compressor ${COMPRESSOR_GB}GB (diagnostic, not a trip)"
chk "system free"      "$FREE_PCT"     lt 35   "%"
chk "swap used"        "$SWAP_USED_MB" gt 8192 "MB"
chk "disk free"        "$DISK_GB"      lt 20   "GB"
echo
[ "$RED" = 1 ] && echo "RESULT: RED — reclaim before spawning." || echo "RESULT: GREEN — safe to spawn."
exit "$RED"
