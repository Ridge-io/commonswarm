# Review brief — lane/composer-to-field, SHA 1d786fa (CommonSwarm)

You are an independent review arm. Read the diff at the absolute path you were given and
attack it. Do not be agreeable. Attempted refutations of the lane's claims are the product.

Repo root (read any file there for context):
/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-composer-to-field

Before your findings, QUOTE BACK the first `diff --git` line of the patch verbatim.

## What the lane claims

1. The composer has a persistent "To:" row on one footer line. Its chips are the ONLY thing
   the send reads, so nothing is delivered to somebody the reader cannot see.
2. An `@name` typed mid-sentence ADDS that person or agent to the To: set (ruling D2). It
   never opens a DM and never replaces the set. Removing a chip holds while the tag stays.
3. The set defaults to the recipients of the reader's last SENT message, per workspace, and
   is pruned against the live roster; a prune is reported rather than silent.
4. The message is ONE signal carrying the wire's `to` list (cap 8), replacing one signal per
   @tag. Both scalar recipient fields travel `null`: the command edge refuses a body that
   sets `to` and a scalar together, and writes recipient 0 into the scalar column itself.
5. Only recipient 0 is woken, and only when it is an agent. `swarm.enqueue_signal_delivery`
   (supabase/migrations/20260731000001_signal_deliveries.sql) fires on
   `to_agent_principal_id IS NOT NULL AND kind IN ('ask','note')`. The To: row states that
   bound and never claims the whole set is notified. Choosing a chip puts it first.
6. Broadcast is shown as a named chip and a sentence, never as an empty row.
7. Every number and sentence in the row is generated from the server's own constants
   (`SIGNAL_RECIPIENT_MAX`, `supabase/functions/_shared/channels.ts`), not typed beside them.
8. Nothing a tag names is dropped in silence: over the To: cap, over the parser's ceiling,
   ambiguous, or removed by the roster.

## Checks to attack (numbered; answer each)

1. **Hidden recipient.** Find any path where the posted body addresses somebody the To: row
   does not show, or the row shows somebody the send does not address. Consider the debounced
   tag pass, a workspace switch, a roster change mid-draft, a retry after failure, sample
   mode, the localStorage restore, and `restoreComposerDraft`.
2. **The wire body.** Read `browserSignalCommand` in site/src/lib/commonswarm.ts against
   `postSignalFieldProblem`, `signalRecipientListProblem` and `chatSignalKeys` in
   supabase/functions/_shared/channels.ts, and against tests/p1-server/chat-signals.test.ts.
   Would the served edge accept every body this client can build? Name any it would refuse,
   and any an OLDER deployed edge would refuse.
3. **The wake claim.** Is the To: row's sentence true for BOTH the hosted workspace and the
   optional local listener, for every set the cap allows? Find a set where the copy and
   `swarm.enqueue_signal_delivery` disagree. Check the `kind` the client sends.
4. **The mention merge.** `mergeMentionRecipients` in site/src/lib/composer-address.ts and
   `applyComposerMentions` in LiveDashboard.astro. Find a sequence of typing, removing,
   sending and retyping where a recipient is silently added, silently cannot be added back,
   or where a notice repeats on every keystroke.
5. **The one-signal rewrite.** The old submit posted N signals with a partial-send failure
   model. Read the new success and catch paths. Find a case that double-posts, loses a posted
   row, leaves a ghost pending row, relights Retry after the post landed, or clears the draft
   when it should not.
6. **Generated versus typed.** Find any user-visible sentence or number about the cap, the
   recipient kinds, or the wake position that is typed rather than built from the enforcing
   constant. Include tests and comments.
7. **Retired claims.** The old wording ("the address is the message", "one signal per tag",
   "no TO row", "the bar is 80px at rest", "Sent to N of M") is spread across source, tests
   and docs. Name any surface still asserting a retired claim as current, and any place a
   retirement was recorded wrongly.
8. **State that must follow the body.** ROUND ONE of this review FAILED on exactly this
   shape and the fixes are in the diff: `composerToApplied` is now cleared on the success
   path rather than before the post; the remembered set is restored before the draft and the
   draft's tags join it afterwards; a chip's promote label is built from `notifiedRecipient`
   rather than typed. Attack those three fixes first: are they complete, and does the fix
   itself create a new instance? Then look for a further one. Earlier instances, also fixed:
   chips pruned against a roster that had not loaded; a send that emptied the box without
   emptying `composerToApplied`; the parser's `overflow` never read; a prune with no notice.
   They are the same shape. Find a FIFTH instance of it, or say plainly that you looked and
   found none.
9. **The controls.** Round one found several mutation expectations matching a TEST TITLE,
   which every failure of that file prints, so the harness could not tell a wrong reason from
   the named one; and the two-line height ceiling had no reverted control. Both were changed.
   Read the harness again and say whether any expectation still cannot discriminate. Read docs/evidence/2026-09-05-composer-to/mutate.mjs,
   mutation-table.txt, README.md, and composer-to-field.observer.test.ts. Does any assertion
   pass for a reason other than the one it names? Do the source-reading claims state their
   bounds honestly? Are the renegotiated height budgets in composer-polish.observer.test.ts
   still able to fail?

End your reply with exactly one line:

VERDICT: PASS

or

VERDICT: FAIL

A verdict without reasoning, or without the quote-back, does not count as a review.
