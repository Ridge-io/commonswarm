# Live control on the mini, candidate `63acfdb` (2026-09-06, CSwarmStrategist)

Script: `../laptop-live-control-b0902f68/run-control.sh` (CSLaptopLead's portable control, run verbatim from a built worktree of `63acfdb` against the local Supabase stack on the mini: OrbStack, container clock equal to the host). Host session id: a fresh UUID. Files here: `control.log` (the whole run), `listener-events.ndjson` (the route-main listener's journal), `step7-rerun.json` (step 7 rerun with the credential flags the script at `63acfdb` lacked; fixed upstream at `65ef1e2`), `db-rows.txt` (the delivery and session rows read from Postgres after the run).

| step | expected | measured |
|---|---|---|
| 5 enable (human owner) | ok | `{"action":"enable","ok":true}` |
| 6b session start interactive | generation ≥ 1, enforcement enabled, no ACP | generation 2, `enforcement: enabled`, `receive_verification: manual`, "did not start an ACP model" |
| 7 session status | proof present | script line failed for the missing credential flags; rerun after step 13 (`step7-rerun.json`): local `stopped`, `has_private_proof: false`, `released_at` set; server block reports a new session id (generation 3 after recover); no secret in the output |
| 8 listen start --route main | ready, no worker | `state: ready`, `routeMode: main`, "interactive session; no ACP worker prompt" |
| 9-10 directed ask from the human | claimed with proof, queued | `listener_delivery_claim` → `routed_main` → `listener_delivery_ack outcome=queued`, `pendingForMainCount: 1` |
| 10c bare queued-to-observed, live proof, no `surfaced` | refused | `{"error":"delivery_not_surfaced"}` |
| 11a hook check without a host session id | nothing printed, nothing observed | hook exit 0, no text; pending stays 1 |
| 11b hook check with the host session id on stdin | the ask surfaced, observed | the ask printed; `pendingForMainCount: 0`; DB row `observed`, `surfaced=true`, `session_generation=2`, bound |
| 12 model processes | 0 listener children | listener children 0 (the host-wide count of 16 is other agents' processes on the shared mini) |
| 13 human recover | ok, generation bumps | ok; session row generation 3, old session expired |
| 14 stale-context stop | typed refusal | `server_refusal: session_expired` |
| 14b hook with the stale context | no observe | hook exit 0, nothing printed |
| 15 teardown | listener stops | `state: stopping` (progress form), children 0 |

Not established here: renewal across more than one 40 s period under load; two competing receivers (the round-6 lock) under a real second process; production apply.
