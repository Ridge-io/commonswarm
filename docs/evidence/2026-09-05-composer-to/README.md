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

## What is NOT established

- **Nothing here reached production.** Every browser measurement runs against `site/dist` in
  sample mode, where a send is a local row and no `post_signal` is issued. The wire claim is
  about the body this client BUILDS, read from the exported builder; the served edge answers
  for that shape in `tests/p1-server/chat-signals.test.ts`, which this lane did not run.
- **The in-flight freeze has no browser control.** A sample send resolves without an await, so
  there is no window in which a browser step could change a roster underneath one. What the
  freeze DOES is driven directly through `deriveComposerAddress` in `composer-address.test.mjs`,
  which is the same function the dashboard calls; what the dashboard FEEDS it (`sending:
  composerSending`) is a source claim with a mutation on it. Neither reaches a real post.
- **The applied record's clear after a send is not independently observable.** The submit no
  longer clears it by hand; the settle in the `finally` derives it from the box the send
  emptied. But ANY pass with an empty body drops a record whose tag has left, so a later
  keystroke or chip click reaches the same state. What is controlled is the settle itself
  (removing it turns a source claim red) and the behaviour it protects
  (`retaggedAfterSend`). The clear as a separate step is not.
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
