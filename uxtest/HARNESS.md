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

- The persistent launcher control plane is separate from each round's persona channel:
  laptop `Dana` serves on `100.95.177.37:18791`, while mini `UxDriver` serves on
  `100.127.131.115:18792`.
- Round personas use laptop port `18790` (`Dana-r<n>`) and mini port `18791`
  (`Avery-r<n>`), registered only in `uxtest-r<n>`.
- Launcher control lives in `uxtest` and persona chat in `uxtest-r<n>`, **not**
  `cloud-swarm`, so build-team chatter and study traffic never mix.

### 1.1 Machine-2 ground truth (probed 2026-07-24 — do not re-derive, do not assume)

- `node v24.14.1`, `claude 2.1.217`, `swarm`, `gh`, `screen`, **`cmux.app` installed and
  running** (`/Applications/cmux.app`, a GUI app — it is NOT on `$PATH`, so `command -v cmux`
  reports nothing; that is a false negative).
- `coswarm` is `/opt/homebrew/bin/coswarm` → symlink to
  `~/Developer/Ridge.io/cloud-swarm/dist/cli.js`, so **rebuilding `dist` updates the binary;
  no relink needed**.
- The laptop's Git `HEAD` is **not** a version signal for this harness: exact source content is
  rsynced from the mini while Git history may intentionally lag. The order-stable SHA-256
  manifest of every file in the built `dist/` tree is the sole version authority.
- That repo was at `cbb9c89` — **stale by all of P2-1**. Every round must sync + rebuild it
  first, or the test measures old code.
- SSH key auth mini→laptop works; Tailscale RTT ~52ms.
- `osascript` over SSH **can** reach the GUI (System Events responds), but reading Terminal
  window contents is blocked by Automation permissions, and driving `swarm spawn` through a
  Terminal `do script` produced no joined agent. **Do not build on GUI automation over SSH.**

### 1.2 THE LAPTOP GUI-ORIGIN RULE: four layers, one constraint

```
$ ssh laptop 'claude -p "..."'   →   Not logged in · Please run /login
```

**General rule: anything that must reach laptop GUI state must originate inside the laptop GUI
session.** Four observed layers share that one root cause:

1. Claude authentication is unavailable to SSH.
2. `swarm spawn` cannot create/control the GUI cmux surface from SSH.
3. The `coswarm` refresh credential in the GUI login keychain cannot be read from SSH.
4. An A2A `swarm serve` process started over SSH can accept and queue a POST, but cannot push
   it into a cmux tab.

Therefore Human2 cannot be launched, logged out, keychain-verified, or pushed an A2A message
by an SSH-origin process. This is a platform boundary, not a missing flag. SSH remains valid
for file sync, read-only state, starting services that do not touch GUI state, and registering
remote endpoints.

**Consequence — the one manual step:** the operator starts the persistent **launcher** `Dana`
once in a cmux tab on the laptop; it joins the base `uxtest` swarm. The mini then drives
GUI-bound reset and fresh `Dana-r<n>` creation through Dana's launcher-level A2A bridge. Dana
is never a study persona and stays out of every per-round swarm.

That is one command, once — against the status quo of hand-carrying every invite link between
two laptops for every test.

```bash
# on the laptop, in cmux, once:
swarm spawn --agent claude --name Dana -s uxtest      # or open a tab and: swarm join Dana -s uxtest

# after sync-machine2.sh has installed the helper, run inside Dana's GUI cmux session:
UXTEST_HOME_ROOT=/Users/tom/uxtest \
  /Users/tom/Developer/Ridge.io/cloud-swarm/uxtest/scripts/serve-human2-gui.sh launcher
```

### 1.3 Transport (the "Slack") — verified constraints

- The mini **already serves an unrelated A2A bridge ("Yulan") on port 18790** — confirmed live by
  its agent-card (`name: "Yulan"`). **★ Do not "correct" this to Anvil.** The `cloud-swarm`
  registry lists `Anvil [a2a] @ http://127.0.0.1:18790/`, which is a **registry entry pointing at
  Yulan's bridge**, not a second server. Both facts are true at once, and reading the registry
  record as evidence about the live endpoint produced a wrong "doc is stale" report on
  2026-07-24 that briefly corrupted this line. *A registry entry naming an address is not an
  observation of what serves that address* — same class as §7.9b item 3. The harness
  **must not** disturb it. Mini ports `18791` (round persona) and `18792` (launcher driver)
  are dedicated to uxtest.
- Laptop port `18791` is the persistent Dana launcher endpoint and **must bind the Tailscale
  IP explicitly**; `0.0.0.0` did not produce a reachable field result. It must be started by
  `serve-human2-gui.sh launcher` inside GUI cmux; `launcher-channel-up.sh` verifies that
  origin marker and never starts it over SSH. Laptop `18790` is reserved for the current
  `Dana-r<n>` persona endpoint, whose server Dana starts from the GUI on demand.
- An SSH-origin Dana server accepted the A2A POST and logged the message, then reported
  `[a2a-server] push to Dana not delivered: Dana's terminal is not reachable via the cmux socket`.
  Accept-and-queue is a recovery property, not success: `swarm inbox --swarm uxtest` from
  Dana's GUI tab can recover the queued instruction, but the preflight still fails until a
  GUI-origin server is proven.
- **Identity-bearing headless swarm state does not survive separate SSH invocations**:
  `join` + `send` and `SWARM_AGENT_NAME` both failed with `identity could not be authenticated`.
  SSH is therefore not a launcher control plane; the A2A bridge is the only supported one.
- `swarm inbox --wait <seconds>` blocks until a message arrives — use it for event-driven
  waiting, never busy-polling.
- Both machines now have the `uxtest` swarm created.

---

## 2. Round lifecycle

Every round is: **preflight → launcher channel → reset → launch Human2 → round channel →
launch Human1 → run → collect → report**.

```
uxtest/scripts/sync-machine2.sh      # rsync repo + npm install + npm run build on the laptop
uxtest/scripts/preflight.sh <n>      # fails early with exact GUI-bootstrap remedy if absent
uxtest/scripts/launcher-channel-up.sh # verifies GUI Dana; starts/registers mini UxDriver
uxtest/scripts/reset-round.sh <n>    # FRESH workspace; Human2 reset delegated to GUI Dana
uxtest/scripts/launch-human2.sh <n>  # persistent GUI tab spawns fresh Dana-r<n>; evidence-gated
uxtest/scripts/channel-up.sh <n>     # asks GUI Dana to serve Dana-r<n>; verifies both directions
uxtest/scripts/launch-human1.sh <n>  # fresh cmux persona tab here
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
sidecar so no default workspace / principal checkpoint leaks between rounds. Human2's logout
and keychain postcondition run inside Dana's GUI session and return a state artifact; SSH cannot
make that assertion. A round that starts with a warm login is testing the wrong thing.

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
  transcript.md          the chat exchange, verbatim EXCEPT redacted capabilities (§4.1)
  human1-feedback.md     persona's own words, pre-debrief
  human2-feedback.md     persona's own words, pre-debrief
  metrics.json           the objective numbers
  REPORT.md              Lead's synthesis: findings ranked, what to change, what to re-test
```

`REPORT.md` findings feed scoping directly. A finding that names a specific command's output
is worth more than a general complaint — quote the exact line the persona saw.

### 4.1 Capability redaction in artifacts — security beats literal "verbatim"

The chat **necessarily carries a live invite capability** — that is the delivery mechanism under
test, and the channel is *supposed* to carry it. But `rounds/<n>/` is a **committed git
artifact**, and our standing rule is that bearer material never lands in transcripts, logs, or
artifacts. Git history is permanent; a private repo is not a defense.

**Ruling: redact in artifacts. The live channel stays untouched** — do not weaken the scenario
to avoid the conflict.

Redaction requirements:

1. **Mirror the §3.3 parse grammar, not just the pretty prefix.** A prefix match on
   `coswarm://accept/` misses the other valid forms. Redact all three: the
   `coswarm://accept/<base64url>` form, a **bare base64url payload** (valid per the grammar), and
   a raw `swm_inv_…` token. Replace with `[INVITE LINK REDACTED]` / `[INVITE TOKEN REDACTED]`.
2. **Redact in-flight; never write the raw material to disk.** Do not write a raw transcript and
   then rewrite it — that leaves the payload on disk and stageable, which is the thing we are
   preventing.
3. **Metrics come from server-authoritative DB event timestamps, not from parsing the chat.**
   This is better methodology anyway, and it means redaction costs us no measurement.
4. **Capture the fact before destroying the payload.** Whether a persona pasted a capability into
   chat, and in which form, is itself a UX finding — a user treating a credential like a chat
   message tells us something. Record `link_pasted_in_chat` and `link_form: uri|bare|token`
   **before** redacting. We lose the secret, not the signal.

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
# sync before preflight so the fail-closed version gate sees the intended build
uxtest/scripts/sync-machine2.sh

# one-time laptop GUI bootstrap (preflight prints this exact remedy if missing)
UXTEST_HOME_ROOT=/Users/tom/uxtest \
  /Users/tom/Developer/Ridge.io/cloud-swarm/uxtest/scripts/serve-human2-gui.sh launcher

# each round
uxtest/scripts/preflight.sh 1
uxtest/scripts/launcher-channel-up.sh
uxtest/scripts/reset-round.sh 1
uxtest/scripts/launch-human2.sh 1
uxtest/scripts/channel-up.sh 1
uxtest/scripts/launch-human1.sh 1
# ... personas run the scenario ...
uxtest/scripts/collect-round.sh 1
```

Every script is idempotent and prints what it did. A script that cannot verify its own
postcondition must **fail loudly**, not continue — a silently half-set-up round produces
feedback about our harness instead of our product.

---

## 7. Validity protocol — AUTHORITATIVE (folds Sable's methodology review)

Where this section conflicts with anything above, **this section wins.** It exists because a
role-play UX harness fails silently: it returns confident feedback about a user who does not
exist. Sable's verdict on v1 was **CONDITIONAL GO as a pilot, NO-GO as a repeatable regression
oracle**, and these are the conditions.

### 7.1 The honest boundary — reproduce this table in every REPORT

| Failure class | Does this harness catch it? |
|---|---|
| Missing / confusing CLI output | **Yes** (strong) |
| Dead ends, non-zero loops, wrong next-action in errors | **Yes** (strong) |
| Unexplained multi-step flows, missing narration | **Yes** (strong) |
| Broken happy path / version skew | **Yes** (strong — preflight must fail closed) |
| Link hygiene (`--link-stdin` vs positional), origin-pin refusal | **Yes** (medium–strong) |
| Partner-coordination confusion over chat | **Partial** |
| Real emotional friction, fear/trust around OAuth | **No** — systematic miss |
| Wall-of-text terminal scanning difficulty | **No** |
| Genuine giving-up under time pressure | **No / rare** — LLMs grind |
| Misreading jargon the way humans do | **No** — LLMs parse jargon too well |
| Install / PATH discovery as a civilian | **Weak** |

**Therefore: findings describe an *engineer-adjacent first-time user with no internal
knowledge*, NOT a non-technical human.** Human2 keeps a behavioural non-technical *tilt*
(prefers the obvious thing, asks a colleague, avoids long help text) but no finding may be
reported as "a non-technical user couldn't do X" without that asterisk. The operator's own
drive remains the final word (§1c) — this harness catches the obvious friction *before* we
spend their attention.

### 7.2 Leakage channels — closed (each was a real hole in v1)

1. **The invite link is base64url.** An LLM will decode `coswarm://accept/<payload>` and learn
   the project URL, anon key, `workspace_id`, `inviter_user_id`, and labels — collapsing
   "discover by using the product" into "read the credential." **Personas are forbidden to
   decode, print, or inspect link contents**; they may only paste it into a command the CLI
   documents. Metric: `link_inspected`. Violation → **round void**.
2. **`which coswarm` → symlink → the repo.** Personas get a **copied** binary at
   `~/uxtest/bin/coswarm` on their PATH — never a symlink into the repo. Preflight asserts the
   persona's PATH resolves to the non-repo copy. Personas may not inspect installation paths or
   open files behind the command.
3. **Working tree leakage.** Each persona has one trusted cwd,
   `~/uxtest/human{1,2}/workspace/`, **verified before every launch to contain only this
   round's `BRIEF.md`**. Scenario full text and this file never enter a persona cwd. Collect
   pulls artifacts *out*, verifies the round output, and removes the raw persona artifacts
   before the trusted directory can be reused. Virgin context comes from a fresh Claude
   session, not a fresh directory (§7.9b).
4. **Chat history.** Use a per-round swarm `uxtest-r<n>` (clean inbox). Never reuse a message
   board that still holds a prior round's links, commands, or jargon.
5. **Web search / public repo.** Forbidden for this product during a round. Violation → void.
   Pretraining residual cannot be eliminated — label it as bias, don't pretend it's absent.
6. **The brief itself.** Human1's brief states the **goal** ("get Dana's agent working with you
   on this project"), never the **mechanism**. If a brief contains the word `invite` as a
   command, the discovery test is already burned. Same for the driver: it injects goals and
   constraints, **never step lists**. Any "now run `coswarm accept`" from the driver voids the
   round.
7. **Partner as solution bus.** Human1 will otherwise paste the winning command. Realistic, but
   it masks the gap. Rule: **10 minutes of solo struggle before partner help is allowed**
   (everything before that is the gold data), and after a stuck signal the partner may share
   *outcomes and symptoms* ("I've got a link", "mine errored") but **never argv**. Findings are
   tagged `solo` or `partner-rescued`.
8. **`--help` is allowed** (it is real product surface) but report a parallel score: completed
   **without** help vs **with** help. Human2's brief adds soft pressure to try the obvious
   thing or ask a colleague before reading long help text.

### 7.3 Success pressure — the objective is inverted

Both briefs state it plainly:

> **Your primary job is an honest play-by-play of what confused you.** Completing the task is
> secondary. **Stopping because you are stuck is a successful outcome for this study** — write
> down why you stopped.

The driver **must not nag** "try again" after a give-up declaration; a give-up triggers collect.
Personas also keep a **mid-flight journal** — one line after every `coswarm` command: what I
expected / what happened / how I feel. End-only feedback gets retroactively rationalised;
mid-flight notes do not.

### 7.4 Cross-round contamination (B1) — the repeatability blocker

A persistent Human2 tab means round 2 *remembers* round 1. A "forget round 1" instruction is
theater. Protocol, in preference order:

1. **A fresh persona agent per round.** The auth constraint is "cannot *start* Claude over
   SSH", not "cannot start another tab inside an already-logged-in GUI session." So the
   long-lived tab acts as a **launcher**: it runs `swarm spawn --agent claude --name
   Dana-r<n> -s uxtest-r<n>` to create a virgin-context sibling for the round, then stays out
   of it. **Probe this once; if it works it is the answer.**
2. Else a **hard context cut**: new conversation (`/clear`) plus prior transcript physically
   moved out of the persona's cwd before briefing.
3. **Always** record `carryover: true|false` in `metrics.json`.
4. **Never** compare wall-clock across rounds as product improvement unless `carryover=false`.

**R2+ is not a regression oracle until this is real.** R1 is a discovery pilot.

### 7.5 Confounders that fake improvement

- **OAuth consent state.** Round 2's GitHub OAuth is often "already authorized," so connect
  time drops for reasons unrelated to us. Record `oauth_consent: first|returning`; never tout a
  faster R2 without that split.
- **Version skew.** Record `coswarm_sha` for **both** machines; **preflight fails closed if
  they differ.** (The laptop was stale by an entire slice — §1.1.)
- **Warm login.** Both machines log out and drop the profile sidecar per round.
- **Keychain error ambiguity (product finding, do not normalize in the harness).** The exact
  message `coswarm: unable to read the refresh credential from macOS Keychain` means either
  the GUI login keychain is inaccessible/locked **or** no refresh credential is stored (not
  logged in). A human and a script see the same text and cannot tell which state occurred; the
  field run required manual keychain/profile inspection to disambiguate. This is a §1c output
  defect for a future CLI-copy slice, not a reason to hide the path with harness behavior.
- Leftover test workspaces are *not* a confounder — additive reset stays.
- **Multi-project resolution is the measured path.** From round 1 onward identity A
  necessarily holds 2+ live memberships under additive reset, so every round exercises
  multi-project resolution (`workspaces` → `use` → `invite`). A round is **not** evidence about
  the sole-membership shortcut path. `preflight.sh` keeps a read-only current/projected count
  (`current + 1` before additive reset, otherwise current), warns when the multi-project path
  applies, and records both counts plus `multi_project_path` for attribution. Do not inject a
  hidden workspace ID, reuse an existing fixture, or pre-select the new workspace: discovering
  selection is now a legitimate part of the §1c flow.
- **P2-2 removed the old multi-membership blocker.** Resolution now fails closed with a
  deterministic workspace list and guidance, while `coswarm workspaces` and
  `coswarm use <full-id|exact-name>` expose the recovery path. The harness therefore records
  projected multi-membership instead of refusing the round.
- **Workspace creation is not under test.** Each round uses the privileged, fixture-only
  `seed-fixture` bridge because governed `create_workspace` is not wired yet. No report may
  claim to test real workspace creation. Migrate the harness to the governed command when it
  lands so the setup path does not permanently diverge from the product.

### 7.6 `metrics.json` schema (script-collected, never self-reported)

```
wall_clock_link_to_connected, command_interval_timeline[],
coswarm_invocations, nonzero_exits, unique_error_strings[],
help_invocations, completed_without_help,
help_requests_to_partner[] (quoted), partner_rescued_steps[],
time_to_first_coswarm, time_to_first_accept_attempt,
command_sequence[], golden_path_distance,
used_link_stdin, used_positional_link, link_inspected,
task_completed, gave_up, gave_up_reason,
coswarm_sha_mini, coswarm_sha_laptop, workspace_id, seed_sha,
oauth_consent, carryover,
multi_project_path, current_live_memberships, projected_live_memberships,
join_latency_ms, join_attempts, isolation_void
```

Two traps, stated so nobody misreads the numbers: **wall-clock alone is confounded** by partner
latency, OAuth, and model speed — read the interval timeline; and **zero errors is not good UX**
if the partner pasted the answer.

### 7.7 Mandatory REPORT.md header

```markdown
## Validity
- Role-play bias: LLM ≠ non-technical human — classes we cannot claim: [§7.1 "No" rows]
- Carryover: true/false  (if true: no discovery-UX claims)
- Isolation: clean / VOID  (if VOID: stop, do not rank findings)
- Partner-rescued steps: [quotes]
- Version under test: mini <sha> / laptop <sha>  (must match)
- OAuth consent: first / returning
```

Findings are ranked **only** if isolation is clean, and every finding **quotes the exact CLI
line** the persona saw.

### 7.8 Gate

| Question | Answer |
|---|---|
| Run R1 as a pilot? | **Yes** — after §7.2 items 2–3 (copied binary + swept trusted cwd), §7.7 header, and §7.9 |
| Trust R1 as product truth? | Only for the §7.1 "Yes" rows; the operator's drive still decides |
| Run R2+ as regression? | **No** until §7.4 is implemented and `carryover` is recorded |

### 7.9 BRIEF generator contract + mechanical enforcement

The generated per-round `BRIEF.md` is the **highest-leakage artifact in the harness** — it is the
one document the persona is told to read. Prose rules are not enough here; a single wrong noun
burns the round. So the contract is enforced by a lint, not by care.

**Goal framing (the fixture problem).** `reset-round.sh` seeds Avery a workspace and then logs
both users out, so a brief saying "your **new** project workspace" sends her hunting for a
create/init command **that does not exist** — a burned round producing a finding about a known
unwired gap rather than about P2-1. Frame it as already-existing, without teaching the missing
command:

> Goal: get `<partner>`'s agent working with you on **your team's project** (it already exists
> for this work). Signing in and connecting are part of what you need to figure out; the study
> will not teach you the steps.

**Never** write "you don't need to create one" (teaches `create`), "workspace id", or
"provisioned by the harness".

**Vocabulary.** Prefer "project" / "team project" / "shared project". Reserve "workspace" for
when the *product itself* prints it and the persona quotes it — priming the noun helps a `--help`
search that a real user would not run. Do not stack it ("cloud workspace", "workspace id").

Also banned: **"opaque item"** and similar — describing the thing Avery sends as an opaque
item/link/token primes a capability mental model *before the product introduces one*. Say "use
only what `<partner>` sends you and what `coswarm` itself says." Opacity is already covered by
the isolation rules.

Naming `coswarm` **is** allowed and necessary (they must know which CLI exists), as is the
`swarm send` chat recipe (a different system, required to talk at all).

**The lint (fails the launch, not the round).** Refuse to launch if a rendered `BRIEF.md`
matches:

```
(invite|accept|login|principal|swm_|--link|workspace-id|opaque item)
```

**Audit.** Dump every rendered brief to `rounds/<n>/briefs/` — operator-visible, **never** inside
a persona cwd.

### 7.9b Spawn reality: the trust dialog, and never trusting exit 0

Two field findings from standing the laptop launcher up (2026-07-24), both verified by controlled
comparison rather than inference:

**1. Claude Code's trust-folder modal silently eats the join prompt.** `swarm spawn` types
`/join-swarm …` on a **fixed timer** after "Waiting for Claude Code to initialize…", not on a
readiness signal. A brand-new directory triggers the *"do you trust this folder"* dialog, the
keystrokes land in the modal, and they are lost. The tab looks perfectly healthy; the agent simply
never joins. Proven: identical command, identical directory, the only difference being
`~/.claude.json → projects["<dir>"].hasTrustDialogAccepted: true` — with it, the agent registered.

`hasTrustDialogAccepted` is keyed **per directory**. So a fresh per-round cwd means *a human click
per round*, and a launcher that needs a human click is not a launcher.

**Ruling — one trusted working directory per persona, with a VERIFIED pre-round sweep.** Virgin
context comes from the fresh Claude *session*, not a fresh *cwd*. But §7.2's isolation requirement
is real and survives unchanged: **the persona must never see a prior round's artifacts.** So before
each round the harness must **assert the directory contains only that round's `BRIEF.md`** — no
`JOURNAL.md`, `FEEDBACK.md`, `RESULT.md`, or stray files — and **fail loudly** if not. Collect pulls
artifacts out to `rounds/<n>/` on the mini first. The property is "no prior-round leakage", not the
directory name.

**Explicitly rejected:** pre-seeding `hasTrustDialogAccepted` into the operator's live
`~/.claude.json` (which holds ~64 project entries). Writing trust flags into a human's real editor
config to satisfy a test rig is a side effect the harness has no business taking, and it silently
pre-trusts directories on their machine. Not worth the on-disk file isolation it would buy.

**2. A spawn's exit 0 is not proof the agent joined.** Trust was one way to lose the prompt race; a
slow cold start is another, and the failure is **silent** — the tab looks fine. This is §7.10's
principle again: if the scripts did not observe it, the harness does not assert it.

**Required:** after spawning a round persona, **poll `swarm members` until it appears**, with a
timeout; on timeout **re-send `/join-swarm`** (idempotent); after a bounded number of attempts,
**fail the round setup loudly** rather than proceeding. Never treat spawn's exit code as
registration. Record join latency in `metrics.json` so degradation is visible instead of becoming
an occasional mystery round.

**3. The idempotence short-circuit — exit 0 lying in its third costume (2026-07-25).** Both
launchers opened with "if an agent by this name is already present, we're done, exit 0." That is
the same lie as #2 wearing a helpful face: it reports success while skipping the virgin-context
spawn probe, the distinct-cmux-surface assertion, and the `carryover=false` flip. The round then
runs to completion and `REPORT.md` prints `Carryover: true` — which under §7.4/§7.7 forbids every
discovery-UX claim the round exists to produce. A green launch that has quietly converted the
round into an expensive no-op.

The path is a re-run, not a first run: `reset-round.sh`'s `swarm create` is *create-or-update* and
does not clear agents, and its only cleanliness assertion was the **message** count — so a persona
that joined during an aborted attempt survives the reset with a chat history of zero and looks
exactly like a fresh round. Worst-case timing, too: it fires on the re-run, when someone is
already debugging something else and is least likely to interrogate a green launch.

**The rule: IDEMPOTENCE MEANS THE EVIDENCE IS RECORDED, NOT THAT A PROCESS WITH THAT NAME
EXISTS.** A skip-if-already-done check must test the *artifact the step was supposed to produce*
(`human2_spawn_probe == passed-distinct-cmux-surface` and `fresh_human2_name` matching this
round; `human1_joined_at` and its latency fields populated), never the mere presence of something
named like the result. Reset asserts **zero agents** as well as zero messages, because a surviving
agent with no chat is precisely the hole.

Generalised, this is §7.10's principle pointed at the harness instead of the personas: *if the
scripts did not observe it, the harness does not assert it* — and "an agent with the right name is
running" is not an observation of the thing we needed to observe.

### 7.10 Metrics are authoritative over persona self-report

An LLM will not respect wall-clock. It can spam commands and declare "ten minutes of trying" in
thirty seconds, which silently converts gold solo-discovery data into partner-rescued data.

**Rule: every time-based condition is judged from collected timestamps, never from a persona's
claim.** A step counts as partner-rescued only if `now - time_to_first_coswarm >= 10m`. The brief
may still *say* ten minutes — the persona should behave that way — but the metric decides what
the report claims. The same principle covers give-up, task completion, and link handling: if the
scripts did not observe it, the report does not assert it.

Transcript redaction is likewise the **scripts'** job (§4.1), never a persona discipline. The
chat must carry the capability once; the artifact must not.
