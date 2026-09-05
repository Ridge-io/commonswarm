# lane/composer-to-field — what was measured

The composer's address moved from "an @tag in the body, one signal per tag" (2026-09-04) to a
persistent To: row whose chips are the delivery set, posted as ONE signal carrying the wire's
`to` list. Ruling D2: a mention ADDS to the set.

## Files here

| file | what it is |
|---|---|
| `mutate.mjs` | The mutation harness. One entry per thing a test claims to defend; `mutation-table.txt` carries the count, so it is not typed twice. |
| `mutation-table.txt` | Its output: baseline green, then red-for-the-named-assertion and green again for every entry, with the count on its last line. |
| `measure-mobile.mjs` | The phone measurement. Serves `site/dist` in sample mode and reads the layout inside an iframe sized to the phone. |
| `mobile-measurements.json` | Its output, both viewports. |
| `mobile-390x844.png`, `mobile-320x568.png` | Screenshots at those viewports. |
| `arms/` | The two review arms on the final SHA. |

## The numbers

Measured on this build, in `site/dist`, sample mode.

| viewport | composer at rest | To: row at rest | composer with two chips | To: row with two chips |
|---|---|---|---|---|
| 1440x900 (composer-polish) | 104.44px | one line | 124.44px two-line body | — |
| 390x844 | 99.38px | 32.38px | 127.58px | 40.58px |
| 320x568 | 128.81px | 61.81px | 143.77px | 56.77px |

At both phone widths the composer, its send button and the To: row are inside the viewport and
the document does not scroll sideways. At 320px the note wraps under the chips; it is allowed
to wrap because truncating it would hide which recipient is woken, which is the one thing the
row exists to say.

The resting budget in `composer-polish.observer.test.ts` moved from 80px to 108px, and the
two-line ceiling from 120px to 130px. The 80px was bought on 2026-09-04 by deleting a TO
control the operator asked for again on 2026-09-05. The reverted control still fails both
ceilings, at 128.44px / 131.38px and 147.44px / 150.38px.

## The review rounds

| SHA | Grok | Gemini | What it found |
|---|---|---|---|
| `cbf0313` | FAIL | FAIL | applied cleared before the post; draft restored before the remembered set; a chip label promising a person a wake; three control weaknesses |
| `1d786fa` | FAIL | FAIL | the same class twice more: a reload wiped the applied record, and the tag pass ran from a render |
| `39c32f0` | FAIL | PASS | the same class again, created by the previous fix: an empty To: stored as an omitted key |
| `d567a69` | FAIL | FAIL | the same class again: the draft restore commits against an unloaded roster, and chip edits never reach storage |

Four rounds, one family: **the To: set and the record of which tags produced it are state that
must follow the body, and they were kept in step by hand across separate handlers.** Each round
closed a door and the next round found another. The lane stopped at round four rather than
making a fifth point fix.

Both arms named the same fix in their own words. Grok: the two restores have to be one
transaction that does not commit until the roster is known, and every live edit must also
write the stored pair. Gemini: the set and the applied record are derived from the body and the
roster, and they were being synchronised by hand across disconnected handlers instead of being
one derived pass.

## The derived pass, and the five items it closes

`deriveComposerAddress` in `site/src/lib/composer-address.ts` is that pass. Given the body's
tags, the roster, the stored draft and the last-sent set, it yields the To: set and the tag
record, and it COMMITS ALL OF IT OR NONE OF IT. `syncComposerAddress` in `LiveDashboard.astro`
is its one caller-facing wrapper: every handler that can change the address calls it and
assigns nothing itself, and the same call writes the stored pair.

**The invariant it pins.** The To: set a reader sees is the set that goes on the wire, and an
empty set is only ever a broadcast the reader chose on this screen, never the residue of a
transition.

| open item from round four | what closed it | the control that drives it |
|---|---|---|
| 1. a workspace switch loses a draft's address | the pass holds while `rosterKnown` is false, and the body and the address are one transaction behind one restore key | `broadcastSurvivesSwitch`, `chipEditSurvivesSwitch`, `switchedWorkspaceAddress` in the browser; "a pass against an unknown roster commits nothing" in the pure driver |
| 2. a chip edit never reaches storage, and a switch cancels the timer | the pass writes the stored pair on every commit; `resetComposer` FLUSHES before it empties the box; an address the reader CHOSE is a draft on its own | `chipEditSurvivesSwitch`, `emptyBodyEditSurvivesSwitch`, and "a set arrival pruned is not a set the reader chose" in the pure driver |
| 3. a roster prune during an in-flight send | the address is FROZEN for the whole post and settles in the submit's `finally`, which is also what now clears the applied record rather than a hand write in the success block | "nothing moves the address while the message it addresses is on the wire" in the pure driver, plus a source claim that the dashboard feeds `sending` in |
| 4. a tag refused by the cap cannot be re-added | only a name that GOT IN is marked applied; the notice is derived from `refused` on every pass rather than pushed in once | `capRefused` then `capAfterRoom` in the browser; "a tag the cap refused joins the set as soon as the reader makes room" in the pure driver |
| 5. two mutation expectations fail for a reason other than the assertion they name | the notified mark has its own claim (`notifiedMark`), and `secondTag` and `promoted` no longer read it | the two mutations now name `notifiedMark` |

### The sample workspace, and why it grew

Every browser control above needs a transition sample mode could not reach. `/app` now has TWO
sample workspaces:

- **Design studio** — unchanged, and still the first screen a visitor meets.
- **Field lab** — nine agents and two members, so the eight-recipient cap is reachable.

A sample switch used to set the id and repaint. It now takes the same steps a real one does:
`resetComposer` runs while the workspace being left is still current, the roster is cleared,
the screen paints once with nothing known, and the roster arrives on a later task. A switch
that skipped those steps could not measure the thing a switch breaks.

### One more instance of the class, found and closed inside this lane

Storing an address "the reader chose" was first written as "the set on screen differs from the
last-sent set". That said yes to a set nobody had touched: arrival PRUNES the remembered set,
so a workspace that had lost a member produced a difference on its own, and the draft written
for it answered on the next arrival before the remembered set could. A member who left and came
back stayed out of To: for good — an on-screen set that was residue, written down as a choice,
which is the invariant this lane exists to hold, in its other direction.

`composerAddressIsChosen` in the pure module asks the question properly: is this different from
what a FRESH derivation would build, which is the remembered set pruned. It has its own test and
its own mutation.

### Round five: what the arms found, and how each was ruled

| arm | finding | ruling |
|---|---|---|
| Gemini | a workspace switch DURING a send flushed the draft from a box the send had already emptied, overwriting or deleting the draft that still held the reader's text; the post then took its changed-workspace early return without putting the body back | **Correct, and a regression this lane introduced with the switch flush.** The stored draft is now frozen for the whole post, exactly as the pair is, by the same rule and for the same reason: a handler must not read a moment another handler is in the middle of. `clearComposerDraft` is a removal, not a write, and stays ungated so a landed post always clears its own draft. |
| Grok | a draft WITH a body records the pruned To: set, so a member who leaves and returns while that message is being written stays out of its To: | **Correct mechanism, ruled the other way.** A draft with a body is a message in progress and owns its address. Putting a returning member back into a message the reader is already writing would add a recipient they never chose, which is the hidden recipient this row exists to rule out. A draft with NO body is not a message, so its set is derived again on arrival, which is what `composerAddressIsChosen` gates. The asymmetry is deliberate and is now said out loud at the call site. |
| Grok | `LiveDashboard.astro` still carried a comment saying `renderComposerTo` prunes before it draws, which this lane made false | **Correct.** The retired sentence is gone; the paragraph beneath it already stated the new rule. |
| Grok | the `composerToLive` mutation names `afterSend` while its subject looked like `broadcastSurvivesReload` | **Not a mis-aim, now said in the harness.** The observer clears To: several times, and the first step after a `clearTo` is where a row that refilled itself from storage shows up. The named assertion is the one its failure carries. |

### Round six: what the arms found, and how each was ruled

| arm | finding | ruling |
|---|---|---|
| Grok and Gemini, independently | a message that LANDED after the reader switched workspace left its body in the old workspace's draft; coming back restored the sent text with a null intent, so sending again minted a second command id and posted it twice | **Correct, and the round-five fix uncovered it.** Stopping the emptied box from overwriting that draft removed the thing that had been accidentally covering it. |
| Grok | the claim that `clearComposerDraft` being ungated was enough is false: every call site sat behind the send's changed-workspace return, and the key it would have used was the new workspace's. The source control defending it was green against the false half | **Correct, and it is the doctrine's own failure mode.** The claim and its control are both replaced. |
| Grok | `persistComposerDraft()` in the catch is dead — the send flag is still up, so it returns at its own guard — and `composer-sprint.observer.test.ts` matched that dead line | **Correct.** The call is gone and the test now points at the settle, which is what actually writes the restored body. |
| Grok | the README wrote the in-flight bullet twice and did not name the new bounds | **Correct.** Fixed here. |
| Gemini | the round-five ruling on a draft with a body is wrong, because the reader WOULD see a returning member on the row | **Split, and ruled with Grok, who attacked the same ruling and kept it.** The tiebreak is now stated honestly below rather than resting on the word "chose". |

**The cause underneath both round-five and round-six findings.** The send captures its workspace,
its version, its recipients, its body and its command id, and then addressed its STORAGE through
`activeWorkspaceId`, read at the moment each write ran. Every storage call therefore sat behind a
"is this workspace still mine?" guard that is right for the screen and wrong for the send's own
bookkeeping. Round five found text loss on that path; round six found a resurrected message on it.
The fix is not a third point fix: `composerDraftKey` and `composerToStorageKey` take the workspace
as an argument, the submit captures both keys beside `workspaceId`, and the landed path finishes
its own remember and clear BEFORE the guard that protects the screen.

**The tiebreak on the draft-with-a-body ruling.** Neither the silent prune nor the exclusion that
follows it is something the reader chose; Gemini is right about that. The rule is not "the reader
chose it" but which mistake is worse. Adding a recipient to a message already being written puts
that message in front of somebody the writer never addressed, and that cannot be taken back once
sent. Leaving them out is visible on the row and one click from being fixed. So the composer does
not add, and a draft with no body — which is not a message — derives its set again on arrival.

### Round seven: PASS / FAIL, and the lane stopped here

`d96de1d` is the code SHA both arms read. Gemini: **PASS** — "no seventh instance", and it endorsed
the draft-with-a-body tiebreak. Grok: **FAIL**, on one finding, verified here at its cited lines.

**THE OPEN DEFECT, NOT FIXED, AND IT IS PRE-EXISTING.** A same-workspace `openWorkspace` during a
send wedges the composer for the rest of the session.

- `openWorkspace` calls `resetComposer()` only `if (changesWorkspace)`, and always does
  `const version = ++requestVersion`.
- The submit's `finally` lifts the send flag only when `version === requestVersion &&
  workspaceId === activeWorkspaceId`.
- `setComposerSending(false)` has exactly two call sites: that guarded `finally`, and
  `resetComposer` — which a same-workspace reopen skips.
- Six callers reopen the same workspace: the refresh button, retry-workspace, remove-member,
  edit-model, revoke, and remove-agent.

So pressing Refresh while a message is posting bumps the generation, skips the lift, and leaves
`composerSending` true forever. The box stays read-only, the send button stays disabled, chip
clicks return, and a failed send never puts the body back.

**It is not a regression of this lane.** The merge-base has the same two `setComposerSending(false)`
call sites, the same guarded `finally`, and the same `if (changesWorkspace) resetComposer()`. What
this lane changes is the BLAST RADIUS: `deriveComposerAddress` holds while `sending`, so a stuck
flag now also freezes the To: row — no prune, no tag, no chip edit — where before the row kept
working around a stuck box.

**The shape, named rather than patched.** Six rounds, one family, and round six named its cause
exactly: **work the SEND owns sits behind a guard that asks whether the SCREEN is still the
send's.** Those are two different questions. Round six moved the send's STORAGE out from behind
that guard. Its FREEZE is still behind it, and the freeze is bound to `requestVersion`, which any
same-workspace reopen bumps. The general fix is not a third point fix: every send-owned cleanup —
lifting the flag, restoring the body on failure, settling the address — belongs outside the screen
guard, keyed to the send's own identity, exactly as its storage now is. The screen guard should
protect only what the reader can see.

That fix is a change to the send's failure and teardown paths, which is wider than this lane's
brief, and the PM rule is to stop rather than make a fourth fix in the same family. It is written
down here instead.

**Round eight did it.** See the next section.

**Also from Grok, and fixed in the docs-only commit that carries this note:**
`docs/design/2026-09-04-chat-platform-reconciled.md` still asserted "D2 is not shippable as
written" and called one directed signal per tag "the composer's present workaround". Both were
made false by this lane, and option (b) in that same block is what happened. Corrected in place
with the retired wording preserved.

### Round eight: the shape, fixed rather than named

Round seven wrote the shape down and stopped: **work the SEND owns sat behind a guard that asks
whether the SCREEN is still the send's.** Round six had moved the send's STORAGE out from behind
that guard. This round moves the rest, and gives the moment a control.

**The rule, stated once at the submit's `finally`.** Work the send owns is keyed to the send's own
identity — its token, its workspace, its captured storage keys. The screen guard decides only what
is RENDERED.

| what the send owns | where it ran | where it runs now |
|---|---|---|
| lowering the send flag | the `finally`, only when `version === requestVersion && workspaceId === activeWorkspaceId` | the `finally`, when `composerSendToken === sendToken` — nothing about the screen |
| putting the body back after a failure, with the error and Retry | under `if (version !== requestVersion \|\| workspaceId !== activeWorkspaceId) return;`, the first line of the catch | under a guard that asks the token and the workspace and NOT the generation |
| removing the draft a landed post wrote | already send-owned (round six) | unchanged |
| retiring the command id a landed post minted | below the screen guard | at the top of the landed path, with the rest of the send's own work |
| releasing the send's preview URLs | leaked entirely on the early return | on every path out of the catch |
| the sample's own store, which is what a sample refetch reads | below the screen guard, so a post during a refresh vanished from the feed | with the send's storage, still bound to the send's workspace |
| the status sentence the send put up | the LAST line of the screen block, so a reopen left "Posting message…" standing over a composer that was finished, empty and writable | with the send's own work, keyed to the token |
| settling the address | inside the screen guard | inside the screen guard, now keyed to the token and the workspace |

**Where the line is, stated at the submit rather than left to be inferred.** Everything the send
has to FINISH is the send's: its flag, its status sentence, its draft, its command id, its preview
URLs. Everything the reader is LOOKING AT is the screen's: the feed list, `postedSinceReset`, the
row caches. A reopen rebuilds the list from the server, so a row this client remembers would be a
second source for something the refetch is already bringing back; a switch is looking at another
workspace. The sample has no server, so its own store stands in for that refetch, and it is
written with the send's storage.

`composerSendToken` is the send's identity for the flag. One submit takes a token and only that
submit may lower the flag it raised; `resetComposer` bumps the token, which says the composer that
send raised it on is gone. `requestVersion` cannot answer that question, and that is the whole
defect: six controls reopen the CURRENT workspace and every one of them advances the generation
without running `resetComposer`.

**And the send finally has a window to be measured in.** A sample send resolved with no await at
all, so no browser step in this lane could act while a message was on the wire: both in-flight
freezes were read out of the source and the send's teardown was never driven under a screen that
moved. `sampleSendWindow` reads two document-element hooks — a delay and a failure — and both are
sample-only, because sample mode is entered only when there is no Supabase client at all. The
sample workspace open now also models a REOPEN: it advances the generation and tears nothing down,
exactly as `openWorkspace` does for the workspace already on screen, and the sample Refresh button
takes that path instead of asking a server that is not there.

| new control | what it drives |
|---|---|
| `refreshMidSend` | Refresh pressed mid-post: the flag comes down, the posting sentence comes down with it, the chips answer a click, a new tag still reaches the row, and the message is in the feed once |
| `failedUnderRefresh` | the same Refresh on a send that FAILS: the body is back in the box, the row is addressed, the error names the failure and Retry is offered |
| `switchedUnderFailedSend` | a workspace switch mid-post: the box the reader moved to keeps its own draft, and the earlier send does not lower the flag of the send THAT composer is running |
| `unsentBodySurvivesSwitch` | and the unsent message is still in the workspace it was written in, with its address |
| `resentOnce` | sending it again posts it once |
| `returnedBeforeItFailed` | the reader leaves and RETURNS before the send finishes, and types: the failure does not write its old body over what is in the box now |

Each step records `sawFlagUp`, which is the positive control: it says the step really acted while
the box was read-only, so a window that stopped opening fails on its own assertion rather than
making the step vacuous. Eight mutations drive these, and the first of them — restoring the old
screen-guarded lift — is also the proof that the sample Refresh reaches a generation bump at all.

**The instrument retries a crashed browser, once, and only on a signal.** Measured on this host:
one SIGSEGV in 58 mutation runs, from `--single-process --no-zygote` under memory pressure, and
it landed in a RESTORE run whose source was pristine. A crash is not a measurement, so the retry
weakens no control: a real defect fails on both attempts, and anything that is not a signal death
is rethrown.

**Two controls this round measured and then had to be rebuilt, which is worth recording.** The
first version of the frozen-flag mutation reported RED, WRONG REASON: the in-flight steps used
`clearTo`, which ends in a throwing wait, so a composer left frozen aborted the whole measurement
and the defect arrived as "no measurement" instead of on its own assertion. The steps now clear
without throwing. The first version of the teardown control reported NOT CAUGHT: the token counter
is monotonic, so a SECOND send invalidates an earlier one on its own and a switch-then-send could
not tell whether `resetComposer` retires the token. What does tell is a RETURN with no second
send, which is `returnedBeforeItFailed`.

**Two items left the NOT-established list.** The stored draft's freeze now has a browser control
(`unsentBodySurvivesSwitch`, driven by a mutation that removes the guard), and a send under a
same-workspace reopen is now measured rather than named.

## What is NOT established

- **Nothing here reached production.** Every browser measurement runs against `site/dist` in
  sample mode, where a send is a local row and no `post_signal` is issued. The wire claim is
  about the body this client BUILDS, read from the exported builder; the served edge answers
  for that shape in `tests/p1-server/chat-signals.test.ts`, which this lane did not run.
- **The PAIR's freeze still has no browser control** (2026-09-05, round eight). The stored draft's
  freeze now does: `unsentBodySurvivesSwitch` goes red when the guard is removed. The pair's
  freeze does not, and the reason is the sample roster: what that freeze protects is a PRUNE
  arriving mid-post, and no sample transition loses a recipient. Removing `sending:
  composerSending` therefore changes nothing a browser step can see, so it stays a source claim
  with a source mutation, and what the freeze DOES is driven through `deriveComposerAddress`
  directly.

  RETIRED wording, which a reader may still meet above: "Neither in-flight freeze has a browser
  control ... a sample send never stays in flight long enough for a browser step to act inside
  it." A sample send now can, through `sampleSendWindow`.
- **The in-flight window is the sample's, not a server's.** `data-sample-send-delay` and
  `data-sample-send-fail` only reach the branch that fabricates a row locally. Nothing here
  measures a slow or failing `post_signal`, and the timing the controls rely on is headless
  Chrome's virtual clock rather than a network.
- **A real Refresh was not driven.** The reopen path is the same handler in both modes, and the
  sample Refresh button is hidden because there is no server to fetch from, so the control drives
  a control the reader cannot see in sample mode. What a REAL refresh does after a post — refetch
  the row from the server — is not measured here; the sample stands in for it with its own store.
- **A message whose composer was torn down and typed over is not recovered.** The teardown
  retires the send's token, so a failure arriving after the reader left and came back does not
  put its body back — and by then the reader may have typed over the draft that held it. The
  ruling is which loss is worse: overwriting live text the reader is writing cannot be undone,
  and leaving the older message out is visible and already past. `returnedBeforeItFailed` pins
  the ruling; nothing here recovers the older message.
- **Two per-send cache entries are still dropped only on the screen path.** The pending row's
  `visualMentions` and `deliveryReceiptCache` entries are deleted below the guard. They were
  considered and left there: in both early-return cases the row they describe has already gone
  from `signals` (a reopen and a switch each empty it), and they are two Map entries of the same
  kind the feed already holds for every row. Nothing a reader can see depends on them.
- **The command id retired above the guard is not independently observable.** A landed post whose
  intent survived a generation bump could only be replayed through Retry, which a successful send
  hides. The line is controlled by the source claim in `composer-sprint.observer.test.ts`, not by
  a browser step.
- **The applied record's clear after a send is not independently observable.** The submit no
  longer clears it by hand; the settle in the `finally` derives it from the box the send
  emptied. But ANY pass with an empty body drops a record whose tag has left, so a later
  keystroke or chip click reaches the same state. What is controlled is the settle itself
  (removing it turns a source claim red) and the behaviour it protects
  (`retaggedAfterSend`). The clear as a separate step is not.
- **No browser control reaches a send whose workspace changes under it.** That path carries
  both round-five and round-six findings, and a sample send resolves without an await, so no
  browser step can switch workspace inside one. The fix is read out of the source with three
  mutations on it: the storage is captured, it is done at all, and it is done before the guard.
  What a real post does under a real switch is NOT measured here.
- **A same-workspace `openWorkspace` during a send is not covered at all.** No browser control
  reaches it, no mutation names it, and it is the open defect above. Sample mode cannot reach it
  twice over: a sample send has no await, and `openSampleWorkspace` returns early on the same id.
- **The write of the remembered set is not independently controlled, and the harness says so.**
  Breaking `rememberComposerTo` changes nothing a reader sees, because `pagehide` flushes the
  live chips into the draft and the draft restores them. The READ is controlled
  (`remembered: []` turns `afterReload` red), which is what proves the remembered set is used.
- **The empty-roster state is still not reachable on a RELOAD.** Sample mode has its roster
  before the first render there. It is reachable on a SWITCH, which is what the new controls
  use, and that is the transition the defect lived in.
- **The screenshots are window-sized.** Headless Chrome on macOS refuses a window narrower
  than 500px, so the app is measured inside an iframe sized to the phone. The numbers are the
  phone's; a screenshot may carry a blank gutter beside it.
- **The 108px resting budget is measured at 1440x900 and 390x844 only.**
  `composer-polish.observer.test.ts` opens those two viewports and no other. At 320x568 the
  composer rests at 128.81px, above that number; it is recorded in
  `mobile-measurements.json` with its screenshot rather than gated.
- **Pruning on ENTRY is silent, and deliberately so.** A prune while the composer is open is
  reported, because a chip cannot vanish from under somebody writing to that person. The set
  restored on arrival is pruned without a word: people leave a workspace between messages,
  and greeting every reader with a notice about a set they have not looked at yet is noise.
  The pass decides which case it is in from its own `source`, so no handler has to know.
- **The source sweeps read one file each.** The call-site count in
  `composer-to-field.observer.test.ts` shows that every handler in `LiveDashboard.astro` goes
  through the pass and that nothing else calls it. It does not prove no other module moves the
  set, and a source regex cannot: there is no complete set for it to run over.

## Four of the original mutation wordings changed

The 34 mutations of round four are all still in the harness, but four of them describe rules
that MOVED, so their wording moved with them. Named here because a later reader comparing the
two tables will meet the old wording:

| retired wording | what replaced it, and why |
|---|---|
| "a roster paint does not move the address" | "one pass owns the address, and nothing else calls it". A roster paint now runs the pass on purpose; the rule is that the pass is the only writer, not that a paint never runs it. |
| "the chips are not pruned against a roster that is not known yet" | "a workspace switch keeps the draft's own address across the roster gap". The prune left the render and became the pass's own gate. |
| "a saved draft's tags are on the row after a reload, not lifted in at send time" | "a draft's own address beats the set the last message went to". The load-bearing ORDER of two restores became a precedence rule inside one pass. |
| "a draft carries the set it was being written to" | the same claim, plus "and the pass reads it", because the read and the write are now separate entries. |

One entry was REMOVED rather than reworded: "the next message opens addressed to the last
message's recipients" kept its read-side control and lost its write-side one, for the reason
in "What is NOT established" above.
