# Review brief — lane/composer-to-field at d96de1d

Repo: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-composer-to-field (a git worktree of CommonSwarm). Read the files there directly; the diff is at
/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-composer-to-field/arms-d96de1d/DIFF.patch.

**Quote back the first `diff --git` line of DIFF.patch before any finding.** A review that
does not quote it did not read the diff.

End your reply with a single line: `VERDICT: PASS` or `VERDICT: FAIL`. Give reasoning.
An empty PASS is not a review.

## What this lane claims

The composer's To: field is the address: one message carries one recipient set, shown as chips
and posted as the wire's `to` list. FOUR previous review rounds on this branch (cbf0313,
1d786fa, 39c32f0, d567a69) each found the SAME class, and each point fix created the next
instance. The class both arms named:

> the To: set and the record of which tags produced it are state that must follow the body, and
> they were kept in step BY HAND across separate handlers — a draft restore, a workspace switch,
> a roster paint, a chip edit, a send.

This SHA is the fix both arms asked for, not a fifth point fix:

1. `deriveComposerAddress` (site/src/lib/composer-address.ts) is ONE derived pass. Given the
   body's tags, the roster, the stored draft and the last-sent set it yields the pair, and it
   COMMITS ALL OF IT OR NONE OF IT. It holds while the roster is unknown and while a send is in
   flight.
2. `syncComposerAddress` (site/src/components/app/LiveDashboard.astro) is its only wrapper.
   Every handler calls it and assigns nothing itself, and the same call writes the stored pair.
   The ONLY write of the pair outside it is `resetComposer`, which claims to be a teardown
   rather than a derivation.
3. `renderComposerTo` draws and decides nothing; pruning left it.
4. The five items round four left open are claimed closed, plus a sixth the author found while
   tracing this diff. They are listed in docs/evidence/2026-09-05-composer-to/README.md with
   the controls that drive each.
5. supabase/functions/_shared/channels.ts had a comment saying the composer posts one directed
   signal per tag and has not moved to `to` yet. It is corrected, with the retired wording
   preserved. No behaviour changed in that file.

The invariant to attack: **the To: set a reader sees is the set that goes on the wire, and an
EMPTY set is only ever a broadcast the reader chose on this screen, never the residue of a
transition.** The sixth item is that invariant in its other direction: a set that ARRIVAL
pruned was being written down as though the reader had chosen it, which made the prune
permanent. `composerAddressIsChosen` is the fix.

## Round six found three things. All are addressed here; attack the fixes.

- **Both arms, independently:** a message that LANDED after the reader switched workspace left
  its body in the old workspace's draft, so returning restored the sent text with a null intent
  and sending again minted a second command id. **The cause was one level under both rounds:**
  the send captured its workspace, version, recipients, body and command id, then addressed its
  STORAGE through `activeWorkspaceId` read at write time, so every storage call sat behind a
  guard that is right for the screen and wrong for the send's own bookkeeping.
  `composerDraftKey` and `composerToStorageKey` now take the workspace as an argument, the
  submit captures `sendDraftKey` / `sendToKey` beside `workspaceId`, and the landed path does
  its remember and clear BEFORE that guard.
- **Grok:** the claim that `clearComposerDraft` being ungated was enough was false, and the
  source control defending it was green against the false half. Both are replaced.
- **Grok:** `persistComposerDraft()` in the catch was dead (the send flag is still up), and a
  test matched that dead line. The call is gone; the settle in `finally` writes the restored
  body and the test says so.
- **Ruling kept, reason corrected:** a draft WITH a body keeps its own To: set, so a member who
  leaves and rejoins mid-draft stays out. Gemini was right that neither the silent prune nor the
  exclusion is a choice; the tiebreak is which mistake is worse. Adding a recipient to a message
  already being written cannot be taken back once sent; leaving them out is visible on the row
  and one click from fixed. Attack that tiebreak if you think it is wrong.

**This lane has now had six review rounds and every one found the same family.** Say plainly
whether this SHA closes it or whether the family is still open, and if it is still open, name
the ONE cause rather than another instance.

## Checks to attack

Try to REFUTE each. Name the file and line for anything you find.

1. **A SEVENTH INSTANCE OF THE SAME CLASS.** Enumerate every read and write of `composerTo`,
   `composerToApplied`, `composerToLive`, `composerToPruned`, `composerToNotice` and the two
   storage keys, and every place the composer body is replaced without the reader typing. Is
   there any path where the pair and the body can still separate, or where what is on screen is
   residue rather than a choice? Consider: boot, a workspace switch (real and sample), a
   reload, a roster refresh mid-draft, a member who leaves and returns, a send that succeeds, a
   send that fails, a send whose workspace changes under it, sign-out, and the retry. If you
   find one, say whether it is the same class and whether a point fix would close the family.
   Judge `resetComposer`'s claim to be a teardown rather than a derivation.
2. **THE FREEZE.** The pass returns uncommitted while `input.sending`, and the submit's
   `finally` calls it once the flag is down. Can a reader see a set that is not the set the
   post carried, or the reverse? The applied record is no longer cleared by hand in the success
   block, so the settle has to answer for BOTH outcomes: an emptied body on success, and a
   restored body on failure where a stale record would re-address a chip the reader removed.
3. **THE EMPTY SET, AND THE CHOSEN SET.** `null` means "no set was recorded"; `[]` means "the
   reader emptied it". Trace every producer and consumer — `persistComposerDraft`,
   `readComposerDraft`, `rememberComposerTo`, `readRememberedComposerTo`,
   `composerAddressIsChosen`, the pass's `recorded` branch, and `composerToLive`. Is there a
   transition where an empty set on screen is residue? Is `composerAddressIsChosen` right about
   every shape of edit, including a promotion, and about every shape of non-edit?
4. **THE CAP.** A refused name is no longer written into `applied`, and the notice is derived
   from `refused` on every pass. Does the notice repeat, flicker, or vanish while the refusal
   still stands? Can a refused name be added twice? Does anything still make a refusal
   permanent?
5. **THE STORED DRAFT'S NEW REACH.** `persistComposerDraft` keeps a draft for a chosen address
   with an empty body, `resetComposer` flushes before it empties the box, and
   `clearComposerDraft` is called three times. Can that write the wrong workspace's key, leave
   a draft nothing clears, or resurrect a sent message?
6. **THE CONTROLS.** docs/evidence/2026-09-05-composer-to/mutate.mjs reports 46 mutations and 0
   problems in mutation-table.txt. For each NEW entry, does the `expected` string name the
   assertion the mutation is about, or merely one that happens to fail first? Are any two
   entries redundant, so that one masks the other? The README's "What is NOT established" names
   claims that are uncontrolled or entangled — is that list complete?
7. **THE SAMPLE WORKSPACE.** /app gained a second sample workspace and the sample switch was
   rewritten to take the same steps a real `openWorkspace` does. Does it? Compare
   `openSampleWorkspace` with `openWorkspace` and `resetComposer`. If the sample switch does
   NOT reach the same code path, the new browser controls do not measure what they claim, which
   is the "a negative result must reach the path it claims to test" failure.
8. **GENERATED VERSUS TYPED, AND RETIRED CLAIMS.** Every user-facing sentence about the cap, the
   wake position, the refusal and the prune must be built from the constant the code enforces.
   Check `composerAddressNotice`, `composerToFullNotice`, `composerPrunedNotice`,
   `composerPromoteLabel` and `composerDeliveryNote`. Separately: does any comment, doc or
   test still assert something this SHA made false? Name it with its file and line.
