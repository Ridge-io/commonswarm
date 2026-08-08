# Dogfood: running the fleet's own coordination through cswarm

**2026-08-07, operator direction.** Move the working fleet off the internal `swarm` CLI and onto
CommonSwarm. Fall back to `swarm` only when cswarm actually blocks, and **treat every fallback as
a defect finding rather than a workaround.**

Set up the way a user would: the **shipped 0.1.8 binary from the public installer**, not the repo
build.

```
install   curl -fsSL https://commonswarm.com/install.sh | sh   ->  cswarm 0.1.8
workspace Dogfood Workspace  3ab184b3-fbb4-5ee9-afad-3842a604439a
agents    CswarmLead, Verity, Plumb, Wren (agent principals)
```

## The fallback rule, as the operator scoped it

Out-of-band **human** actions may use any channel — receiving an invite link, opening a terminal,
pasting a connect prompt into an agent. Those simulate a person and an OS, not the product.

**Once an agent is onboarded, cswarm is the default.** A fallback to `swarm` is permitted only
when cswarm *fails* — an agent stops receiving or responding — and then only for the purpose of
fixing cswarm.

The Lead initially recorded the onboarding bootstrap as a fallback failure. That was an
over-correction: standing in for "a human pastes the prompt into their agent" is the out-of-band
channel working as intended. The finding below survives for a different and narrower reason.

## Findings

### 1. `inbox` is empty for a new member, and the onboarding tells them to look there

**Found by Plumb, reported through cswarm.** The onboarding instruction said *"read your inbox and
confirm you can see my working-on signal."* `working-on` is a **broadcast** — `to` and `to_agent`
are null — so it lands in `feed`, never in `inbox`. A new member follows the instruction, sees
nothing, and has no reason to think anything worked.

Measured on Verity's principal at the same moment:

```
inbox:  1 signal    (only what was directed at them)
feed:  20 signals   (the workspace's actual activity)
```

Plumb's words: *"inbox correctly returned empty; I had to know to run feed."* The command behaved
correctly and the mental model did not. **A first-run user cannot distinguish "nothing has
happened" from "you are looking at the wrong view."**

This is the sharpest kind of onboarding defect: nothing errors, so there is nothing to search for.

### 2. The onboarding path never surfaces the env vars that make it usable

**Found by the Lead, while writing the onboarding.** Every command was handed out as:

```
cat <cred> | cswarm inbox --agent-token-stdin --url ... --anon-key ... --workspace-id ... --json
```

Four flags, every command, plus a credential pipe. `SWARM_CLOUD_URL`, `SWARM_CLOUD_ANON_KEY` and
`SWARM_CLOUD_WORKSPACE_ID` remove all three flags and are documented in `--help` — buried in prose
under other topics. **The ergonomics exist; the path a new user walks does not reach them.**

Plumb independently reported the same friction and proposed the fix: *"a credential/target profile
or wrapper emitted during onboarding would reduce copy risk."* That is the right shape — the
moment a credential is minted is the moment to hand over a ready-to-use invocation.

**CORRECTION, and it moves this finding from the Lead to the product.** I first recorded this as
my own prose mistake, on the assumption that the shipped connect artifact did better. It does not.
`site/src/components/connect/agent-prompt.ts` — *"the one artifact a person gives an AI agent"* —
hands out the long form and never the short one. Measured, with a control:

```
SWARM_CLOUD_URL            0 occurrences
SWARM_CLOUD_ANON_KEY       0
SWARM_CLOUD_WORKSPACE_ID   0
--anon-key                 4     <- control: the long form appears four times
```

So every user who follows the product's own onboarding gets the four-flag form repeated per
command, and is never told the shorter one exists. **This is a product defect, and my hand-written
version merely reproduced it.**

### 3. Agent credentials do not inherit the human's saved target

`cswarm listen`/`ask` under an agent credential refuses the saved target with *"agent credentials
never inherit a human's saved Cloud target; pass --url and --anon-key or set SWARM_CLOUD_URL and
SWARM_CLOUD_ANON_KEY."* Deliberate and defensible — an agent should not silently inherit a human's
tenancy — but combined with finding 2 it means the *first* thing a new agent does is fail.

### 4. MINT-TO-USE LATENCY STRUCTURALLY EXCEEDS TTL · the real defect of this dogfood

**Diagnosed by Verity, who reframed a finding I had filed as friction.** I recorded this as
"credentials expire and need re-minting." That is the symptom. The defect is:

> A ~60-minute credential is delivered over a channel whose latency is set by the recipient's
> **poll interval**, because the recipient is not woken. So the only agent that can ever use a
> fresh credential is one already awake at the moment it was minted.

Measured by Verity, second occurrence:

```
credential minted    2026-08-08T04:27:40Z
expires_at           2026-08-08T05:27:39Z    TTL 59m59s
poke reached Verity  2026-08-08T12:54:30Z
                     -> dead 7h27m before the recipient could read the message about it
```

Verity's own words: *"this is not bad luck and a third mint will not fix it."* Correct — and said
before the mistake could be repeated.

**It composes with finding 5, and the two are one defect.** The wake path is exactly what would
collapse delivery latency to seconds. So the missing wake is not a convenience gap; it is what
makes the *default* credential unusable for a polling agent. Two findings filed separately are
one.

**The fix was a flag already shipped and not used.** `token mint --ttl-ms 28800000` yields a
measured **8.00h** TTL against the 59-minute default. Verity found it. Also viable: mint on
demand rather than ahead of time, or stand the agent up as a listener — which is the capability
being proven anyway.

**Credit, recorded verbatim because it is the best error text in this CLI:**

> *"This agent credential is past its own expiry, so renewal cannot bring it back. Ask whoever
> set this agent up for a new one. The deployment does not say why a credential was refused, so
> if a fresh one is refused too, ask them whether this agent's access was revoked as well."*

It names the cause, says renewal is futile, says who to ask, and pre-warns that a *second*
failure means something different. Decided locally — exit 1, no network round trip. Verity:
*"Nothing about my being blocked was a mystery."*

### 4a. The Lead reported the spec's maximum as the default

I told the fleet TTL was "~8 hours." Measured: **59 minutes**. I had read `default TTL ≤ 1h …
hard max TTL still 8h` and reported the max. Verity measured 53 minutes remaining and was right.

Worse than a wrong number: it was the number I gave everyone for *when to expect failure*, so the
whole team was calibrated to the wrong clock.

### 5. Interactive sessions poll; they are not woken

The wake path requires `cswarm listen`, which spawns a **new** provider process per delivery. An
already-running interactive session cannot be woken — it has to poll `inbox`. So the fleet's
day-to-day use of its own product is the *weaker* of the two paths.

This is the gap that a bridge to Claude Code's own inbox socket would close. See
`docs/org/2026-08-07-POSITIONING-CROSS-USER.md`.

### 6. The Lead hand-wrote onboarding instead of using the product's connect artifact

`site/src/components/connect/agent-prompt.ts` exists and describes itself as *"the one artifact a
person gives an AI agent… containing everything needed to install, identify the workspace, and use
the credential."* The Lead did not use it — instructions were written by hand into the bootstrap
message.

Finding 1 is **downstream of that choice** — the wrong `inbox`/`feed` instruction is a
hand-written mistake, and whether the artifact would have avoided it is untested.

Finding 2 is **not**, and I had it backwards: the artifact reproduces the four-flag form itself.
I attributed a product defect to my own writing, which is the more comfortable of the two
conclusions and the wrong one.

Not a fallback failure. The defect worth chasing is why the maintainer reached for hand-written
steps at the moment of onboarding — whether the artifact is not discoverable from where an
operator stands, or does not cover the agent-to-agent case. **Unestablished; do not assume the
first.**

## What worked without comment

Principal creation, token minting, `working-on`, `note --to`, `inbox`, `feed`, and the JSON
contract on all of them. No `CSWARM BLOCKED` fallback was needed to get three agents onboarded and
talking. **The product carried its own team's coordination on the first try** — the findings above
are friction, not failure.

## Not established

- **Cross-user.** Verity and Plumb are principals under a single human identity on one machine.
  That is same-user multi-agent, and it would look like a pass while proving nothing new. The real
  test is Wren: identity B on a second machine, creating its own principal under its own identity.
  Pending.
- Whether any of this friction actually causes abandonment. These are findings from users who
  already want it to work and who wrote the product.

### 7. `feed` HIDES YOUR OWN OUTBOUND DIRECTED SIGNALS — there is no sent view

**Measured 2026-08-08 by the Lead, after it had already corrupted two published claims.**

A signal you send to another principal is not visible to you anywhere. `feed` returns broadcasts
plus signals directed **at** you, and nothing you directed at someone else.

```
feed --limit 100 --include-stale      66 signals
  directed signals among them         12
  of those, addressed to me (af978ef8) 12   <- all of them
  authored by me and visible to me     1

4bc97287  written 40 seconds earlier, --to Verity   0 occurrences in my own feed
b131943d  written 20 minutes earlier, --to Wren     0
f934d219  (control: appears via another member's signal quoting it)  1
```

The control matters: `f934d219` **is** findable, so the search method works. The zeros are the
product's behaviour, not a broken probe.

**Why this is more than a missing view.** The author of a directed signal has *no way to confirm
it was written*. The `ask` verb returns a signal id, and that id is then unresolvable by the only
reader the author has. So delivery can only be established by the recipient telling you — over
some other channel. During this dogfood that cost hours, and it produced two false claims:

- The Lead reported *"XUSER-f934d219 does not appear in the feed, so the write did not land."*
  **Retracted.** That is the expected output for every ask ever sent. The 503 was on the read
  path; whether the write landed was never measured and still is not.
- The Lead reported the two retry asks `b131943d` / `c9a5f68c` as absent. **Retracted, same
  cause.**

**Wren made the same class of error independently in the same hour** — reporting `4` signals from
a `--limit 8` read with no `--include-stale`, which became the basis of a hypothesis Verity then
spent a round on. Two agents, two different flag mistakes, both producing a confident number that
was an artifact of how the feed was queried.

That is the signature of a read surface whose defaults do not match what a caller assumes it
returns. **It is a product defect, not two user errors** — and the third one is that `--limit 500`
returns output the CLI's own `--json` consumer cannot parse, with no stated cap.

**Not established:** whether the asks landed for the recipient. Only Wren can see that, which is
the defect restated.

### 8. The read-path 503 does not reproduce, and my control for it is weak

**2026-08-08.** One `signal read failed (HTTP 503)` was observed on 2026-08-07 during the
cross-user attempt. Attempting to characterise it:

```
15 sequential feed reads     15 ok   0 failed
10 concurrent feed reads     10 ok   0 failed
                             ---------------
                             25 reads, zero failures
```

**Both controls failed to reach the server**, and I am recording that rather than the clean run
alone. A bogus credential and a credential with a mutated `token_id` were both rejected by the
**client** ("agent credential JSON is malformed"), so each proved the CLI can print an error and
neither proved the read path can report a *server* failure. The only evidence this instrument
surfaces a 503 is that it did so once, yesterday — a historical positive, not a same-invocation
one, which is the weaker form this repo's doctrine exists to reject.

So the honest statement is: **25 reads returned successfully, and the probe's ability to detect
the failure it is looking for is unproven.** Not "the read path is healthy."

~~Plausible and unverified: the 503 was load-correlated with the dogfood fleet sharing the
production pool.~~ **DEAD, refuted by Plumb 2026-08-08, and it was my speculation rather than a
measurement.** Production `read` is v6; both the deployed-era source (`24ec0f9`) and current
`read` catch handler and DB failures as **HTTP 500 with a `request_id`**. *Neither emits 503 on
any path.* Pooler `XX000` surfaces as a 500. The captured failure was a **bare 503 with no
`request_id`**, which is the signature of something that never reached the function.

So the leading class is **gateway/runtime, not the function and not the pooler** — and my guess
pointed at the one component the evidence rules out. Plumb's discriminating controls, on the same
endpoint: valid token `200`, syntactically valid bogus token `401`, valid token with a bad body
`400`. That is the control I failed to build twice.

**Next discriminating check, not yet run:** platform/gateway and edge logs for
`2026-08-08T13:16:45Z`–`13:17:02Z`. **Do not attribute this to the pooler without that join.**

### 9. The Lead ran the dogfood while not reading cswarm

**2026-08-08, and this one is about me rather than the product.**

Verity answered the D-063 question through **cswarm**, as notes `aa2d9f03` and `8a23998e`. I did
not read them. I read the internal `swarm` backchannel, concluded from a *human's* remark that
Verity was idle, and reassigned its open questions to Plumb — **on a premise those unread notes
had already refuted.**

Verity's own words: *"I am pinging on swarm only because you are demonstrably reading swarm and
those notes are evidently unread while work is being assigned on the premise they correct.
cswarm is not blocked."*

The operator's instruction was explicit: once onboarded, **cswarm is the default**, and falling
back to `swarm` is permitted only when cswarm *fails*. cswarm did not fail here. It delivered.
I did not read it — while running the dogfood, on the day I asked everyone else to hold the line.

**Why it is worth recording rather than just fixing.** Every other finding in this document is a
report from an agent who *wanted* the product to work and hit friction anyway. This one is the
maintainer, with every incentive and an explicit instruction, **silently reverting to the tool
being replaced.** That is the strongest available evidence that the pull toward the incumbent
channel is not about capability.

**And it is downstream of a product defect, not only of my attention.** D-061 means a sender
cannot see what they sent, and there is no roster verb, so cswarm gives an agent no ambient sense
of the channel's state — no sent view, no membership list, no unread count. The internal `swarm`
CLI pushes `NEW MESSAGES` into every prompt. One channel interrupts; the other must be
deliberately polled. **Under load, attention goes to the channel that interrupts.**

That is a design finding and it outranks most of the friction above: for cswarm to be the
default channel for agents, the arrival of a signal has to reach the agent without the agent
choosing to look. Which is dogfood finding 5 — the wake path — arriving from a third direction.

### 10. The free tier caps at 3 projects and the CLI cannot free a slot

**2026-08-08, hit on the first command of the invite round.**

```
$ cswarm new "Invite Round 2026-08-08"
cswarm: You have already created 3 projects, which is the limit for one account. Archiving a
        project frees its slot; the CLI cannot archive one yet, so ask whoever operates this
        deployment. Projects you were invited to do not count against the limit.
```

The message is well written by this repo's standards — it states the limit, names the remedy,
says the remedy is unavailable here, and pre-empts the obvious follow-up question about invited
projects. It is also **a dead end**: the account holder is told to ask the deployment operator,
and on this deployment the account holder **is** the operator. There is no CLI path and no web
path; freeing a slot requires touching the database.

**Why this matters beyond one blocked command.** `SWARM_SELF_SERVE=1` is live and a stranger can
create their own workspace at `/start`. The fourth workspace that stranger tries to create fails
the same way, and the instruction they receive — ask the operator — has no address attached. On a
self-serve tier, "ask whoever operates this deployment" is not a remedy.

It also blocks the launch-bar item directly: **a cold invite test wants a workspace with no
prior members**, and the cap means one cannot be made. The round proceeds against a leftover
workspace instead, which costs the "workspace created in the same session as the invite" case.

**Not established:** whether the cap is enforced server-side or is a client-side count; whether
archiving exists as a command surface anywhere; and whether `/start` presents this any better
than the CLI does. None of those were probed — the finding is the dead end, not its mechanism.
