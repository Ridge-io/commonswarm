# Cross-machine UX test harness (`uxtest`)

**Purpose:** run repeatable, end-to-end onboarding tests of coswarm with **two role-playing
human operators on two real machines** — real distinct GitHub identities, real authenticated
browsers, genuinely different system configs — and collect honest, human-like UX feedback.

**Why it exists (operator directive, 2026-07-24):** without it, the operator personally
copy-pastes invite material between two laptops to test one flow. That is slow, and it means
UX feedback arrives once instead of every time we change something. This harness makes the
§1c felt-dogfood loop **repeatable**.

**What it is NOT:** it is not a replacement for the operator's own drive. Role-play agents
approximate a human; the operator's real reaction remains the final word (§1c). This harness
catches the obvious friction *before* we spend the operator's attention on it.

---

## 0. The methodology rule that makes this valid

**The persona agents must be as ignorant as the humans they represent.** If a persona reads
our design docs, it knows the intended flow and stops being a test subject — it will "succeed"
through knowledge no real user has, and the harness will report a UX that does not exist.

Therefore, **hard isolation rules** (enforced by the launch scripts, restated in every persona):

1. Personas run from a neutral working directory (`~/uxtest/human1/`, `~/uxtest/human2/`) —
   **never** the `cloud-swarm` repo.
2. Personas **must not** read the `cloud-swarm` repo, its design docs, its tests, its git
   history, or this file. Not even to "check what the command is."
3. Personas **must not** read each other's terminals (`swarm read` is forbidden to them).
4. Personas learn the product only from: the CLI itself (`--help`, error messages, output),
   what their partner tells them over the chat channel, and their persona brief.
5. **Human1 is not told how to invite anyone.** Discovering that is the test.
6. Feedback is collected **before** anyone explains the intended design to them.

A round where a persona breaks isolation is **void**. Say so in the report rather than
salvaging it.

---

## 1. Topology

| Role | Machine | User | Identity | Agent mechanism |
|---|---|---|---|---|
| **Human1** (inviter, semi-technical) | `yulanbots-mac-mini` `100.127.131.115` | `yulanbot` | GitHub identity **A** | cmux tab agent (`swarm spawn`) |
| **Human2** (invitee, non-technical) | `toms-m1-max-mbp` `100.95.177.37` | `tom` | GitHub identity **B** (distinct verified email — field lesson #5) | **persistent cmux tab agent, started once in the laptop's GUI session** (see §1.1) |

**The chat channel ("Slack/iMessage")** is the *local* `swarm` CLI over Tailscale —
deliberately a **different system** from the coswarm product under test, so the thing being
tested is never also the transport. Personas exchange short, human, jargon-free messages.

- Each machine runs `swarm serve` (A2A endpoint, default port 18790, advertises Tailscale IPv4).
- Each registers the other with `swarm register-a2a`.
- Personas live in a dedicated swarm (`uxtest`), **not** `cloud-swarm`, so build-team chatter
  and persona chatter never mix.

### 1.1 Machine-2 ground truth (probed 2026-07-24 — do not re-derive, do not assume)

- `node v24.14.1`, `claude 2.1.217`, `swarm`, `gh`, `screen`, **`cmux.app` installed and
  running** (`/Applications/cmux.app`, a GUI app — it is NOT on `$PATH`, so `command -v cmux`
  reports nothing; that is a false negative).
- `coswarm` is `/opt/homebrew/bin/coswarm` → symlink to
  `~/Developer/Ridge.io/cloud-swarm/dist/cli.js`, so **rebuilding `dist` updates the binary;
  no relink needed**.
- That repo was at `cbb9c89` — **stale by all of P2-1**. Every round must sync + rebuild it
  first, or the test measures old code.
- SSH key auth mini→laptop works; Tailscale RTT ~52ms.
- `osascript` over SSH **can** reach the GUI (System Events responds), but reading Terminal
  window contents is blocked by Automation permissions, and driving `swarm spawn` through a
  Terminal `do script` produced no joined agent. **Do not build on GUI automation over SSH.**

### 1.2 THE HARD CONSTRAINT: Claude Code auth is GUI-session-bound

```
$ ssh laptop 'claude -p "..."'   →   Not logged in · Please run /login
```

Claude Code's credentials on the laptop live in the GUI login session's keychain, which an SSH
session cannot unlock. **Therefore Human2's agent cannot be launched over SSH.** This is a
platform constraint, not a missing feature — no amount of scripting removes it without either
the operator's keychain password or an `ANTHROPIC_API_KEY` (which would contradict §1c's
"subscriptions, not API fees" thesis and change what we are testing).

**Consequence — the one manual step:** the operator starts Human2's agent **once** in a cmux
tab on the laptop; it joins the `uxtest` swarm and **persists across rounds**. From that point
every round is driven remotely from the mini: resets, briefs, scenario, feedback collection.

That is one command, once — against the status quo of hand-carrying every invite link between
two laptops for every test.

```bash
# on the laptop, in cmux, once:
swarm spawn --agent claude --name Dana -s uxtest      # or open a tab and: swarm join Dana -s uxtest
```

### 1.3 Transport (the "Slack") — verified constraints

- The mini **already serves an unrelated A2A bridge ("Yulan") on port 18790**. The harness
  **must not** disturb it — use a dedicated port (e.g. `18791`) for uxtest.
- The laptop is not serving anything on 18790; `swarm serve` there is plain node (no GUI, no
  Claude auth needed) and can be started over SSH.
- `swarm inbox --wait <seconds>` blocks until a message arrives — use it for event-driven
  waiting, never busy-polling.
- Both machines now have the `uxtest` swarm created.

---

## 2. Round lifecycle

Every round is: **preflight → reset → channel up → launch → run → collect → report**.

```
uxtest/scripts/preflight.sh          # both machines ready? versions, reach, PATH, identities
uxtest/scripts/sync-machine2.sh      # rsync repo + npm install + npm run build on the laptop
uxtest/scripts/reset-round.sh <n>    # FRESH workspace for round n; log both humans out; clear profiles
uxtest/scripts/channel-up.sh         # swarm serve + register-a2a, both directions
uxtest/scripts/launch-human1.sh <n>  # cmux tab agent here
uxtest/scripts/launch-human2.sh <n>  # ssh + screen + driver loop on the laptop
uxtest/scripts/collect-round.sh <n>  # gather transcripts, feedback, metrics into rounds/<n>/
```

### Reset policy — additive, never destructive

`create_workspace` is not wired yet, so a round's workspace is seeded with a privileged
`DATABASE_URL` (the `seed-fixture` path). **Each round seeds a NEW workspace** rather than
deleting last round's rows.

**This is deliberate: prefer additive setup over destructive cleanup near a real hosted
database.** Dead test workspaces accumulate harmlessly; a buggy delete script does not.
Name them `uxtest-r<n>-<short-random>` so they are obviously test data.

Per-round client-side reset (both machines): `coswarm logout`, then remove the local profile
sidecar so no default workspace / principal checkpoint leaks between rounds. A round that
starts with a warm login is testing the wrong thing.

---

## 3. What each round measures

**Objective (collected by the scripts, not self-reported):**
- wall-clock from "human2 receives the link" to "human2's agent is connected"
- count of `coswarm` invocations per persona, and how many exited non-zero
- how many times each persona ran `--help` or otherwise hunted for the command
- how many times a persona asked their partner for help / said they were stuck
- did they complete the shared work task
- any command that produced output the persona could not interpret

**Subjective (each persona writes it, in their own voice, before any debrief):**
- what they thought was happening at each step, and why
- the moment they felt most lost
- anything that read as an error but was not (or vice versa)
- what they expected to happen but did not
- would they have given up if this were not a test

---

## 4. Deliverables per round

```
uxtest/rounds/<n>/
  transcript.md          the full chat exchange, verbatim
  human1-feedback.md     persona's own words, pre-debrief
  human2-feedback.md     persona's own words, pre-debrief
  metrics.json           the objective numbers
  REPORT.md              Lead's synthesis: findings ranked, what to change, what to re-test
```

`REPORT.md` findings feed scoping directly. A finding that names a specific command's output
is worth more than a general complaint — quote the exact line the persona saw.

---

## 5. Scenario 01 — connect + a small shared task

Round 1 scope is deliberately narrow: **can two people connect their agents and do one small
thing together?** The work task exists only to give the connection a purpose, so the personas
have a reason to care whether it worked.

Details in `uxtest/scenarios/01-connect.md`.

Later scenarios (not built until 01 runs clean): a third human joining an existing workspace;
one human's agent picking up work the other filed; reconnect after logout; joining from a link
that has expired.

---

## 6. Running it

```bash
# one-time per machine pair
uxtest/scripts/preflight.sh

# each round
uxtest/scripts/sync-machine2.sh
uxtest/scripts/reset-round.sh 1
uxtest/scripts/channel-up.sh
uxtest/scripts/launch-human1.sh 1
uxtest/scripts/launch-human2.sh 1
# ... personas run the scenario ...
uxtest/scripts/collect-round.sh 1
```

Every script is idempotent and prints what it did. A script that cannot verify its own
postcondition must **fail loudly**, not continue — a silently half-set-up round produces
feedback about our harness instead of our product.
