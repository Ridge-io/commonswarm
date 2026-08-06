# Agent → cloud → agent wake round trip, measured on the shipped 0.1.6

**2026-08-06. GREEN.** First measurement of the agent-to-agent wake round trip on v0.1.6.
The only prior green was v0.1.4 (2026-07-30, grok); 0.1.5 and 0.1.6 had never run a
production listener.

## The claim being tested

The operator's words: *"An agent can send a message to another agent through cswarm — cloud
round trip, not local — and the recipient, idle at the time, is woken by it and can reply."*

## Artifact — pinned

```
binary   cswarm 0.1.6, installed from https://commonswarm.com/install.sh
sha256   dee33d3268839e2353b30ac7ae2b6d414af099ba3eb23d578e910b7609aabeca
target   https://ukezjcnxjvkpkeezxaew.supabase.co   (production)
```

**Not** the `cswarm` on PATH, which is **0.1.1** on this machine — testing with that would have
measured a version nobody runs. **Not** a build of `main`, which carries post-0.1.6 changes
(the D-051 veto among them) that no user has.

## Rig

| | |
|---|---|
| workspace | `f9348277-54d0-4449-ba59-05bf9ba6e21f` |
| asker principal | `c0d2009c-e1c3-4c61-9408-fa765e64d043` (`wake-asker`) |
| replier principal | `38e69ed1-3088-4ad5-ab40-14e758c8d771` (`wake-replier`) |
| provider | **claude** (ACP bridge 0.64.2), `permissionMode: deny` |
| delivery mode | **`cursor_fallback`** |

Same user, same machine, two agent principals — which is exactly the case the operator named.

## Result — 9 seconds, wall clock

```
sent      2026-08-06T22:07:42Z
replied   2026-08-06T22:07:51Z

ask    id 7ee80522-430b-4f31-80d0-6e8a68d2dfe6
       from c0d2009c (asker)  to_agent 38e69ed1 (replier)  kind=ask
       body "PING WAKE-c766d514 — reply with exactly the token WAKE-c766d514 and nothing else."

reply  id d563a79b-7629-47e0-be46-4d157c9c9799
       from 38e69ed1 (replier)  to_agent c0d2009c (asker)
       in_reply_to 7ee80522-430b-4f31-80d0-6e8a68d2dfe6
       body "WAKE-c766d514"
       timed_out false
```

## The controls — without these it is a plausible result, not a measured one

1. **`in_reply_to` equals the ask id exactly.** Not a coincidental nearby message.
2. **The body is the nonce**, generated at send time, so no cached or replayed reply matches.
3. **The reply's author is the replier principal**, not some other agent in the workspace.
4. **Read back with a DIFFERENT credential.** The *human* credential's `feed` returns both
   rows. The reply provably exists server-side; it is not an artifact of the asker's process.
5. **The listener processed that exact signal** — `listen status` reports
   `lastSignalId: 7ee80522…`, `lastErrorCode: null`. This is what makes it a **wake** rather
   than a delivery: the resident listener consumed the ask and produced the reply.
6. **Idle before the send** — `lastSignalId: null` and `state: ready` since 22:06:56Z, with the
   ask sent 46s later.

## What this establishes about the ship-blockers

`deliveryMode: cursor_fallback`, observed at runtime in production. D-040, D-041, D-041a and
D-042 are all listener bricks reachable only under `durable_claim`, which the deployed `read`
v6 cannot advertise. **Confirmed at runtime, not merely inferred from the register.**
D-047's freeze on deploying `read` is what keeps this true — so a `read` deploy invalidates
this measurement.

## What did NOT work — three real findings

1. **grok fails its permission canary.** `permission_canary_failed` — "the host did not prove
   that CommonSwarm controls ACP tool permissions." grok is signed in and is exactly the
   pinned 0.2.117, and its local auth passes validation; the canary itself fails. **grok is
   the provider the only prior green (v0.1.4) used**, so this is a regression on that path or
   a grok-side behaviour change.
2. **opencode never becomes ready** — hit the 2-minute ready timeout.
3. **Three-project limit with no way out.** `cswarm new` refuses a fourth project: *"the CLI
   cannot archive one yet, so ask whoever operates this deployment."* A user who hits it is
   stuck, and the intended isolation control for this test (a fresh workspace) was
   unavailable. Compensated by asserting the reply's author principal, which is stronger.

So **one of three providers works.** The round trip is green on claude only.

4. **D-050 confirmed live, in the wild.** After a clean `listen stop` (which reported no error),
   the ACP bridge parent was gone but its `claude-agent-sdk` child **survived as an orphan**
   holding a session id. Teardown reports success while a worker persists — exactly D-050's
   shape. Killed by hand here; on a fleet doing this repeatedly, workers accumulate silently.
5. **Revoking an already-revoked token reads as a failure.** `token revoke` returns
   *"Token revocation was refused: token_revoked. The credential is unchanged."* The security
   outcome is right, but the sentence tells an operator their revoke did not happen when the
   credential is in exactly the state they wanted. Cosmetic, non-blocking, worth fixing in a
   copy pass.

## Not established

- Whether grok's canary failure is a cswarm regression or a grok-side change. Not diagnosed.
- Anything about a **cold** recipient — "idle" here means *listener resident, model asleep*.
  A recipient with no listener process running is not woken; the message waits in the inbox.
  That is the system's actual semantics and it should be stated plainly rather than implied.
- Multi-machine or multi-user. This was same-user, same-machine, as specified.
- Behaviour under pooler load. One listener is ~0.5 req/s; this ran clean, and no sustained
  burst was in flight.
- Whether the reply path survives a listener restart or a credential rotation mid-flight.
