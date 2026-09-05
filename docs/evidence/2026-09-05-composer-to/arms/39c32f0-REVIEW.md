# Review brief — lane/composer-to-field, SHA 39c32f0 (CommonSwarm), round three

You are an independent review arm. Read the diff at the absolute path you were given and
attack it. Do not be agreeable. Attempted refutations of the lane's claims are the product.

Repo root (read any file there for context):
/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-composer-to-field

Two earlier rounds FAILED this lane and their transcripts are in
docs/evidence/2026-09-05-composer-to/arms/ — DELIBERATELY EXCLUDED from the patch. Read them
if you want, but findings you take from them are theirs, not yours: say which are which.

Before your findings, QUOTE BACK the first `diff --git` line of the patch verbatim.

## What the lane claims

1. The composer has a persistent "To:" row on one footer line. Its chips are the ONLY thing
   the send reads, so nothing is delivered to somebody the reader cannot see.
2. An `@name` typed mid-sentence ADDS to the set (ruling D2). It never opens a DM and never
   replaces the set. Removing a chip holds while the tag stays, across a reload as well.
3. The set defaults to the recipients of the last SENT message, per workspace. A draft carries
   the set it was being written to, together with the record of which of its tags produced it.
4. The message is ONE signal carrying the wire's `to` list (cap 8). Both scalar recipient
   fields travel `null`: the edge refuses `to` plus a scalar and writes recipient 0 itself.
5. Only recipient 0 is woken, and only when it is an agent
   (`swarm.enqueue_signal_delivery`). The row and every chip's own control state that bound.
6. Broadcast is shown as a named chip and a sentence, never as an empty row.
7. Every number and sentence about the cap, the kinds and the wake position is generated from
   the server's constants, not typed beside them.
8. Nothing a tag names is dropped in silence: over the To: cap, over the parser's ceiling,
   ambiguous, or removed by the roster.
9. **A render never moves the address.** The tag pass runs only where the reader acted: a
   keystroke, a mention pick, a draft restore, and the flush the submit does.

## Checks to attack (numbered; answer each)

1. **Hidden recipient.** Any path where the posted body addresses somebody the To: row does
   not show, or the row shows somebody the send does not address. Consider the debounced pass,
   a workspace switch, a roster change mid-draft, a retry after failure, sample mode, the
   localStorage restore, `restoreComposerDraft`, and a send in flight.
2. **The wire body.** `browserSignalCommand` in site/src/lib/commonswarm.ts against
   `postSignalFieldProblem`, `signalRecipientListProblem` and `chatSignalKeys` in
   supabase/functions/_shared/channels.ts, and tests/p1-server/chat-signals.test.ts. Name any
   body this client can build that the served edge would refuse.
3. **The wake claim.** True for BOTH the hosted workspace and the local listener, for every
   set the cap allows? Check the `kind` the client sends and every chip's own label.
4. **The mention merge.** `mergeMentionRecipients` and `applyComposerMentions`. Find a
   sequence of typing, removing, sending, failing, reloading and switching workspace where a
   recipient is silently added, silently cannot be added back, or a notice repeats.
5. **The one-signal rewrite.** Find a case that double-posts, loses a posted row, leaves a
   ghost pending row, relights Retry after the post landed, or clears the draft when it
   should not. Say plainly whether the case is NEW in this diff or byte-identical to main.
6. **Generated versus typed.** Any user-visible sentence or number about the cap, the kinds
   or the wake position that is typed rather than built from the enforcing constant.
7. **Retired claims.** Any surface still asserting a retired claim as current, and any place
   a retirement is recorded wrongly.
8. **THE CLASS.** Two rounds found the same shape: state that must follow the body, and did
   not. Round three's answer is a CAUSE fix, not another instance: the tag pass is no longer
   reachable from a render, and the draft carries the set and the applied record together.
   Attack that answer. Is the cause correctly identified? Is the call-site count a real gate
   or a fragile one? Does the fix create a new instance? Then look for another.
9. **The controls.** docs/evidence/2026-09-05-composer-to/mutate.mjs, mutation-table.txt,
   README.md, composer-to-field.observer.test.ts, composer-address.test.mjs. Does any
   assertion pass for a reason other than the one it names? Can any mutation expectation fail
   to discriminate? Do the source-reading claims state their bounds honestly?

End your reply with exactly one line:

VERDICT: PASS

or

VERDICT: FAIL

A verdict without reasoning, or without the quote-back, does not count as a review.
