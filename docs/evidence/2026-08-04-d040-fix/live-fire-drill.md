# D-040 live-fire drill — control reproduced; treatment not established

Date: 2026-08-04

Branch: `fix/v015-d040`

Frozen control: `175f894f7e3a3e9ec822b5a187331fee7fccd3c5`

Candidate: `de848ee5f213e200e6265a99b84a0cf084f25996`

## Outcome

**This drill does not clear the release gate.**

The frozen control reproduced D-040 in a real detached listener: the journal was visibly
`leased`, the supervisor received `SIGKILL`, the shortened lease expired, and restart reached
`listener_ready` before failing with `deliveryprotocolerror`. The journal remained `leased`; there
was no ACK and no reply. The negative control therefore discriminated.

The candidate result was **not established**. One candidate attempt killed the supervisor in the
small interval after `delivery-journal.json` was readable but before `delivery-journal.lock` was
unlinked. Restart then measured a frozen file lock, not D-040 recovery. After the harness was
corrected to require the write lock to be absent while the journal still read `leased`, the next
initial OpenCode listener never became ready: it stopped at `permission_canary_failed`. Per the
drill contract and operator instruction, execution stopped there rather than retrying or tuning
until the desired answer appeared.

The downgrade hazard was also **not established**. The candidate journal did contain the new
`signalFingerprint` field, but the frozen-parser attempt copied the same leftover lock and returned
`unclean_exit` before a parser verdict could be observed.

## Real setup

- Local Supabase was reset separately from each tree, applying that tree's migrations.
- `supabase functions serve --no-verify-jwt` ran from the tree under test with a real environment
  file containing `SWARM_ENV` and `SWARM_SELF_SERVE` (not `/dev/null`).
- The locally served copy alone changed
  `DELIVERY_LEASE_MS = 15 * 60 * 1000` to `DELIVERY_LEASE_MS = 8 * 1000`.
- The listener was the built `dist/cli.js listen start` process, detached by the CLI.
- Provider arguments were `--provider opencode --opencode-executable
  /Users/yulanbot/.opencode/bin/opencode`; no `--effort` was supplied. The measured executable
  reported `1.18.10`.
- The harness set `NODE_OPTIONS=--max-old-space-size=4096` in its explicit `baseEnv`, and every
  spawned Node CLI and listener inherited that environment. It did not rely only on the invoking
  shell.
- The direct ask required reading D-040 and the drill contract plus source verification, so the
  first process remained in a real model turn while killed.

The harness used fresh per-run device UUIDs. Local Auth survives the observed reset shape, so the
first resumed run's fixed device IDs correctly failed with `device id is already owned by another
user`; that setup-only run did not reach a listener and is not counted as an arm.

## Frozen control — accepted negative arm

Artifact root:
`/var/folders/bb/7n7qfbls651d80fs4r9wdyk40000gn/T/d040-control-D6yzNl`

The initial `listen start` exited 0 and reported a ready OpenCode listener. Relevant raw output:

```text
===== initial listen start =====
exit=0 signal=none
--- stdout ---
{
  "version": 1,
  "instanceId": "dfcd52bb-d940-46b5-85f0-f52d793ad90a",
  "provider": "opencode",
  "workspaceId": "04000000-0000-4000-8000-000000000002",
  "principalId": "949fe50a-1e00-541b-890c-5a06300cbe82",
  "pid": 20118,
  "state": "ready",
  "readyAt": "2026-08-04T13:11:51.142Z",
  "deliveryMode": "durable_claim",
  "pendingDeliveryCount": 1,
  "lastClaimAt": "2026-08-04T13:11:51.241Z",
  "lastAckAt": null
}
--- stderr ---
<empty>
```

The on-disk journal was read directly before the kill and again after the kill. Raw journal after
`SIGKILL`:

```json
{"version":1,"workspaceId":"04000000-0000-4000-8000-000000000002","principalId":"949fe50a-1e00-541b-890c-5a06300cbe82","listenerInstanceId":"dfcd52bb-d940-46b5-85f0-f52d793ad90a","nextClaimOrdinal":1,"active":{"phase":"leased","claimOrdinal":0,"claimCommandId":"claim_dfcd52bbd94046b585f0f52d793ad90a_0","claimCreatedAt":"2026-08-04T13:11:51.142Z","claimLastAttemptAt":"2026-08-04T13:11:51.148Z","signalId":"abb2c34b-eb0b-4758-a13e-7e6e6db2278f","leaseId":"a3a87592-6483-4041-9ea9-bb3ae3838a0a","leasedUntil":"2026-08-04T13:11:59.221Z","ack":null},"updatedAt":"2026-08-04T13:11:51.241Z"}
```

Raw kill and wait:

```text
===== kill -9 =====
pid=20118 signal=SIGKILL

===== lease expiry wait =====
leased_until=2026-08-04T13:11:59.221Z
wait_ms=9429
restart_at=2026-08-04T13:12:00.726Z
```

Exact restart stdout/stderr:

```text
===== RESTART exact stdout and stderr =====
exit=1 signal=none
--- stdout ---
<empty>
--- stderr ---
cswarm: listener failed (unclean_exit); no ready listener was left running
```

Although the outer command ultimately returned `unclean_exit`, the listener's durable event log
shows the restarted child did start and report ready before D-040 killed it:

```jsonl
{"ts":"2026-08-04T13:11:43.790Z","event":"listener_starting","instance_id":"dfcd52bb-d940-46b5-85f0-f52d793ad90a","pid":20118}
{"ts":"2026-08-04T13:11:43.835Z","event":"listener_delivery_mode","delivery_mode":"durable_claim","pending_delivery_count":1}
{"ts":"2026-08-04T13:11:51.142Z","event":"listener_ready"}
{"ts":"2026-08-04T13:11:51.241Z","event":"listener_delivery_claim","signal_id":"abb2c34b-eb0b-4758-a13e-7e6e6db2278f","pending_delivery_count":1,"terminal_delivery_failure_count":0}
{"ts":"2026-08-04T13:12:00.866Z","event":"listener_starting","instance_id":"dfcd52bb-d940-46b5-85f0-f52d793ad90a","pid":20482}
{"ts":"2026-08-04T13:12:00.970Z","event":"listener_delivery_mode","delivery_mode":"durable_claim","pending_delivery_count":1}
{"ts":"2026-08-04T13:12:12.230Z","event":"listener_ready"}
{"ts":"2026-08-04T13:12:12.325Z","event":"listener_failed","failure_code":"deliveryprotocolerror"}
```

Raw settled status and journal:

```json
{"version":1,"instanceId":"dfcd52bb-d940-46b5-85f0-f52d793ad90a","provider":"opencode","permissionMode":"allow","profileId":"a43416c82b48dcd84545dfdc","workspaceId":"04000000-0000-4000-8000-000000000002","principalId":"949fe50a-1e00-541b-890c-5a06300cbe82","pid":20482,"state":"failed","startedAt":"2026-08-04T13:12:00.859Z","readyAt":"2026-08-04T13:12:12.230Z","updatedAt":"2026-08-04T13:12:12.325Z","stoppedAt":"2026-08-04T13:12:12.325Z","lastSignalId":null,"lastErrorCode":"deliveryprotocolerror","deliveryMode":"durable_claim","pendingDeliveryCount":1,"lastTerminalDeliveryFailureCount":null,"lastTerminalDeliveryFailureAt":null,"lastClaimAt":null,"lastAckAt":null}
```

```json
{"version":1,"workspaceId":"04000000-0000-4000-8000-000000000002","principalId":"949fe50a-1e00-541b-890c-5a06300cbe82","listenerInstanceId":"dfcd52bb-d940-46b5-85f0-f52d793ad90a","nextClaimOrdinal":1,"active":{"phase":"leased","claimOrdinal":0,"claimCommandId":"claim_dfcd52bbd94046b585f0f52d793ad90a_0","claimCreatedAt":"2026-08-04T13:11:51.142Z","claimLastAttemptAt":"2026-08-04T13:12:12.230Z","signalId":"abb2c34b-eb0b-4758-a13e-7e6e6db2278f","leaseId":"a3a87592-6483-4041-9ea9-bb3ae3838a0a","leasedUntil":"2026-08-04T13:11:59.221Z","ack":null},"updatedAt":"2026-08-04T13:12:12.230Z"}
```

Machine summary:

```text
restart_exit=1
restart_stdout_nonempty=false
restart_stderr_nonempty=true
final_state=failed
final_error=deliveryprotocolerror
final_ack_at=none
final_journal_active=leased
```

This is the required negative control: the frozen build bricked rather than recovering.

## Candidate — diagnostic attempt invalidated by the journal lock

Artifact root:
`/var/folders/bb/7n7qfbls651d80fs4r9wdyk40000gn/T/d040-treatment-sJsu2i`

The candidate did reach a real leased journal. The new field was present:

```json
{"version":1,"workspaceId":"04100000-0000-4000-8000-000000000002","principalId":"a678c3c8-d382-5b25-a575-7d14ed50cd93","listenerInstanceId":"61304018-95c8-4bf2-aa13-6d3f4020bbfd","nextClaimOrdinal":1,"active":{"phase":"leased","claimOrdinal":0,"claimCommandId":"claim_6130401895c84bf2aa136d3f4020bbfd_0","claimCreatedAt":"2026-08-04T13:18:31.243Z","claimLastAttemptAt":"2026-08-04T13:18:31.260Z","signalId":"e4586259-dc57-49b9-80ee-1aeddbed2029","leaseId":"21cb168f-0f7c-4e4f-8ffa-82d09cdccd25","leasedUntil":"2026-08-04T13:18:39.332Z","signalFingerprint":"fc59ad9221ebab77fe45f454d1ad52aff70f661331652400863893dc1982b12f","ack":null},"updatedAt":"2026-08-04T13:18:31.353Z"}
```

Exact restart output from that attempt:

```text
===== RESTART exact stdout and stderr =====
exit=1 signal=none
--- stdout ---
<empty>
--- stderr ---
cswarm: listener failed (unclean_exit); no ready listener was left running
```

There was no second `listener_starting` event. Inspection found
`delivery-journal.lock` still present. `withFileLock` treats that lock as stale only after 60
seconds and waits at most 30 seconds, so this restart did not reach candidate recovery. The copied
rollback state contained the same lock; its frozen start was invalid for the same reason.

This attempt is recorded because it explains the harness correction. It is **not** counted as a
failed treatment or a measured rollback-parser result.

## Corrected harness — exact stop

The harness was changed to wait until `delivery-journal.lock` was absent, re-read the journal, and
require that it still be `leased` before `SIGKILL`. This preserves the requested kill phase while
avoiding a different crash artifact.

On the next run, the frozen arm stopped before reaching that point. OpenCode `1.18.10` stayed in its
permission canary until the listener recorded failure. The harness ended at `initial listen start
failed`; no signal was claimed and no kill was issued.

Artifact root:
`/var/folders/bb/7n7qfbls651d80fs4r9wdyk40000gn/T/d040-control-7oSi92`

Exact harness stderr captured at the stop:

```text
Error: initial listen start failed
    at run (file:///private/tmp/d040-live-fire.mjs:103:11)
    at file:///private/tmp/d040-live-fire.mjs:239:20
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)

Node.js v26.5.0
```

The synchronous harness did not flush the nested `listen start` stdout/stderr block before throwing,
so that child's exact rendered CLI line was not established. The listener-owned durable state is
complete and exact:

```jsonl
{"ts":"2026-08-04T13:25:21.736Z","event":"listener_starting","instance_id":"ac03e6e4-64be-45ae-bb9c-6facafefe094","pid":37481}
{"ts":"2026-08-04T13:25:21.774Z","event":"listener_delivery_mode","delivery_mode":"durable_claim","pending_delivery_count":1}
{"ts":"2026-08-04T13:27:23.562Z","event":"listener_failed","failure_code":"permission_canary_failed"}
```

```json
{"version":1,"instanceId":"ac03e6e4-64be-45ae-bb9c-6facafefe094","provider":"opencode","permissionMode":"allow","profileId":"a43416c82b48dcd84545dfdc","workspaceId":"04000000-0000-4000-8000-000000000002","principalId":"949fe50a-1e00-541b-890c-5a06300cbe82","pid":37481,"state":"failed","startedAt":"2026-08-04T13:25:21.726Z","readyAt":null,"updatedAt":"2026-08-04T13:27:23.563Z","stoppedAt":"2026-08-04T13:27:23.562Z","lastSignalId":null,"lastErrorCode":"permission_canary_failed","deliveryMode":"durable_claim","pendingDeliveryCount":1,"lastTerminalDeliveryFailureCount":null,"lastTerminalDeliveryFailureAt":null,"lastClaimAt":null,"lastAckAt":null}
```

```json
{"version":1,"workspaceId":"04000000-0000-4000-8000-000000000002","principalId":"949fe50a-1e00-541b-890c-5a06300cbe82","listenerInstanceId":"ac03e6e4-64be-45ae-bb9c-6facafefe094","nextClaimOrdinal":0,"active":null,"updatedAt":"2026-08-04T13:25:21.731Z"}
```

The state directory contained exactly `events.ndjson`, `status.json`, and
`delivery-journal.json`; no listener or OpenCode process remained after failure.

## Lease edit and restoration proof

The drill-only diff in each detached worktree was exactly:

```diff
-export const DELIVERY_LEASE_MS = 15 * 60 * 1000;
+export const DELIVERY_LEASE_MS = 8 * 1000;
```

It was never committed. After the drill, both detached worktrees were restored to their exact HEADs:

```text
TREE=/private/tmp/cswarm-d040-control.zagqAy/tree
SHA=175f894f7e3a3e9ec822b5a187331fee7fccd3c5
git status --short: <empty>
DELIVERY_LEASE_MS = 15 * 60 * 1000

TREE=/private/tmp/cswarm-d040-treatment.eUHjAj/tree
SHA=de848ee5f213e200e6265a99b84a0cf084f25996
git status --short: <empty>
DELIVERY_LEASE_MS = 15 * 60 * 1000
```

The branch worktree was clean before this evidence file was created.

## What this did not establish

- It did not prove that `de848ee` recovers, ACKs, replies, or continues receiving after this crash.
- It did not prove that `de848ee` fails those properties; the only candidate restart was blocked by
  a harness-created leftover lock and is not a product verdict.
- It did not measure the frozen parser's response to `signalFingerprint`; the copied state also
  carried the leftover lock.
- It did not measure behavior with the production 15-minute lease.
- It did not measure other providers, operating systems, hosted Supabase, network interruption,
  token renewal during recovery, or more than one listener principal.
- It did not capture the final failed `listen start` child's rendered stdout/stderr because the
  synchronous harness exited before flushing that nested block. The durable status/event/journal
  state above was captured exactly.

The actionable conclusion is narrow: the frozen control is real and D-040 remains demonstrated;
the candidate's required live-fire recovery evidence is still absent, so this gate remains open.
