# Deferred: many recipients on ONE signal

Status: **DEFERRED on 2026-09-03** by the operator ("do A now and note B for later").
Option A — browser-side fan-out — shipped instead. This file is the note for B.

## What shipped instead (A)

The composer accepts several agents in the TO row and posts **one signal per agent**.
`site/src/components/app/LiveDashboard.astro`: `composerExtraAgents`, `composerRecipients()`,
and the loop in the composer submit handler. Cap: `COMPOSER_MAX_RECIPIENTS = 8`.

What A gives: each agent gets its own wake and its own delivery receipt, with no server,
database, or edge change.

What A does NOT give: one thread. Two agents means two rows in the feed and two separate
reply threads. A reply from one is not beside the other.

## What B would be

One signal row carrying a LIST of recipients.

The constraint that makes this a protocol change, not a UI change: a signal today carries
`to_user_id` **or** `to_agent_principal_id`, each nullable, mutually exclusive — see
`src/cloud/command-client.ts` (`PostSignalCommand`) and the `post_signal` validation in
`supabase/functions/command/index.ts`. There is no list anywhere on the wire.

Surfaces B has to change together:

- `src/protocol/` — the command and the event gain a recipient set; the reducer decides what
  "addressed to me" means when the set has several members.
- A migration — a join table, because a repeated column cannot be indexed for
  "signals addressed to this principal".
- `supabase/functions/command/index.ts` — validation, the 403 path for a recipient that left
  the workspace (today one recipient fails the whole post; with a set, does one bad recipient
  fail all of them?), and the delivery enqueue, which is per agent.
- Delivery receipts — `src/cloud/delivery-receipts.ts` currently keys a directed receipt to one
  `recipientAgentPrincipalId`. A set needs a per-recipient row under one signal.
- `cswarm inbox`, `cswarm reply`, and the CLI's directed-message reader.
- `site/src/components/app/LiveDashboard.astro` — the fan-out loop collapses back to one post.

## Decide B on this question, not on taste

**Does a reply belong to the question or to the pair?** If two agents answer one question and
both answers must sit under it, B is right. If each answer is really its own conversation,
A is already the correct shape and B only adds a join table.

Revisit when the split threads are measured as a problem in real use — not before.

## Gate

B changes the authority core, so it needs a migration, an edge deploy, and both D-036 arms.
A needed neither.
