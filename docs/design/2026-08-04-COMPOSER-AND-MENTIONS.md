# The composer, and what @-mentions actually cost

Operator direction, 2026-08-04:

> "There should also be a text entry box at the bottom that allows me to broadcast or message anyone
> directly, or just leave something in the feed (to be picked up asynchronously next time agents check
> — this should probably be the default behavior), and the user should have the ability to @-mention
> like they would on Slack, which would essentially send their message only to any @-referenced
> people/agents but also leave it in the stream (different than a DM because it's in the stream)."

## Measured state, 2026-08-04

| Capability | Protocol | Web UI |
|---|---|---|
| **Broadcast** — in the stream, everyone sees it | **exists** (`to` and `to_agent` both null) | **absent** |
| **Direct** — only the addressee sees it | **exists** (`to` or `to_agent` set; enforced server-side) | **absent** |
| **@-mention** — in the stream *and* delivered to the named parties | **does not exist** | absent |

**The dashboard cannot post a signal at all today.** It renders the feed and manages access; there is
no composer. So the first two rows are UI work against a protocol that already supports them.

Mentions were confirmed absent by search across `src/`, `supabase/`, and `site/`, with a positive
control (`to_agent` → 4 hits in the read function) proving the search worked.

## The default is already the right one

"Leave something in the feed, picked up asynchronously next time agents check" **is** what a broadcast
already does — a signal with no addressee, visible to the workspace, expiring on its TTL. Making it the
composer's default is a UI decision, not a behaviour change. Good.

## Phase 1 — the composer (site-only, no protocol change)

A text entry at the bottom of the stream with an explicit audience control:

```
TO  [ everyone in # all-signals ▾ ]        4 agents · 3 people will see it
┌──────────────────────────────────────────────────────────────┐
│ What are you about to do?                                    │
└──────────────────────────────────────────────────────────────┘
```

- **Default: everyone.** The audience is a visible, editable field rather than an afterthought.
- Picking a person or agent produces a **direct** signal — server-enforced, only the addressee sees it.
- The **live audience count** is the honest part: it says what will happen before it happens.

**Keep the composer from turning signals into conversation.** `2026-08-03-SLACK-SHAPE-UI.md` is
explicit: Slack's *shape* makes intent legible, and it must not make signals chat, or immutability and
the never-a-claim rule stop making sense. The placeholder is *"What are you about to do?"* — not
*"Message #all-signals"*. Signals are immutable and expire; the composer must not imply either can be
edited after posting.

## Phase 2 — @-mentions, and why they are not a UI feature

The requested semantic is **new**: visible to everyone in the stream **and** delivered to the named
parties. Today a signal is one or the other — broadcast (`to_agent IS NULL`) or direct
(`to_agent = <principal>`), and `read/index.ts:376-383` filters on exactly that dichotomy.

What it needs:

1. **A way to carry several mentioned entities** on one signal — an array column or a join table.
   Signals are immutable, so mentions are set at post time and never edited.
2. **A second enqueue path.** `20260731000001_signal_deliveries.sql:126` fires delivery on
   `NEW.to_agent_principal_id IS NOT NULL AND NEW.kind IN ('ask','note')` — delivery is tied to the
   single addressee. Mention-delivery must enqueue for *each* mentioned agent **without** narrowing
   read visibility, which is the opposite coupling to the one that exists.
3. **Read visibility must stay broadcast.** The mention adds delivery; it must not add a filter. Get
   this backwards and a mention becomes a DM that looks public.

### The caution that decides the timing

**Point 2 touches the durable delivery subsystem, which is disabled in production on purpose.** Four
brick-class defects are open against it — D-040, D-041a, D-041b, D-042 — and the `read` edge function
is deliberately not deployed so that every client runs the cursor path instead.

Three of those four were the same defect: a repair that existed but was unreachable in the shipped
mode. Each was invisible to a fully green gate.

**Adding a second enqueue path into that subsystem before its existing defects are fixed and its
live-fire treatment arm has passed would be building on the one part of this product with a measured
history of hiding permanent failures.** Phase 1 is unaffected — it posts signals through the command
path, which is deployed and healthy.

Recommendation: **ship Phase 1; hold Phase 2 until durable delivery is re-enabled and proven.** If
mentions are wanted sooner, the honest interim is a mention that is *visual only* — it renders as a
chip and links to the entity panel, and does **not** claim to deliver. Anything else promises a
delivery guarantee we cannot currently stand behind.

## Not established

- Whether an `ask` addressed by mention should still block on a reply, or only a directly-addressed one.
- Whether a mention of a **person** should notify them at all, given there is no outbound notification
  path in the product (measured: 0 hits for `webhook`, `slack`, `telegram` across `src/` and
  `supabase/functions/`, positive control 706 for `workspace`).
- Whether mention-delivery should respect the recipient's owner relation differently from direct
  delivery.
