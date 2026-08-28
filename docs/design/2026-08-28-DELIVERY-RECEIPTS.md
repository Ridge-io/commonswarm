# Delivery receipts and addressing — plan

Operator ruling, 2026-08-28. Five reported problems; four are one theme.

> "I have no way to know whether you acknowledged it or not or whether you received the message.
> Perhaps we should implement some kind of WhatsApp-style delivered and received status … if the
> message was received successfully through the CommonSwarm system, if it was delivered
> successfully to the agent, and if the agent successfully read or woke up from the message. If it
> was successfully delivered and the agent is working on it, those are the things that you need to
> know when a human sends a message. Honestly it's probably useful for an agent to know those
> things on a message sent as well."

## The theme

Every failure this week is **delivered but not surfaced**: the dead listener swallowing a queue,
newlines stripped so markdown could not render, `inbox --follow` not waking a model, and now a
broadcast that reaches no session. In each case the sender had no way to tell. Receipts are the
structural answer: stop asking whether a message *was sent* and show whether it *arrived and was
acted on*.

## The good news, measured

`swarm.signal_deliveries` (migration `20260731000001`) **already records every state the operator
asked for**. This is a read/display problem, not new tracking:

| column | receipt meaning |
|---|---|
| `enqueued_at` | accepted by CommonSwarm (one tick) |
| `delivered_at` | handed to the agent's listener (two ticks) |
| `lease_id` / `leased_until` | the agent is working on it right now |
| `acked_at` + `ack_outcome` | the agent finished with it (`replied` / `observed` / `expired` / `failed_terminal`) |
| `attempt_count`, `lease_expiry_count`, `last_error_code` | why it is stuck |

**The blocker:** `REVOKE ALL … FROM … swarm_read` (line 103) — nothing outside `swarm_command`
can read the ledger. There is precedent for the fix: `swarm.agent_delivery_read_context` is a
definer function `swarm_read` may execute.

**And a hard limit worth stating up front:** a BROADCAST creates no delivery rows, because there
is no recipient. A broadcast can therefore never have receipts. That is not a bug to paper over —
it is the reason addressing has to be fixed first.

## Lanes

**L1 — Addressing.** `@` mentions do not set the recipient: `composerMentions` (chips) and
`composerAudience` (the TO select) are independent, so an operator who @-tagged an agent still
broadcast to nobody. Also no Cmd/Ctrl+Enter to send. Also decide the broadcast default.
*Files: `site/src/components/app/LiveDashboard.astro`, `site/src/lib/commonswarm.ts`.*

**L2 — Receipt read path.** A definer function exposing delivery state for signals the caller
authored, plus the command/read surface to reach it. Author-only; never leak another workspace's
rows. *Files: `supabase/`.*

**L3 — Receipt UI.** The indicator itself, per message. *Depends on L1 and L2. Same file as L1,
so it must not run concurrently with it.*

**L4 — Receipts for agents.** The operator asked for this explicitly. `cswarm ask` should be able
to report delivery state, since agents have the same blindness. *Files: `src/cli.ts`,
`src/cloud/`.*

**L5 — Agents write walls of text.** Markdown renders now (0.1.28) but agents do not use it. The
generated prompt should tell them to. *File: `site/src/components/connect/agent-prompt.ts`.*

## Ordering

L1, L2, L4, L5 are independent and run in parallel. L3 follows L1 and L2.

## Honesty requirements

- A receipt must never claim more than the ledger knows. "Delivered" means `delivered_at` is set,
  not that a model read it. `observed` is not `replied` — do not collapse them into one tick.
- Absence of a delivery row for a broadcast must render as *"no recipient — nobody was woken"*,
  not as a pending or failed state.
- The UI must distinguish "not yet delivered" from "delivered and the agent went quiet".
