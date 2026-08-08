# Positioning: cross-user and provider-agnostic

**Operator decision, 2026-08-07.** Triggered by Anthropic shipping native inter-agent messaging
in Claude Code v2.1.224.

> "cross user and provider agnostic i think is a good place to sit"

## What changed outside this repo

Claude Code now has [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging):
`ListAgents` + `SendMessage`, on by default at v2.1.224+ on macOS/Linux, with no install and no
account beyond Claude Code itself. Verified wording, because the limits are what matter to us:

| | Claude Code | quote |
|---|---|---|
| same machine | full duplex | *"Over a per-session socket, never through Anthropic servers"* |
| other machine | **replies only** | *"Across machines, Claude can only reply. It can't start the exchange."* |
| offline recipient | **not addressable** | *"A session appears only when it binds an inbox socket."* |
| second human | **not possible** | socket is *"restricted to your operating-system user"*; remote hop is *"your sessions"* |
| other vendors | no | only Claude Code binds an inbox socket |

It also wakes an idle session — *"When the receiving session is idle, Claude Code starts a new
turn with the message"* — which is the capability we spent 2026-08-06 measuring.

## What this costs us, stated plainly

`docs/evidence/2026-08-06-agent-wake-round-trip.md` contains three runs. **Run 1 — claude↔claude,
same user, same machine, listener resident — is now free, built in, and requires none of our
onboarding.** That run was our cheapest demo and our single-player on-ramp. It is gone as a
differentiator.

Runs 2 and 3 are not: a **codex** recipient (no non-Claude CLI binds an inbox socket) and a
**cold** recipient (the ask persisted server-side and woke the agent on startup — excluded by
*"A session appears only when it binds an inbox socket"*).

So: one third of what we proved is now someone else's free tier. The other two thirds are what
their design refuses.

## The decision

**CommonSwarm sits on cross-user and provider-agnostic.** Everything else is substrate.

Three of Anthropic's limits follow from their transport rather than their roadmap, and those are
the ones worth building on:

1. **A second human is impossible by construction.** The socket is scoped to one OS user; the
   remote hop is scoped to one account. Their trust model *assumes sender and receiver are the
   same person* — *"a message from another session never counts as your consent."* Multi-person
   is a different threat model, not an extension.
2. **An offline recipient has nothing to queue to.** Durable delivery needs a server-side store,
   and their same-machine design is explicitly *"never through Anthropic servers."*
3. **A non-Claude agent cannot participate**, and Anthropic has no reason to become the bus for
   competitor CLIs.

Weaker, treat as revocable: cross-machine *initiation* and offline queueing read like rollout
stages, not principles. The server hop already exists. **Do not build a moat on either.**

## The obligation this creates, and it is not optional

**The cross-user round trip has never been measured.** It is in that same evidence file's "Not
established" list: *"Multi-machine or multi-user. This was same-user, same-machine, as
specified."*

We are now positioning on the one thing we have asserted and not tested. That is the failure
mode this repo has caught four times in two days. **Measure it before a word of public copy
changes**, using the rig that already exists: Wren is identity B on a second machine
(`toms-m1-max-mbp`). The test doubles as the first real exercise of the invite path, which is
§6 item 3 — the only OPEN launch-bar item.

## What follows

**Do:**
- Measure cross-user + cross-machine + wake. Nothing public changes until it passes.
- Keep codex working. It is the proof that this is not a Claude accessory.
- Spike the Claude Code inbox socket as a **delivery surface**, not a competitor — see below.

**Stop:**
- Leading with the same-machine wake demo. It stands as engineering evidence and is dead as a
  story; a Claude Code user can reproduce it for free and will notice.
- The opencode diagnosis. Cross-vendor is carried by codex; broadening the matrix before the
  two-human story is measured is effort on the third-ranked differentiator.
- Any same-machine/local-bus optimisation for claude-only fleets. That lane is Anthropic's now,
  at zero price, permanently.

**Say differently:** "across a team" is load-bearing in every sentence. Without it we are
describing their feature. One live instance found: `site/src/components/landing/ConsumerStory.astro:72`
— *"agents coordinate through cswarm"* — which a Claude Code user can now falsify from their own
terminal. This is D-023's lesson: **availability copy asserts external state, and the external
state moved.** Grep every surface.

## Integration, not competition

`CLAUDE_CODE_MESSAGING_SOCKET` is a documented integration surface — the doc says to read that
section *"when you want a script or hook to post into a session"* — and messages posted from
outside are delivered in default prompting-mode sessions. The session registry at
`~/.claude/sessions/<pid>.json` carries `name`, `cwd`, `status`, and **`peerProtocol: 1`**, a
versioned protocol.

So the shape is: **CommonSwarm is the durable cross-user backbone; Claude Code's native inbox is
the last-mile delivery surface for Claude recipients**, with the existing ACP listener path for
codex and anything else. Their launch becomes our rails.

**Measured blocker (2026-08-07):** the feature is not active on this machine. A fresh `claude -p`
session registers no record and binds no socket; all six live sessions are v2.1.222/223, below
the 2.1.224 requirement; none of the four gating env vars is set. Either the feature flag is not
enabled for this account, or the cmux shim in `PATH` re-execs an older binary. **The wire format
is undocumented** and cannot be probed until a session actually binds a socket.

Build on it only as an explicitly versioned bridge that **detects `peerProtocol` rather than
assuming it**, and says out loud that it is a bridge until first-party support arrives.

## Not established

- Cross-user or cross-machine round trip on CommonSwarm — architecture plus a measured cloud
  hop, not a measured cross-user run.
- Whether posting to `CLAUDE_CODE_MESSAGING_SOCKET` from a non-child process works as the doc
  implies. The contract is read; no send has been tested; the wire format is not in any doc.
- Whether Anthropic's reply-only and no-offline-queue limits are stages or principles.
- **Whether any two-human team wants cross-user agent messaging enough to pay.** Nothing here
  establishes demand; the docs cannot answer it and our own dogfood has not.
