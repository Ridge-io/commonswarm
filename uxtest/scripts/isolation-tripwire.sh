#!/usr/bin/env bash

set -euo pipefail

root="${UXTEST_HOME_ROOT:-$HOME/uxtest}"
tool="$(basename "$0")"
real_path_file="$root/product/REAL_$tool"
node_path_file="$root/product/NODE_BIN"
[ -f "$real_path_file" ] && [ -f "$node_path_file" ] || exit 127
real_path="$(<"$real_path_file")"
node_path="$(<"$node_path_file")"
round="${UXTEST_ROUND:-$(basename "$PWD" | sed -n 's/^r//p')}"
role="${UXTEST_ROLE:-unknown}"
mkdir -p "$root/logs/r$round"
"$node_path" - "$root/logs/r$round/isolation-events.jsonl" \
  "$tool" "$role" "$round" <<'NODE'
const fs = require("node:fs");
const [path, tool, role, round] = process.argv.slice(2);
fs.appendFileSync(path, `${JSON.stringify({
  at_ms: Date.now(),
  kind: "inspection-capable-tool",
  tool,
  role,
  round,
})}\n`, { mode: 0o600 });
NODE
exec "$real_path" "$@"
