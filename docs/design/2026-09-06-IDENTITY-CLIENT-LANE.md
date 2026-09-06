# Managed client lane — implementation handoff

Status: prepared; dispatch only after the server wire contract is committed.
Author: CswarmAstra. Builder: Grok. Root adjudicates review findings.

Read accepted `2026-09-06-AGENT-SESSION-IDENTITY.md` and Lane A's completion evidence once.
Use the exported `src/cloud/session-wire.ts` contract; do not invent a second schema.

## Ownership

Own `src/cli.ts`, `src/cloud/` except `session-wire.ts` and `accept-link.ts`,
`src/listener/`, focused `tests/p1-cli/` and existing support tests in their real gate.
No migrations, edge/protocol/site changes. Root hands you the server and name lane first.
Do not touch hook.ts/hook-routing.test.ts until root confirms the preview lane is integrated.

No CommonSwarm credentials, production access, swarm joins, autonomous subagents, global install,
remote push, version bump or release. Use synthetic test credentials only. Root owns coordination.

## Required commands and paths

1. Implement `session start|status|stop` with explicit interactive/worker mode, host provider and
   durable host-session ID. Add human lifecycle UI through CLI for enable/disable/recover, matching
   the server's exact operations and authorization. No status/read command enables enforcement.
2. Add `--session-context <absolute-path>` to bound client commands. The secure context contains
   format version, exact URL/profile, workspace/principal UUID, execution UUID/generation, private
   session key, provider/mode, durable host-session ID, and reference to the sole token file.
   File outside repositories, directory0700/file0600, owned regular file, reject symlinks and unsafe
   parents; reuse storage helpers where they meet these requirements. Fail closed on corrupt
   context. Do not follow user-provided arbitrary token references before validating ownership.
3. Verify whoami before acquire and before accepting a replaced/rotated token file. Do not merely
   trust the principal_id claimed by local JSON. If flags, token identity, host binding or target
   conflict with the context, reject before ANY mutation. Positive same-identity path must pass.
4. Generate/save execution UUID and 32-byte secret BEFORE acquisition; retry lost response with
   same UUID/key. Response updates generation atomically. Never overwrite another binding.
   Old retired execution UUID cannot start again. Distinguish host chat ID from execution UUID.
5. Transport attaches proof to every agent write, including renewals, claims, ACK and activity.
   Preserve stable logical command IDs/hashes across proof changes; typed server errors drive
   state transitions, never error.message. Headers/body logs redact private proof and agent token.
   Read-only status omits secret and credential JSON. Unknown server capability cannot claim
   enforcement is active; preserve legacy behavior only for unmanaged principals.
6. Complete create-agent `allow_duplicate_name` CLI option/type seam supplied by server/name lane.
   Do not silently opt in or modify UUID resolution.

## Receiver and worker lifecycle

7. One deterministic receiver renews at the wire-contract interval, piggybacks where safe, and
   stops dispatch before proof expiry/loss. Reuse new push wait machinery; wake is a hint and
   durable claim is truth. No new model polling schedule. Avoid overlapping interval callbacks.
   A stopped model turn does not renew a lease; a running deterministic receiver can.
8. Interactive mode must have no reachable ACP/model factory, constructor, session-new or child
   model spawn. It only claims and buffers/surfaces in the registered existing host conversation.
   Unsupported host callback => manual/unverified receive mode. CLI cannot manufacture a Codex
   app callback. Do not install a schedule, launch a worker, or mark observed from a log print.
9. Bind managed queued rows and local cache to execution UUID/generation + host conversation ID.
   Use the server's pending-surface protocol. Cache loss cannot strand an ask. Delivery ACK requires
   successful host injection and current proof. On takeover old hooks/cache cannot ACK. Retain
   original ask IDs and stable reply IDs; at-least-once receipt is honest.
10. For supported hooks, require expected host-session binding at delivery. A project-local or
    principal-only hook is insufficient when two chats share the project/principal. If the host
    does not supply trustworthy current conversation identity, fail closed to manual instead of
    acknowledging arbitrary matching files. Never infer provider from inherited Claude env.
11. Worker mode is explicit. All existing adapters use the shared session manager; old local lock
    is not cross-machine authority. Refuse a competing managed session and expose typed conflict.
    Populate trusted recipient principal/execution identity in the worker prompt. Supply the
    bound context path to worker tools without exposing its secret. Sibling review/build agents
    must not inherit that binding. Stop the managed worker on lease loss; external shell effects
    already started may survive, so status must not claim full termination without evidence.
12. status/resume show execution UUID, generation, mode, provider and host-session ID, enforcement
    and transport state, manual/scheduled/callback verification separately. Extend strict parsers
    compatibly; no truth inferred from file existence. `mode: push` only while subscribed.
    Stop returns progress with a concrete status-check command until teardown is confirmed.

## Acceptance tests and handoff

- Mismatched token target/principal or host context refuses BEFORE network write; same identity works.
- Insecure/symlink/foreign-owned/corrupt context rejected; successful write uses0600/0700; no token copy.
- Acquire retry uses same private proof; release/recovery retires old execution; delayed stale ACK fails.
- Current session retries original command after lost response with new proof and stable command ID.
- Two simulated heterogeneous sessions on different hosts: one winner, another principal unaffected.
- Interactive test spies on provider factory/subprocess and asserts ZERO calls, including failure.
- Managed workers from every adapter get the shared binding; no inherited binding in review child.
- Queue cache deletion + host loss is recovered through durable server; obsolete hook cannot observe.
- No callback => manual; authenticated ready never equals same-chat injection proof.
- Idle receiver invokes zero models. Duplicate wake/ask IDs do not cause duplicate reply commands.
- Push subscribed/drop/reconnect controls and current token renewal tests remain green.

Run build, focused CLI/support tests, check:tests. Root owns exclusive DB/live controls. Add each new
test to its real gate. End with committed SHA, changed files, exact tests/results, and every unmet
acceptance criterion. Do not claim release or end-to-end Codex wake.
