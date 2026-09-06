#!/usr/bin/env bash
# Wake only on terminal idle-measure states. No progress lines.
set -euo pipefail
EVID="${1:?evidence dir}"
LOG="$EVID/measure-idle-cost.run.log"
PID_FILE="$EVID/measure-idle-cost.pid"
AFTER="$EVID/state/after/counts.json"
HONESTY="$EVID/honesty/probe.txt"

pid=$(tr -d '[:space:]' < "$PID_FILE")
while :; do
  if grep -q 'did not become ready' "$LOG" 2>/dev/null; then
    echo "FAILED: listener did not become ready"
    tail -20 "$LOG"
    exit 1
  fi
  if grep -q 'functions serve did not become ready' "$LOG" 2>/dev/null; then
    echo "FAILED: functions serve did not become ready"
    exit 1
  fi
  if [ -f "$AFTER" ] && [ -f "$HONESTY" ] && grep -q ' done$' "$LOG"; then
    echo "DONE"
    exit 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    if [ -f "$AFTER" ] && [ -f "$HONESTY" ]; then
      echo "DONE"
      exit 0
    fi
    echo "FAILED: measure pid $pid exited before after counts + honesty"
    tail -30 "$LOG"
    exit 1
  fi
  sleep 30
done
