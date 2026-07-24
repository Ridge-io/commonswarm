#!/usr/bin/env bash

set -euo pipefail

root="${UXTEST_HOME_ROOT:-$HOME/uxtest}"
tool="$(basename "$0")"
real_path_file="$root/product/REAL_$tool"
node_path_file="$root/product/NODE_BIN"
[ -f "$real_path_file" ] && [ -f "$node_path_file" ] || exit 127
real_path="$(<"$real_path_file")"
node_path="$(<"$node_path_file")"
case "$PWD" in
  "$root"/human1/workspace) role="human1" ;;
  "$root"/human2/workspace) role="human2" ;;
  *) role="${UXTEST_ROLE:-unknown}" ;;
esac
round="${UXTEST_ROUND:-}"
if [ -z "$round" ]; then
  current_round="$root/$role/current-round"
  [ -f "$current_round" ] && round="$(<"$current_round")"
fi
[ -n "$round" ] || round="unknown"
round="${round#r}"
violating=false
case "$role:$PWD" in
  human1:"$root"/human1/workspace|human2:"$root"/human2/workspace) ;;
  human1:*|human2:*) violating=true ;;
esac
for arg in "$@"; do
  case "$arg" in
    "$root"|"$root/bin"|"$root/bin/"*|"$root/product"|"$root/product/"*|\
    "$root/logs"|"$root/logs/"*|"$root/config"|"$root/config/"*|\
    "$root/.internal"|"$root/.internal/"*|"$root/human1"|"$root/human2")
      violating=true
      break
      ;;
  esac
  case "$arg" in
    -*|'') continue ;;
  esac
  if [ -e "$arg" ]; then
    if [ -d "$arg" ]; then
      resolved="$(cd "$arg" 2>/dev/null && pwd -P || true)"
    else
      resolved="$(cd "$(dirname "$arg")" 2>/dev/null &&
        printf '%s/%s' "$(pwd -P)" "$(basename "$arg")" || true)"
    fi
    case "$resolved" in
      "$root"|"$root/bin"|"$root/bin/"*|"$root/product"|"$root/product/"*|\
      "$root/logs"|"$root/logs/"*|"$root/config"|"$root/config/"*|\
      "$root/.internal"|"$root/.internal/"*|"$root/human1"|"$root/human2")
        violating=true
        break
        ;;
    esac
  fi
done
if [ "$violating" = true ]; then
  mkdir -p "$root/logs/r$round"
  "$node_path" - "$root/logs/r$round/isolation-events.jsonl" \
    "$tool" "$role" "$round" <<'NODE'
const fs = require("node:fs");
const [path, tool, role, round] = process.argv.slice(2);
fs.appendFileSync(path, `${JSON.stringify({
  at_ms: Date.now(),
  kind: "forbidden-path-read",
  tool,
  role,
  round,
})}\n`, { mode: 0o600 });
NODE
fi
exec "$real_path" "$@"
