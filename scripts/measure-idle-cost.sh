#!/usr/bin/env bash
# L7: idle cost before (v0.1.57, 15s/60s poll) and after (v0.1.58, push), plus
# status-honesty greps. Prints the §8 table rows for measurements 1, 2, and 7.
#
# Needs: local Supabase up, `supabase functions serve` logging to
# $EVIDENCE/serve.log (this script starts it if the pid file is stale), and a
# seeded fixture from harness/seed-local.mjs (this script runs that too).
#
# Cadence note (must stay in every write-up of these numbers): "before" is the
# L0 15 s idle poll with empty-poll backoff to 60 s, not the retired 2 s poll.
# L0/L1 already made empty claims persist nothing, so row counts are not the
# old 167 audit + 167 idempotency prediction.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVIDENCE="${EVIDENCE:-$ROOT/docs/evidence/2026-09-06-push-delivery-measured}"
WINDOW_SEC="${WINDOW_SEC:-600}"
SETTLE_SEC="${SETTLE_SEC:-30}"
READY_TIMEOUT_SEC="${READY_TIMEOUT_SEC:-90}"
BEFORE_BIN="${BEFORE_BIN:-$EVIDENCE/bin/v0.1.57/cswarm}"
AFTER_BIN="${AFTER_BIN:-$EVIDENCE/bin/v0.1.58/cswarm}"
AFTER_LABEL="${AFTER_LABEL:-after}"
TOKEN_KEY="${TOKEN_KEY:-listener_token1}"
SKIP_BEFORE="${SKIP_BEFORE:-0}"
FAKE_GROK="${FAKE_GROK:-$EVIDENCE/harness/fake-grok.mjs}"
SERVE_ENV="$EVIDENCE/serve.env"
SERVE_LOG="$EVIDENCE/serve.log"
SERVE_PID_FILE="$EVIDENCE/serve.pid"
FIXTURE="$EVIDENCE/fixture.json"
PROBE_CHECK="$ROOT/scripts/probe-check.sh"

utc_now() {
  python3 -c 'from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z")'
}

log() { printf '%s %s\n' "$(utc_now)" "$*"; }

need_file() {
  local path=$1
  [ -f "$path" ] || { echo "missing $path" >&2; exit 1; }
}

json_field() {
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d[sys.argv[2]])' "$1" "$2"
}

nested_field() {
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); cur=d
for k in sys.argv[2:]:
    cur = (cur or {}).get(k) if isinstance(cur, dict) else None
print("" if cur is None else cur)' "$@"
}

ensure_serve() {
  mkdir -p "$EVIDENCE"
  if [ ! -f "$SERVE_ENV" ]; then
    printf 'SWARM_ENV=test\nSWARM_SELF_SERVE=1\n' > "$SERVE_ENV"
  fi
  local alive=0
  if [ -f "$SERVE_PID_FILE" ]; then
    local pid
    pid=$(tr -d '[:space:]' < "$SERVE_PID_FILE")
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      alive=1
    fi
  fi
  if [ "$alive" -eq 0 ]; then
    log "starting supabase functions serve"
    (
      cd "$ROOT"
      nohup supabase functions serve --no-verify-jwt --env-file "$SERVE_ENV" >> "$SERVE_LOG" 2>&1 &
      echo $! > "$SERVE_PID_FILE"
    )
  fi
  local deadline=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if grep -q 'Serving functions on' "$SERVE_LOG" 2>/dev/null; then
      local body
      body=$(curl -sS -X POST http://127.0.0.1:54321/functions/v1/read \
        -H 'content-type: application/json' -d '{}' || true)
      printf '%s' "$body" | grep -q 'unauthenticated' && return 0
    fi
    sleep 1
  done
  echo "functions serve did not become ready; last log:" >&2
  tail -40 "$SERVE_LOG" >&2
  exit 1
}

ensure_seed() {
  if [ -f "$FIXTURE" ]; then
    log "using existing fixture $FIXTURE"
    return 0
  fi
  log "seeding local stack"
  (cd "$ROOT" && node "$EVIDENCE/harness/seed-local.mjs")
  need_file "$FIXTURE"
}

count_fn() {
  local log=$1 fn=$2 from_line=$3 to_line=$4
  sed -n "${from_line},${to_line}p" "$log" | grep -c "serving the request with supabase/functions/${fn}" || true
}

db_counts() {
  local start=$1 end=$2 principal=$3
  docker exec supabase_db_cloud-swarm psql -U postgres -d postgres -At -F $'\t' -c "
    SELECT
      (SELECT count(*) FROM swarm.audit_log
        WHERE occurred_at >= '${start}'::timestamptz
          AND occurred_at < '${end}'::timestamptz
          AND actor_agent_principal = '${principal}'::uuid) AS audit,
      (SELECT count(*) FROM swarm.idempotency_keys
        WHERE created_at >= '${start}'::timestamptz
          AND created_at < '${end}'::timestamptz
          AND principal_id = '${principal}') AS idem,
      (SELECT count(*) FROM swarm.rate_buckets
        WHERE window_start >= date_trunc('minute', '${start}'::timestamptz)
          AND window_start < '${end}'::timestamptz
          AND bucket_key LIKE '%${principal}%') AS rate;
  "
}

log_line_count() {
  wc -l < "$SERVE_LOG" | tr -d ' '
}

listen_status() {
  local bin=$1 statedir=$2 token_file=$3 workspace=$4 url=$5 anon=$6
  "$bin" listen status \
    --agent-token-file "$token_file" \
    --url "$url" \
    --anon-key "$anon" \
    --workspace-id "$workspace" \
    --state-dir "$statedir" \
    --json
}

listen_stop() {
  local bin=$1 statedir=$2 token_file=$3 workspace=$4 url=$5 anon=$6
  "$bin" listen stop \
    --agent-token-file "$token_file" \
    --url "$url" \
    --anon-key "$anon" \
    --workspace-id "$workspace" \
    --state-dir "$statedir" \
    --json || true
}

wait_ready() {
  local bin=$1 statedir=$2 token_file=$3 workspace=$4 url=$5 anon=$6 want_push=$7
  local deadline=$((SECONDS + READY_TIMEOUT_SEC))
  local last=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    if last=$(listen_status "$bin" "$statedir" "$token_file" "$workspace" "$url" "$anon" 2>/dev/null); then
      printf '%s\n' "$last" > "$statedir/last-status.json"
      local state mode
      state=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("state",""))' <<<"$last")
      mode=$(python3 -c 'import json,sys; d=json.load(sys.stdin); w=d.get("wake") or {}; print(w.get("mode") or d.get("mode") or "")' <<<"$last")
      if [ "$state" = "ready" ]; then
        if [ "$want_push" = "1" ] && [ "$mode" != "push" ]; then
          sleep 1
          continue
        fi
        return 0
      fi
    fi
    sleep 1
  done
  echo "listener did not become ready (want_push=$want_push). last status:" >&2
  cat "$statedir/last-status.json" >&2 || true
  return 1
}

run_idle_window() {
  local label=$1 bin=$2 want_push=$3
  local workspace url anon principal token_file
  workspace=$(json_field "$FIXTURE" workspace_id)
  url=$(json_field "$FIXTURE" api_url)
  anon=$(json_field "$FIXTURE" anon_key)
  principal=$(json_field "$FIXTURE" listener_principal_id)
  token_file=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["creds"][sys.argv[2]])' "$FIXTURE" "$TOKEN_KEY")

  local statedir cwd grok_home
  statedir="$EVIDENCE/state/$label"
  cwd="$EVIDENCE/cwd/$label"
  grok_home="$EVIDENCE/grok-home/$label"
  rm -rf "$statedir" "$cwd" "$grok_home"
  mkdir -p "$statedir" "$cwd" "$grok_home"
  chmod 700 "$statedir" "$cwd" "$grok_home"
  printf '%s\n' '{"access_token":"fake-local-login"}' > "$grok_home/auth.json"
  chmod 600 "$grok_home/auth.json"
  chmod 700 "$FAKE_GROK"

  log "$label: stopping any previous listener"
  listen_stop "$bin" "$statedir" "$token_file" "$workspace" "$url" "$anon" >/dev/null 2>&1 || true

  log "$label: listen start with $bin"
  GROK_HOME="$grok_home" CSWARM_FAKE_GROK_AUDIT="$grok_home/audit.ndjson" \
    "$bin" listen start \
      --agent-token-file "$token_file" \
      --url "$url" \
      --anon-key "$anon" \
      --workspace-id "$workspace" \
      --provider grok \
      --grok-executable "$FAKE_GROK" \
      --cwd "$cwd" \
      --permissions deny \
      --allow-unattended \
      --route worker \
      --state-dir "$statedir" \
      --json | tee "$statedir/start.json"

  wait_ready "$bin" "$statedir" "$token_file" "$workspace" "$url" "$anon" "$want_push"
  log "$label: ready; settling ${SETTLE_SEC}s so startup ticks are outside the window"
  sleep "$SETTLE_SEC"

  local t0 t1 start_line end_line
  t0=$(utc_now)
  start_line=$(log_line_count)
  start_line=$((start_line + 1))
  printf '%s\n' "$t0" > "$statedir/window-start.txt"
  printf '%s\n' "$start_line" > "$statedir/serve-log-start-line.txt"
  listen_status "$bin" "$statedir" "$token_file" "$workspace" "$url" "$anon" \
    | tee "$statedir/status-window-start.json" >/dev/null

  log "$label: idle window ${WINDOW_SEC}s starting at $t0 (serve log line $start_line)"
  sleep "$WINDOW_SEC"

  t1=$(utc_now)
  end_line=$(log_line_count)
  printf '%s\n' "$t1" > "$statedir/window-end.txt"
  printf '%s\n' "$end_line" > "$statedir/serve-log-end-line.txt"
  listen_status "$bin" "$statedir" "$token_file" "$workspace" "$url" "$anon" \
    | tee "$statedir/status-window-end.json" >/dev/null

  local reads claims activity
  reads=$(count_fn "$SERVE_LOG" read "$start_line" "$end_line")
  claims=$(count_fn "$SERVE_LOG" command "$start_line" "$end_line")
  activity=$(count_fn "$SERVE_LOG" activity "$start_line" "$end_line")
  local db
  db=$(db_counts "$t0" "$t1" "$principal")
  local audit idem rate
  audit=$(printf '%s' "$db" | cut -f1)
  idem=$(printf '%s' "$db" | cut -f2)
  rate=$(printf '%s' "$db" | cut -f3)

  python3 - "$statedir/counts.json" <<PY
import json, sys
out = {
  "label": "$label",
  "binary": "$bin",
  "window_start": "$t0",
  "window_end": "$t1",
  "window_sec": $WINDOW_SEC,
  "serve_log": "$SERVE_LOG",
  "serve_log_lines": {"from": $start_line, "to": $end_line},
  "invocations": {
    "read": int("$reads"),
    "command": int("$claims"),
    "activity": int("$activity"),
    "total": int("$reads") + int("$claims") + int("$activity"),
  },
  "rows": {
    "audit_log": int("$audit"),
    "idempotency_keys": int("$idem"),
    "rate_buckets": int("$rate"),
  },
  "method": {
    "invocations": "grep -c 'serving the request with supabase/functions/<fn>' on $SERVE_LOG lines ${start_line}-${end_line}",
    "rows": "docker exec supabase_db_cloud-swarm psql counts of swarm.audit_log / idempotency_keys / rate_buckets in [$t0, $t1) for principal $principal",
    "cadence": "before = 0.1.57 default 15s poll with empty backoff to 60s (not the retired 2s poll); after = 0.1.58 push + 5min reconcile",
  },
}
open(sys.argv[1], "w").write(json.dumps(out, indent=2) + "\\n")
print(json.dumps(out, indent=2))
PY

  if [ "$label" = "before" ]; then
    log "$label: stopping listener so after can use the same seat"
    listen_stop "$bin" "$statedir" "$token_file" "$workspace" "$url" "$anon" \
      | tee "$statedir/stop.json" >/dev/null
    local stop_deadline=$((SECONDS + 30))
    while [ "$SECONDS" -lt "$stop_deadline" ]; do
      local st
      st=$(listen_status "$bin" "$statedir" "$token_file" "$workspace" "$url" "$anon" 2>/dev/null || true)
      local state
      state=$(python3 -c 'import json,sys; print((json.loads(sys.argv[1]) if sys.argv[1] else {}).get("state",""))' "$st" 2>/dev/null || true)
      case "$state" in
        stopped|failed|"") break ;;
      esac
      sleep 1
    done
  fi
}

honesty() {
  local statedir=$1
  local status="$statedir/status-window-end.json"
  local events
  events=$(find "$statedir" -name events.ndjson | head -1)
  need_file "$status"
  mkdir -p "$EVIDENCE/honesty"
  {
    echo "## status.json"
    echo "positive control (grep -o '\"state\"' must hit):"
    grep -o '"state"' "$status" | head -5
    echo "subject grep -c cswarm-wake: $(grep -c 'cswarm-wake:' "$status" || true)"
    "$PROBE_CHECK" \
      "grep -o '\"state\"' '$status'" \
      "grep -o 'cswarm-wake:' '$status'" || true
    echo
    echo "## events.ndjson ($events)"
    if [ -n "$events" ] && [ -f "$events" ]; then
      echo "positive control (grep -o '\"event\"' must hit):"
      grep -o '"event"' "$events" | head -5
      echo "subject grep -c cswarm-wake: $(grep -c 'cswarm-wake:' "$events" || true)"
      "$PROBE_CHECK" \
        "grep -o '\"event\"' '$events'" \
        "grep -o 'cswarm-wake:' '$events'" || true
    else
      echo "NO events.ndjson found under $statedir"
    fi
    echo
    echo "## serve.log"
    echo "positive control (grep -o serving the request with supabase/functions/read):"
    grep -o 'serving the request with supabase/functions/read' "$SERVE_LOG" | head -3
    echo "subject grep -c cswarm-wake: $(grep -c 'cswarm-wake:' "$SERVE_LOG" || true)"
    "$PROBE_CHECK" \
      "grep -o 'serving the request with supabase/functions/read' '$SERVE_LOG'" \
      "grep -o 'cswarm-wake:' '$SERVE_LOG'" || true
  } | tee "$EVIDENCE/honesty/probe.txt"
}

print_table_rows() {
  python3 - "$EVIDENCE/state/before/counts.json" "$EVIDENCE/state/after/counts.json" "$EVIDENCE/state/after/status-window-end.json" <<'PY'
import json, sys
before = json.load(open(sys.argv[1]))
after = json.load(open(sys.argv[2]))
status = json.load(open(sys.argv[3]))
wake = status.get("wake") or {}
bi = before["invocations"]
ai = after["invocations"]
br = before["rows"]
ar = after["rows"]
print()
print("§8 rows (measurements 1, 2, 7) — every number names its file")
print()
print(f"invocations per idle listener per {before['window_sec']} s")
print(f"  before (measured): read {bi['read']} + claim {bi['command']} + activity {bi['activity']} = {bi['total']}  [{sys.argv[1]}]")
print(f"  after  (measured): read {ai['read']} + claim {ai['command']} + activity {ai['activity']} = {ai['total']}  [{sys.argv[2]}]")
print(f"  method before: {before['method']['invocations']}")
print(f"  method after:  {after['method']['invocations']}")
print(f"  cadence: {before['method']['cadence']}")
print()
print(f"rows written per idle {before['window_sec']} s")
print(f"  before (measured): audit {br['audit_log']} + idempotency {br['idempotency_keys']} + rate_buckets {br['rate_buckets']}  [{sys.argv[1]}]")
print(f"  after  (measured): audit {ar['audit_log']} + idempotency {ar['idempotency_keys']} + rate_buckets {ar['rate_buckets']}  [{sys.argv[2]}]")
print(f"  method: {before['method']['rows']}")
print()
print("status honesty")
print(f"  listen status wake.mode = {wake.get('mode')!r}  [{sys.argv[3]}]")
print(f"  honesty probe: docs/evidence/2026-09-06-push-delivery-measured/honesty/probe.txt")
PY
}

mkdir -p "$EVIDENCE"
need_file "$BEFORE_BIN"
need_file "$AFTER_BIN"
need_file "$FAKE_GROK"
chmod 700 "$FAKE_GROK"

ensure_serve
ensure_seed

if [ "$SKIP_BEFORE" != "1" ]; then
  log "BEFORE idle window ($BEFORE_BIN)"
  run_idle_window before "$BEFORE_BIN" 0
fi

log "AFTER idle window ($AFTER_BIN, want mode=push, label=$AFTER_LABEL)"
run_idle_window "$AFTER_LABEL" "$AFTER_BIN" 1

log "honesty greps on the after seat"
honesty "$EVIDENCE/state/$AFTER_LABEL"

if [ "$AFTER_LABEL" = "after" ] && [ -f "$EVIDENCE/state/before/counts.json" ] && [ -f "$EVIDENCE/state/after/counts.json" ]; then
  print_table_rows
fi
log "done"
