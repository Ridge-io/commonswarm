# Review brief — CommonSwarm lane `lane/chat-recipients`, SHA 327c6ad

You are an independent review arm. Read `DIFF.patch` in this directory, and read
the repository at
`/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-chat-recipients`
(the working tree is exactly this SHA; do not modify anything).

**Before any finding, quote back the first `diff --git` line of `DIFF.patch`
verbatim.** A review without that line is not counted.

End your output with a single last line, exactly `VERDICT: PASS` or
`VERDICT: FAIL`. Give reasoning for every check. An empty PASS is not a review.

## What the lane claims

1. **Two owed refusal-order fixes.** `declare_agent_model` / `set_agent_model`
   split the key check from the type check, so `{model: 123}` is told the model
   rule instead of the field list. `chatSignalShapeProblem` answers
   `broadcast_to_channel: true` with no `thread_root_id` before it answers a bad
   channel slug. No accept/refuse boundary moves; only which sentence a caller
   sees first.
2. **Multi-recipient signals (migration `20260905000010`).** A signal can address
   up to `SIGNAL_RECIPIENT_MAX = 8` people and agents.
   `swarm.signal_recipients` holds the ordered set. `signals_one_recipient` is
   NOT relaxed and the scalar `to_user_id` / `to_agent_principal_id` keep the
   FIRST recipient, so an installed reader is incomplete but never wrong. The
   read view gains a `recipients` column and a new visibility disjunct; the agent
   read path gains the matching arm. Delivery fans out one row per agent
   recipient with `ON CONFLICT DO NOTHING`. `post_signal` gains optional `to`.
3. **`oldest_pending_at` on the claim response**, so a listener can report queue
   age. Three wire states: a string, `null` (nothing pending), absent (not
   reported).

## Round 6. What changed since the fifth pair of arms

Round 5 was FAIL / FAIL, on PROSE only. No runtime behaviour has changed since
round 3. Five rounds have now each found one more wrong summary of the same
rule, so this round replaced the summaries with one repeated string and a gate.

- The wake rule is one clause, repeated verbatim on three surfaces: *"wakes the
  recipient at position 0, and only when that recipient is an agent taking
  `ask` or `note`"*. `tests/chat-channel-constants.test.ts` fails if a surface
  drops it, or if a retired wording appears with no retirement marker in the
  400 characters before it. It flattens line wrapping first.
- The reply paragraph in the build plan now states what `signalNamesRecipient`
  admits PER CALLER, because the human and agent read paths are different cuts
  (Gemini's round-5 finding).

**Your job this round.** Two things, in order.

1. **Try to write a true sentence about who is woken that the new gate would
   let through and that a reader would take the wrong way.** If you can, the
   gate is the wrong shape and say so.
2. **Read the wake clause itself against `enqueue_signal_delivery()`
   (`20260731000001_signal_deliveries.sql:126-137`) word by word.** Is it
   exactly true? Is there a case it still gets wrong -- an expired signal, a
   revoked agent, an agent that is also the author, a signal whose position 0
   agent is later revoked, a kind outside ask/note?

Then run the numbered checks below as usual. If checks 1 to 7 hold and check 8
finds only wording you would phrase differently rather than a false statement,
say PASS.

## Checks to attack, in this order. Try to REFUTE each.

1. **Old clients.** Find any body an installed cswarm 0.1.54 or the shipped
   browser sends that this diff makes fail. `exactKeys` in
   `supabase/functions/command/index.ts` is the known trap: `modernKeys` is an
   all-or-nothing pair every installed writer sends, and agent READ bodies always
   send `in_reply_to`. Did `to` reach `exactKeys` anywhere but through its own
   `Object.hasOwn` group?
2. **The view recreation.** `20260905000010` splices the live `pg_get_viewdef`
   body in two steps and WIDENS the predicate. Can the splice produce a body that
   drops or corrupts a clause the live view carries? Consider: a subquery with
   its own WHERE (the attachments aggregate already has one); a hotfix clause a
   later migration adds; the `@@SWARM_SPLIT@@` / `@@SWARM_WHERE@@` markers
   appearing in real SQL; the assertion helper's markers being satisfied
   vacuously. Does the new disjunct admit a row to anyone who is NOT a recipient
   and NOT already admitted by the old predicate? The new disjunct is ORed at the
   TOP level — check its own `is_member` gate carefully.
3. **The first-recipient guarantee.** Is there ANY path where a signal row's
   scalar recipient disagrees with `swarm.signal_recipients` position 0, or where
   recipient rows exist and the scalar columns are NULL? Check the deferred
   constraint trigger, `resolveSignalWriteTarget`, and `postSignal`. What happens
   on `in_reply_to` re-addressing? On a thread reply? On `working-on`?
4. **The two enforcement points.** The view's WHERE and the SQL arm in
   `supabase/functions/read/index.ts` must agree. Can an agent read a signal it is
   not addressed on? Can an agent that IS the second recipient fail to read one?
   Does the `inbox: true` filter agree with the unfiltered one? Note the read arm
   tests the view's DERIVED `recipients` column with jsonb containment — is that
   test exact, or can it match a recipient it should not (kind confusion, uuid
   case, a user id equal to an agent principal id)?
5. **Delivery fan-out.** One row per agent recipient, and the first recipient not
   woken twice. Read `swarm.enqueue_signal_recipient_delivery()` against
   `swarm.enqueue_signal_delivery()` in `20260731000001_signal_deliveries.sql`.
   Does `ON CONFLICT DO NOTHING` actually de-duplicate on that table's key? Is
   the kind gate the same? Can a `working-on` or an expired signal enqueue?
6. **The cap.** Two enforcement points, one number. Can a caller store 9
   recipients? Can the edge accept a list the database refuses, or the reverse?
   Is every user-facing sentence that lists or bounds GENERATED from the constant
   the enforcement reads, or is any of it typed? Check the migration comments,
   the refusal sentences, the test messages.
7. **`oldest_pending_at`.** Is the reported time from the SAME set as
   `pending_delivery_count`, in the same statement? Can absent and null be
   confused anywhere — in `parseClaimLedger`, in the three response sites, on a
   replay? Does adding a capability marker break any installed client?
8. **Claims in prose.** The commit messages, `docs/design/2026-09-05-chat-build-plan.md`
   and the corrections in `docs/design/2026-09-04-chat-platform-reconciled.md` and
   `docs/evidence/2026-09-05-listener-head-of-line/DESIGN-BOUNDS.md` make factual
   claims. Check each against the code. In particular: "a one-entry `to` produces
   the same stored signal row, the same delivery ledger and the same rendered set
   as the scalar shape" — is that true, and does anything differ that the lane
   does not name?
9. **The tests.** Do any of them pass for a reason other than the one they state?
   Name any that would stay green if the behaviour it guards were removed. The
   sweeps that read source text with `includes()` are the likeliest weak spot —
   one of them already had to be fixed for matching a substring.

## House rules the lane must obey

- **D-053:** never branch on `error.message`.
- **Generated, not typed:** any user-facing string that lists or bounds must come
  from the constant the enforcement reads.
- **A negative result must reach the path it claims to test.**
- Refusal order: the rule that makes a request impossible outranks a rule that is
  merely also broken; shape before meaning.
- No em-dashes in user-facing text.
