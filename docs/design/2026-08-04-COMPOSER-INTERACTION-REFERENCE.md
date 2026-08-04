# Composer and mention interaction — reference captured from Buzz

Operator, 2026-08-04, with six screenshots of the live flow: *"It should generally look about like
this."* This records the mechanics, which a static mockup does not show. Companion to
`2026-08-04-COMPOSER-AND-MENTIONS.md`, which covers what each part costs.

## The flow, step by step

### 1. Typing `@` opens a picker above the composer

A list, keyboard-navigable, with the highlighted row visibly selected. Each row shows an avatar, the
name, and a **subtitle that distinguishes what the thing is**:

```
  Tom                                   ← a person: name only
  Lead      🤖 agent · managed by you
  Builder   🤖 agent · managed by you
  Reviewer  🤖 agent · managed by you
```

The person carries no subtitle; agents carry `agent · managed by <operator>`. **Ownership appears at
the moment of choosing**, not only after posting — the identity rule applied to the picker.

### 2. Selecting inserts an atomic chip, not text

The composer then contains a **chip** followed by free text:

```
┌──────────────────────────────────┐
│ [🤖 Lead] hello                   │
└──────────────────────────────────┘
```

This matters. The mention is a **resolved reference**, not a string that happens to start with `@`. It
cannot be half-deleted into `@Lea`, and it survives into the posted message as the same chip. Our
addressing work already renders resolved targets rather than raw ids; this is the same idea at input
time.

### 3. The posted message keeps the chip

```
Tom  2:28 PM
[🤖 Lead] hello
```

Same treatment in the stream as in the composer, so what you typed is what you see.

### 4. Composer chrome

A single-line-growing input with `@`, attach, emoji, and `Aa` (formatting) on the left, and a circular
send arrow bottom-right. Placeholder is `Message #general`.

**Ours must not say that.** `2026-08-03-SLACK-SHAPE-UI.md`: the placeholder is *"What are you about to
do?"* — Slack's shape without Slack's semantics. Signals are immutable statements of intent, not chat.
Attach and emoji are Buzz features and are **not** in our scope.

### 5. A live agent-activity line at the bottom of the window

Below the composer, a persistent one-liner:

```
🧑 Lead: Mode
🧑 Lead: Ran tool · ls /Users/tom/.buzz/ 2>/dev/null && echo "---AGENTS---" && cat …
```

**This is the strongest idea in the set and it is not in our design doc.** It answers *"is anything
happening right now"* without opening a panel. Truncated with an ellipsis; identity-prefixed.

We have real material for it: the listener runtime emits status and events, and delivery has
claim/lease/ACK phases. **Do not invent it from nothing** — if it cannot be driven by durable state we
already record, leave it out rather than animating a guess.

### 6. Threads open in the right panel

A `Thread` header with a close control, showing the parent message and replies, with its own
`Reply in thread to Tom` composer.

**Layout consequence worth deciding once:** the right panel is a *slot*, and threads and the entity
panel both want it. Whatever we build should treat it as one region with swappable contents, not two
competing panels — decided now, cheaply, rather than after both exist.

**Threads are a protocol question, not a layout one.** Open question 2 in the design doc: replies to an
*immutable* signal need a rule — are they signals themselves, and do they inherit the parent's expiry?
We do have `cswarm reply <signal-id>` and an `in_reply_to` field, so the material exists; the semantics
do not.

### 7. Hover reveals a reaction toolbar

👍 ❤️ 😂 🎉 plus add-reaction, reply, and overflow. Reply counts render inline: `1 reply · last reply
just now`, with participant avatars.

**Reactions are out of scope and should stay out.** A signal is immutable and never a claim; a reaction
is mutable state attached to it, owned by no one, with no expiry. It is the clearest example of Slack's
*shape* dragging in Slack's *semantics*, which the design doc explicitly warns against.

## What this reference changes about the plan

| Element | Status |
|---|---|
| Composer, broadcast default | **Phase 1** — protocol supports it |
| Direct addressing via picker | **Phase 1** — protocol supports it |
| `@` picker with agent/person distinction and operator subtitle | **Phase 1** — data already in `AgentAccessStatus` |
| Mention **chips** in composer and message | **Phase 1**, rendered only |
| Mention **delivery** to the named party | **Blocked** — needs schema plus a second enqueue path into the disabled delivery subsystem |
| Live activity line | **Phase 2**, only if drivable from recorded state |
| Threads | **Blocked on a semantics decision**, not on UI |
| Reactions | **Out of scope** |

The split to hold onto: **a mention can be rendered honestly today; it cannot be delivered honestly
today.** A chip that links to the entity panel promises nothing false. A chip that implies the agent
was notified, when the delivery path it would use is disabled in production with four open
brick-class defects, promises something we cannot currently keep.

## Not established

Whether the picker should offer agents belonging to *other* owners in the same workspace — likely yes,
since directed signals to them are already permitted server-side, but it was not asked and not decided.
Whether a mention of a person means anything at all given the product has no outbound notification
path (measured: zero hits for `webhook`, `slack`, `telegram` across `src/` and `supabase/functions/`).
