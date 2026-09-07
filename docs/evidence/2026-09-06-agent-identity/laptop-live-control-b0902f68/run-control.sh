#!/bin/zsh
# Live control for the agent-identity candidate on the LOCAL Supabase stack.
# Usage: run-control.sh <worktree-of-the-head> <host-session-id>
#   <worktree> must be under /Users on a colima host, built (npm run build), with
#   `supabase start -x vector,logflare` already up from it. <host-session-id> is any
#   durable conversation id; it is what the hook must see on stdin to observe.
# The script's own directory supplies env.py and enable.ts; nothing else is needed.
set -u
# EXPECTED (measured on b0902f68 with an a556ab1b server; on a d141c1e+ server step 11b must
# also show surfaced=true landing and step 14c must be refused with delivery_not_surfaced):
#  step5  enable ok
#  step6b acquire: generation >= 1, enforcement enabled; step7 status shows local state running AND server is_live true, same session_id
#  step8  listen start: state ready, routeMode main, same_owner_delivery 'interactive session; no ACP worker prompt'
#  step10 after the ask: listener_delivery_claim, routed_main, ack outcome queued, pendingForMainCount 1
#  step11a hook WITHOUT stdin host id: prints NOTHING (host gate), observes nothing, queue keeps 1
#  step11b hook WITH {"session_id": <host>} on stdin: prints the ask, observes it; server row ack_outcome=observed, surfaced_at set
#  step12 zero model processes under the listener
#  step13 recover ok; step14 stale stop refused with a typed session code
#  step10c (added) bare queued-to-observed with the live proof but no surfaced: refused delivery_not_surfaced
WT=$1; HOST_SESSION=$2
HERE=${0:A:h}
T=${TMPDIR:-/tmp}/cswarm-live-control-$(date +%H%M%S); mkdir -p $T/cfg $T/state $T/cwd; chmod 700 $T $T/cfg $T/state
CLI="node $WT/dist/cli.js"
setopt SH_WORD_SPLIT
cd $WT
eval "$(supabase status -o json | python3 $HERE/env.py)"
echo "step0 api=$API"
# functions serve from this /Users worktree
printf 'SWARM_ENV=test\nSWARM_SELF_SERVE=1\n' > $T/fn.env; chmod 600 $T/fn.env
SWARM_ENV=test supabase functions serve --no-verify-jwt --env-file $T/fn.env > $T/functions.log 2>&1 &
FN_PID=$!
for i in $(seq 1 60); do B=$(curl -s -m 2 -X POST "$API/functions/v1/command" -H "apikey: $ANON" -H 'content-type: application/json' -d '{}'); echo "$B" | grep -q -E '"unauthenticated"|"invalid_request"' && break; sleep 1; done
echo "step1 functions ready after ${i}s: $B"
# human user + JWT
NONCE=$(uuidgen | tr 'A-Z' 'a-z' | cut -c1-8); EMAIL="ctl-$NONCE@example.test"; PW="ctl-pass-$NONCE-XyZ1"
UIDJ=$(curl -s -X POST "$API/auth/v1/admin/users" -H "apikey: $SR" -H "Authorization: Bearer $SR" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\",\"email_confirm\":true}")
HUID=$(echo "$UIDJ" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
JWT=$(curl -s -X POST "$API/auth/v1/token?grant_type=password" -H "apikey: $ANON" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')
echo "step2 human uid=$HUID jwt_len=${#JWT}"
# seed workspace + two agents
S1=$(DATABASE_URL=$DB SEED_TOKEN_OUT=$T/agent1.json $CLI seed-fixture --uid $HUID); echo "step3a $S1"
WS=$(echo "$S1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["workspaceId"])'); P1=$(echo "$S1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["principalId"])')
for f in agent1; do python3 - $T/$f.json <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p))
d.setdefault("expires_at", "2099-01-01T00:00:00.000Z"); d.setdefault("run_id", d.get("runId")); json.dump(d, open(p,"w")); print(p, sorted(d.keys()))
PY
done
AG1="--agent-token-file $T/agent1.json --url $API --anon-key $ANON --workspace-id $WS"
echo "step4 whoami1: $($CLI whoami $AG1 --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["display_name"], d["principal_id"])')"
# enable management for agent1 (human owner)
echo "step5 enable: $(cd $WT && node --import tsx $HERE/enable.ts enable $API $ANON $JWT $WS $P1)"
# acquire refused before enable? (order swapped on purpose below: acquire AFTER enable; the not-managed control is agent2)
echo "step6b acquire on managed agent1:"; START=$(XDG_CONFIG_HOME=$T/cfg $CLI session start --mode interactive --provider claude --host-session-id $HOST_SESSION $AG1 --json 2>&1); echo "$START"
CTX=$(ls $T/cfg/cswarm/sessions/$WS/$P1/*.json 2>/dev/null | head -1); echo "context: $CTX"
echo "step7 session status (round 6: needs the credential; reports local and server):"; XDG_CONFIG_HOME=$T/cfg $CLI session status --session-context $CTX --agent-token-file $T/agent1.json --url $API --anon-key $ANON --json
# hook for agent1 in the control cwd, listener route main
(cd $T/cwd && git init -q . && $CLI hook install claude --principal-id $P1 --write | tail -1)
echo "step8 listen start (route main, XDG_STATE_HOME=$T/state):"
LS=$(XDG_STATE_HOME=$T/state XDG_CONFIG_HOME=$T/cfg $CLI listen start $AG1 --provider claude --cwd $T/cwd --route main --json 2>&1); echo "$LS" | python3 -c 'import json,sys; d=json.load(sys.stdin); print({k:d.get(k) for k in ["state","routeMode","pid","pendingForMainCount","lastErrorCode","same_owner_delivery"]})' || echo "$LS" | tail -5
echo "step9 ask from the human owner to agent1 (command edge, post_signal):"; curl -s -X POST "$API/functions/v1/command" -H "apikey: $ANON" -H "Authorization: Bearer $JWT" -H 'content-type: application/json' -d "{\"command_id\":\"$(uuidgen | tr A-Z a-z)\",\"client_version\":\"0.1.0\",\"workspace_id\":\"$WS\",\"stream\":{\"kind\":\"workspace\"},\"command\":{\"kind\":\"post_signal\",\"signal_kind\":\"ask\",\"body\":\"control ask $NONCE: reply not needed\",\"to_user_id\":null,\"to_agent_principal_id\":\"$P1\",\"in_reply_to\":null,\"about\":null}}" | tee $T/last-ask.json | head -c 300; echo
sleep 12
echo "step10 listen status:"; XDG_STATE_HOME=$T/state XDG_CONFIG_HOME=$T/cfg $CLI listen status $AG1 --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print({k:d.get(k) for k in ["state","routeMode","pendingForMainCount","claimedCount","deliveriesClaimed","lastErrorCode","lastErrorDetail","listenerLapse","mode","providerExecutable","same_owner_delivery"]})'
echo "step10b listener events tail:"; tail -5 $T/state/cswarm/listeners/*/events.ndjson 2>/dev/null | cut -c1-220
echo "step10c bare queued-to-observed WITHOUT surfaced, live proof, before any hook (expect delivery_not_surfaced):"; AGT=$(python3 -c "import json;print(json.load(open('$T/agent1.json'))['agent_token'])"); CTX2=$(ls $T/cfg/cswarm/sessions/$WS/$P1/*.json 2>/dev/null | tail -1); SID=$(python3 -c "import json;print(json.load(open('$CTX2'))['session_id'])"); GEN=$(python3 -c "import json;print(json.load(open('$CTX2'))['generation'])"); KEY=$(python3 -c "import json;print(json.load(open('$CTX2'))['session_key'])"); curl -s -X POST "$API/functions/v1/command" -H "apikey: $ANON" -H "Authorization: Bearer $AGT" -H "x-cswarm-session-id: $SID" -H "x-cswarm-session-generation: $GEN" -H "x-cswarm-session-key: $KEY" -H 'content-type: application/json' -d "{\"command_id\":\"$(uuidgen | tr A-Z a-z)\",\"client_version\":\"0.1.0\",\"workspace_id\":\"$WS\",\"stream\":{\"kind\":\"workspace\"},\"command\":{\"kind\":\"ack_agent_delivery\",\"signal_id\":\"$(python3 -c "import json;print(json.load(open('$T/last-ask.json'))['signal']['id'])")\",\"lease_id\":null,\"listener_instance_id\":null,\"outcome\":\"observed\",\"last_error_code\":null}}" | head -c 300; echo
echo "step11a hook check WITHOUT a host session id on stdin (expect: surfaced text, nothing observed):"; (cd $T/cwd && XDG_STATE_HOME=$T/state XDG_CONFIG_HOME=$T/cfg $CLI hook check --principal-id $P1 --cooldown 0 < /dev/null; echo "hook exit $?")
echo "step11b hook check WITH Claude's stdin shape (expect: observed with proof headers):"; (cd $T/cwd && echo "{\"session_id\":\"$HOST_SESSION\",\"hook_event_name\":\"UserPromptSubmit\"}" | XDG_STATE_HOME=$T/state XDG_CONFIG_HOME=$T/cfg $CLI hook check --principal-id $P1 --cooldown 0; echo "hook exit $?")
echo "step11c listen status after the hook:"; XDG_STATE_HOME=$T/state XDG_CONFIG_HOME=$T/cfg $CLI listen status $AG1 --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print({k:d.get(k) for k in ["state","pendingForMainCount","lastErrorCode","lastErrorDetail"]})'
echo "step12 model processes under the listener: $(pgrep -f 'claude-agent-acp|grok-model|codex' | wc -l | tr -d ' ') (expect 0 new); listener children:"; pgrep -P $(echo "$LS" | python3 -c 'import json,sys; print(json.load(sys.stdin)["pid"])' 2>/dev/null || echo 0) | wc -l
echo "step13 human recover (retires the execution UUID):"; (cd $WT && node --import tsx $HERE/enable.ts recover $API $ANON $JWT $WS $P1)
echo "step14 stale-context stop/ACK with the OLD context (expect refusal, typed code):"; XDG_CONFIG_HOME=$T/cfg $CLI session stop --session-context $CTX --agent-token-file $T/agent1.json --url $API --anon-key $ANON --json 2>&1 | tail -6
echo "step14b hook check again with the stale context and the bound host id (expect no observe):"; (cd $T/cwd && echo "{\"session_id\":\"$HOST_SESSION\"}" | XDG_STATE_HOME=$T/state XDG_CONFIG_HOME=$T/cfg $CLI hook check --principal-id $P1 --cooldown 0; echo "hook exit $?")
echo "step15 teardown"; XDG_STATE_HOME=$T/state XDG_CONFIG_HOME=$T/cfg $CLI listen stop $AG1 --json | grep -E '"state"' | head -1; kill $FN_PID 2>/dev/null; sleep 1; pgrep -f 'functions serve' | wc -l
echo "artifacts in $T"
