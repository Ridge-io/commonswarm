#!/usr/bin/env bash

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "$0")" && pwd -P)/_lib.sh"

mode="${1:-}"
round="${2:-}"
[ -n "${CMUX_SURFACE_ID:-}" ] ||
  die "serve-human2-gui must run inside the laptop's GUI cmux session"

home_root="${UXTEST_HOME_ROOT:-$UXTEST_REMOTE_HOME_ROOT}"
case "$mode" in
  launcher)
    name="$UXTEST_LAUNCHER_NAME"
    swarm_name="$UXTEST_LAUNCHER_SWARM"
    port="$UXTEST_LAUNCHER_LAPTOP_PORT"
    state="$home_root/run/launcher-a2a-$port.json"
    pid_file="$home_root/run/launcher-a2a-$port.pid"
    log_file="$home_root/run/launcher-a2a-$port.log"
    ;;
  round)
    validate_round "$round"
    name="$(human2_name "$round")"
    swarm_name="$(round_swarm "$round")"
    port=18790
    state="$home_root/run/round-a2a-$port.json"
    pid_file="$home_root/run/a2a-$port.pid"
    log_file="$home_root/run/a2a-$port.log"
    ;;
  *)
    die "serve-human2-gui mode must be launcher or round"
    ;;
esac

require_command curl
require_command node
[ -x "$UXTEST_REMOTE_SWARM_BIN" ] ||
  die "laptop swarm binary is unavailable"
mkdir -p "$home_root/run"
chmod 700 "$home_root/run"

members="$("$UXTEST_REMOTE_SWARM_BIN" members --swarm "$swarm_name")"
printf '%s\n' "$members" | grep -Fq "$name [" ||
  die "$name is not joined to $swarm_name"

url="http://$UXTEST_LAPTOP_IP:$port"
current="$(a2a_card_name "$url" || true)"
if [ "$current" = "$name" ] && [ -f "$state" ] && [ -f "$pid_file" ]; then
  existing_pid="$(<"$pid_file")"
  case "$existing_pid" in *[!0-9]*|'') die "invalid GUI A2A PID file" ;; esac
  if kill -0 "$existing_pid" 2>/dev/null &&
    node -e '
      const fs = require("node:fs");
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (
        value.origin !== "gui-cmux" ||
        value.name !== process.argv[2] ||
        value.swarm !== process.argv[3] ||
        value.bind !== process.argv[4] ||
        value.port !== Number(process.argv[5]) ||
        value.surface_id !== process.argv[6] ||
        value.pid !== Number(process.argv[7])
      ) process.exit(1);
    ' "$state" "$name" "$swarm_name" "$UXTEST_LAPTOP_IP" \
      "$port" "$CMUX_SURFACE_ID" "$existing_pid"; then
    say "GUI-origin A2A endpoint already serves $name on $url."
    exit 0
  fi
fi

if [ -n "$current" ]; then
  [ -f "$pid_file" ] ||
    die "port $port serves '$current' without a harness PID; stop it explicitly before GUI bootstrap"
  old_pid="$(<"$pid_file")"
  case "$old_pid" in *[!0-9]*|'') die "invalid GUI A2A PID file" ;; esac
  kill -0 "$old_pid" 2>/dev/null ||
    die "port $port is live but its recorded harness PID is not"
  kill "$old_pid"
  for _ in 1 2 3 4 5; do
    kill -0 "$old_pid" 2>/dev/null || break
    sleep 1
  done
  kill -0 "$old_pid" 2>/dev/null &&
    die "prior laptop A2A server did not stop"
fi

nohup "$UXTEST_REMOTE_SWARM_BIN" serve \
  --name "$name" \
  --swarm "$swarm_name" \
  --port "$port" \
  --bind "$UXTEST_LAPTOP_IP" \
  --advertise-host "$UXTEST_LAPTOP_IP" \
  --description "GUI-origin uxtest endpoint for $name" \
  >"$log_file" 2>&1 </dev/null &
pid="$!"
printf '%s\n' "$pid" >"$pid_file"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ "$(a2a_card_name "$url" || true)" = "$name" ] && break
  sleep 1
done
[ "$(a2a_card_name "$url" || true)" = "$name" ] ||
  die "GUI-origin A2A server failed; see $log_file"

node - "$state" "$name" "$swarm_name" "$UXTEST_LAPTOP_IP" \
  "$port" "$CMUX_SURFACE_ID" "${CMUX_WORKSPACE_ID:-}" "$pid" <<'NODE'
const fs = require("node:fs");
const [path, name, swarm, bind, portRaw, surfaceId, workspaceId, pidRaw] =
  process.argv.slice(2);
const value = {
  origin: "gui-cmux",
  name,
  swarm,
  bind,
  port: Number(portRaw),
  surface_id: surfaceId,
  workspace_id: workspaceId || null,
  pid: Number(pidRaw),
  started_at: new Date().toISOString(),
};
fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
NODE
say "GUI-origin A2A endpoint verified for $name on $url."
