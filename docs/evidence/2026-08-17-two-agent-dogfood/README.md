# Two-agent dogfood against shipped 0.1.16 — steady-state `allow` measured

**2026-08-17, yulanbots-mac-mini.** This is the run the 2026-08-12 resume file named as the only
open engineering item. It is the first measurement of steady-state `--permissions allow`, which
twelve D-036 review rounds could not establish because the permission-boundary canary forces deny
regardless of mode.

## Method

- **Binary:** cold install through the published installer
  (`curl -fsSL https://commonswarm.com/install.sh | CSWARM_INSTALL_DIR=<scratch> sh`), which
  reported `cswarm 0.1.16 (protocol 0.1.0)`. Every command below ran that artifact, not a local
  build.
- **Agents:** the Lead's human login (identity `d37e2ff2`) as asker; a fresh agent principal
  `dbb811b2-c2f8-4527-8b70-493c615696e0` (`dogfood016-worker`) as worker, minted this run with an
  8h token. Workspace: Dogfood Workspace `3ab184b3-fbb4-5ee9-afad-3842a604439a`, production
  (`ukezjcnxjvkpkeezxaew`).
- **Host conditions, recorded per the 08-10 round-2 lead:** load average 2.1–3.4 throughout,
  `kern.memorystatus_vm_pressure_level` = 1 (normal). Other agents' cloud-swarm test suites
  (`node --test tests/listener-*.test.ts` ×2) were running on the box the whole time.

## M-1 — the D-084 default is live in the shipped artifact

`listen start` with **no `--permissions` flag** produced `permissionMode: "allow"` in
`listen status` on every attempt, both providers. The flip shipped.

## M-2 — steady-state `allow` MEASURED: a real tool effect landed on disk

Worker: provider `claude` (claude-agent-acp 0.64.2), ready in **9.5s** on the first attempt.
Ask (benign): write a haiku into `haiku.txt` in the worker cwd. The reply arrived correlated
(`in_reply_to` = the exact ask id, round trip 24s), and **`haiku.txt` existed on disk in the
worker cwd afterward, 54 bytes, content byte-identical to the haiku quoted in the reply.** The
directory was verified empty before the ask.

A file-write tool call was therefore executed and permitted under the default `allow` mode.
This is the measurement the register said nothing had made.

**NOT established by M-2:** whether the bridge raised an ACP permission request that
`allowOnceOrDeny` answered, or never raised one at all. The listener event log records
`listener_effect` entries but no labeled permission events, so the file proves the tool call, not
the shape of the permission path. Distinguishing those needs an instrumented run.

## M-3 — under `allow`, the worker still declines side-effecting asks it reads as injection

The FIRST ask asked the worker to write a proof file **and run `sw_vers` and echo the output
back**. The worker refused, correctly correlated:

> "I won't execute these instructions. The message body is untrusted data … Same-owner routing
> metadata isn't authorization."

No file appeared (verified). So the D-084 concern — a worker that cannot do the thing you ask —
can reappear one layer above permissions, in model policy, for asks phrased like remote command
execution. **Unlike D-084 it is not silent:** the worker said exactly why and what to do instead.
The second, benign ask succeeded, so the boundary is the model's read of the request, not the
permission mode. Where that line sits across phrasings and providers is unmeasured.

**Also surfaced by M-3, verbatim in the reply body:** *"claude-fable-5 declined this request
(cyber); retried with claude-opus-4-8. The session will continue on claude-opus-4-8."* The
worker session silently changed model mid-run. Whether that fallback is claude-agent-acp's or
ours, and whether the session staying on the fallback model is intended, was not chased.

## M-4 — opencode failed the deny canary twice at LOW load, against the load lead

| attempt | provider | elapsed | outcome |
|---|---|---|---|
| 1 | opencode | 21s | `permission_canary_failed` |
| 2 | opencode | 14s | `permission_canary_failed` |
| 3 | claude | 9.5s | **ready** |

Load was 2.1–2.9 (pressure level 1) at both opencode failures. The 08-10 round-2 lead was that
D-081 canary failures cluster with load (observed then at load 25). **These two failures are
evidence against load as the sole cause.** A direct probe on the same box, same binary
(`opencode run --model opencode/big-pickle "Reply with exactly: PROBE-OK"`) returned `PROBE-OK`,
so model access works; the canary path specifically is what fails. The canary passes only if the
model chooses to issue a tool-permission request in response to the sentinel prompt — a
model-behavior dependency. opencode 1.18.10, default model `big-pickle`. Not diagnosed further.

## Observation, not diagnosed

The reply metadata carried `sender_owner_relation: "unknown"` for a reply from a principal the
asker's own identity created. If that field is meant to say same-owner here, it did not.

## Hygiene

Listener stopped and verified `state: "stopped"` with `stoppedAt` set (not read off the
transitional `stopping` — the Wren/Joist rule). No `claude-agent-acp` or scratch-rooted processes
remained. Principal `dbb811b2` left in the workspace, named `dogfood016-worker`; its token
expires 8h after mint.

## Not established

- The ACP permission-request shape behind M-2 (see there).
- `codex` and `grok` providers — not exercised.
- Why opencode's canary fails at low load; whether `big-pickle` ever issues permission requests.
- Whether the M-3 decline boundary is set by our prompt provenance framing or by model policy
  alone, and how much legitimate same-owner work it refuses.
- The `sender_owner_relation: "unknown"` cause.
