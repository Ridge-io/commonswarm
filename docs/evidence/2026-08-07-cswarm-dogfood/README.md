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
