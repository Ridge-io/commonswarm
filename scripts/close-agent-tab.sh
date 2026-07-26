#!/bin/sh
# Close a departed agent's cmux tab and free its memory.
#
# WHY THIS EXISTS: `swarm leave` deregisters an agent from the swarm and DOES NOT close its
# cmux tab. The tab keeps running and keeps its memory. Operators have hit this repeatedly:
# a Lead tells the fleet to stand down, every seat leaves cleanly, the roster looks empty,
# and the machine is exactly as loaded as before. The registry is not the resource.
#
# `cmux tab-action --action close` does NOT work — "close" is not a valid action name, and
# neither are close-tab/closeTab/kill/remove/destroy/quit/terminate (all probed). What works
# is terminating the tab's login session.
#
# Usage:   scripts/close-agent-tab.sh <AgentName> [AgentName...]
#          scripts/close-agent-tab.sh --departed        # every tab with no swarm registration
set -eu
CMUX=/Applications/cmux.app/Contents/Resources/bin/cmux
[ -x "$CMUX" ] || { echo "cmux CLI not found at $CMUX" >&2; exit 1; }
MY_TTY=$(ps -o tty= -p $$ 2>/dev/null | tr -d ' ')

close_one() {
  name=$1
  line=$($CMUX tree 2>/dev/null | grep "\"[^\"]*/$name\"" | head -1) || true
  [ -n "$line" ] || { echo "  $name: no tab found"; return 0; }
  tty=$(printf '%s' "$line" | sed -n 's/.*tty=\([a-z0-9]*\).*/\1/p')
  [ -n "$tty" ] || { echo "  $name: tab found but no tty"; return 0; }
  [ "$tty" = "$MY_TTY" ] && { echo "  $name: THAT IS THIS TAB — refusing"; return 0; }
  # graceful: the agent process, then the login session that owns the tab
  for p in $(ps -t "$tty" -o pid=,comm= 2>/dev/null | grep -E 'claude|codex|node|grok' | awk '{print $1}'); do
    kill -TERM "$p" 2>/dev/null || true
  done
  sleep 1
  for p in $(ps -t "$tty" -o pid= -o comm= 2>/dev/null | grep '/usr/bin/login' | awk '{print $1}'); do
    kill -TERM "$p" 2>/dev/null || true
  done
  sleep 1
  if $CMUX tree 2>/dev/null | grep -q "tty=$tty"; then
    echo "  $name ($tty): STILL OPEN — check manually"
  else
    echo "  $name ($tty): closed"
  fi
}

if [ "${1:-}" = "--departed" ]; then
  registered=$(swarm members 2>/dev/null | grep -oE '^  [A-Za-z0-9_-]+' | tr -d ' ' || true)
  $CMUX tree 2>/dev/null | grep -oE '"[^"]*/[A-Za-z0-9_-]+"' | sed 's|.*/||; s|"||' | sort -u |
  while read -r n; do
    printf '%s\n' "$registered" | grep -qx "$n" || close_one "$n"
  done
else
  [ $# -gt 0 ] || { echo "usage: $0 <AgentName>... | --departed" >&2; exit 2; }
  for n in "$@"; do close_one "$n"; done
fi
