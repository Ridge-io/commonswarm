# Cross-user, cross-machine WAKE round trip — measured

**2026-08-09.** The first run that joins the two halves. Every prior measurement had one or the
other:

| | recipient idle, woken | cross-user / cross-machine |
|---|---|---|
| 2026-08-06 | yes — listener resident, model asleep | no — same user, same machine |
| 2026-08-08 | no — the recipient was live and answering | yes |
| **this run** | **yes** | **yes** |

## The run

```
sender     CswarmLead  principal af978ef8  identity d37e2ff2  yulanbots-mac-mini
recipient  Wren        principal 3a37b055  identity 919ce195  toms-m1-max-mbp
workspace  Dogfood Workspace 3ab184b3-fbb4-5ee9-afad-3842a604439a

listener   pid 68357, provider opencode, permissions deny
           state ready since 2026-08-09T23:04:42.826Z, instance ca11e1cb

ask        b194da9f-d863-4901-a7c3-1c0261df5bbc   to_agent 3a37b055
reply      de17a903-e37d-4bbf-9d99-0641a4e8ac01   from     3a37b055
           in_reply_to b194da9f-…
           body "XWAKE-7fd6dc78 — awake. Ready."
timed_out  false
```

## The controls — five, and the fourth is the one that makes it a wake

1. **`in_reply_to` equals the ask id exactly.** Not a nearby message.
2. **The body carries the send-time nonce** `XWAKE-7fd6dc78`, generated at send. No cached or
   replayed reply matches it. **The recipient never saw the nonce until it was quoted back.**
3. **The reply's author is `3a37b055`** — the recipient's own principal, under a different human
   identity, on a different machine. Not `af978ef8` and not `d37e2ff2`.
4. **`listen status` reports `lastSignalId: b194da9f-…`** — the ask id. Against a prior value
   **recorded before the send**, `b3672560-…`. It changed, and it changed to exactly this ask.
   **This is what makes it a wake rather than a delivery:** the resident listener consumed the
   signal and its worker produced the reply.
5. **Read back under a different credential.** The *human* credential's `feed` returns the reply
   independently, so it exists server-side and is not an artifact of the asker's process.

## Why control 4 is a positive identification rather than an absence argument

The 08-06 run could assert `lastSignalId: null` before the send. **This listener could not** — on
reaching ready it immediately drained roughly twenty backlog signals, so a virgin null was
unavailable.

Wren declined to restart for a tidy null, and the reasoning is the right one: the canary is
**intermittent** (measured the same evening — 22:00:14 failed in 6.8s, 23:04:34 reached ready in
8.2s, byte-identical config), so a restart was a real coin flip that could have spent a working
listener. A **known recorded prior value that changes to the ask id** is a stronger claim than an
absence anyway: absence says nothing arrived; this says *this exact thing* did.

## What the recipient did NOT do, which is what keeps the control clean

No polling, no `inbox` read, no `feed` read, no manual reply, no restart, no config change.
Between `ready` and the ask, the only command issued against that workspace was `listen status`,
which reads listener state and consumes nothing.

## Not established

- **Two humans.** Both identities are operated by the same person. It is cross-account and
  cross-machine in every sense the product enforces, and no rig has ever had two people in it.
- **Wake latency.** The reply returned inside a 150s wait; it was not timed.
- **Any provider but opencode.** The claude and codex adapters have still never run anywhere.
- **Reliability.** One success. The listener that served it failed its own canary an hour earlier
  on identical config, so *reaching* this state is intermittent even though the round trip, once
  ready, worked first time.
