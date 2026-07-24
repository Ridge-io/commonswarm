#!/usr/bin/env bash

set -uo pipefail

root="${UXTEST_HOME_ROOT:-$HOME/uxtest}"
real_cli="$root/product/dist/cli.js"
node_bin="$root/product/NODE_BIN"

[ -x "$real_cli" ] || {
  printf 'uxtest launcher: copied coswarm build is missing: %s\n' "$real_cli" >&2
  exit 127
}
[ -f "$node_bin" ] || {
  printf 'uxtest launcher: copied coswarm Node path is missing\n' >&2
  exit 127
}
node_path="$(<"$node_bin")"
[ -x "$node_path" ] || {
  printf 'uxtest launcher: recorded Node binary is unavailable: %s\n' "$node_path" >&2
  exit 127
}
redacting_tee="$root/.internal/stream.mjs"
[ -f "$redacting_tee" ] || {
  printf 'uxtest launcher: redacting output helper is missing\n' >&2
  exit 127
}

case "$PWD" in
  "$root"/human1/r*) role="human1" ;;
  "$root"/human2/r*) role="human2" ;;
  *) role="${UXTEST_ROLE:-unknown}" ;;
esac
round="${UXTEST_ROUND:-$(basename "$PWD")}"
round="${round#r}"
case "$round" in
  ''|*[!0-9]*) round="unknown" ;;
esac

log_dir="$root/logs/r$round"
mkdir -p "$log_dir/tmp"
chmod 700 "$root/logs" "$log_dir" "$log_dir/tmp" 2>/dev/null || true
tmp_base="$log_dir/tmp/$$.$RANDOM"
out_pipe="$tmp_base.out.pipe"
err_pipe="$tmp_base.err.pipe"
out_file="$tmp_base.out"
err_file="$tmp_base.err"
mkfifo "$out_pipe" "$err_pipe"
: >"$out_file"
: >"$err_file"
chmod 600 "$out_file" "$err_file"

"$node_path" "$redacting_tee" "$out_file" stdout <"$out_pipe" &
out_tee=$!
"$node_path" "$redacting_tee" "$err_file" stderr <"$err_pipe" &
err_tee=$!

started_ms="$("$node_path" -e 'process.stdout.write(String(Date.now()))')"
"$node_path" "$real_cli" "$@" >"$out_pipe" 2>"$err_pipe"
status=$?
ended_ms="$("$node_path" -e 'process.stdout.write(String(Date.now()))')"
wait "$out_tee" "$err_tee"
rm -f "$out_pipe" "$err_pipe"

first="${1:-help}"
command_shape="$first"
help=false
accept_attempt=false
used_link_stdin=false
used_positional_link=false
for arg in "$@"; do
  case "$arg" in
    --help|-h|help) help=true ;;
    --link-stdin) used_link_stdin=true ;;
    coswarm://accept/*) used_positional_link=true ;;
  esac
done
[ "$first" = "accept" ] && accept_attempt=true

"$node_path" --input-type=module - "$log_dir/$role.jsonl" \
  "$out_file" "$err_file" "$started_ms" "$ended_ms" "$status" "$role" \
  "$round" "$command_shape" "$help" "$accept_attempt" "$used_link_stdin" \
  "$used_positional_link" <<'NODE'
import { appendFileSync, readFileSync, rmSync } from "node:fs";

const [
  logPath, outPath, errPath, started, ended, status, role, round,
  command, help, acceptAttempt, linkStdin, positionalLink,
] = process.argv.slice(2);
const stdout = readFileSync(outPath, "utf8").slice(-20_000);
const stderr = readFileSync(errPath, "utf8").slice(-20_000);
const event = {
  started_at_ms: Number(started),
  ended_at_ms: Number(ended),
  duration_ms: Number(ended) - Number(started),
  role,
  round: /^\d+$/.test(round) ? Number(round) : round,
  command,
  exit_code: Number(status),
  help: help === "true",
  accept_attempt: acceptAttempt === "true",
  used_link_stdin: linkStdin === "true",
  used_positional_link: positionalLink === "true",
  stdout,
  stderr,
};
appendFileSync(logPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
rmSync(outPath, { force: true });
rmSync(errPath, { force: true });
NODE

exit "$status"
