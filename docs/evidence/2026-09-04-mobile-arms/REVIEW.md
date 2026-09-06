# 2026-09-04 — D-036 review of `lane/mobile-fix` @ `6cbda50`

Subject: branch `lane/mobile-fix`, commit `6cbda50`, worktree `/tmp/lane-mobile-a`.
Merge-base `6e433705c6ba9e5e430d32c8b98e1a8a09170322`; the diff was taken from the merge-base,
79,959 bytes total, 63,837 bytes under `site/` (the rest is six PNGs and the evidence README).

Two arms, run SEQUENTIALLY, never overlapping, each on that exact diff.

| Arm | Tool | Family | Result |
|---|---|---|---|
| Exact review | `grok -p` (pid 75814) | Grok | **`VERDICT: FAIL`** — 1 BLOCKER, 3 SHOULD-FIX |
| Cross-family inversion | `agy --dangerously-skip-permissions -p` (pid 10029) | Gemini | **`VERDICT: FAIL`** — 3 BLOCKER, 4 SHOULD-FIX |

Raw, unedited arm output: `grok-exact.txt`, `agy-inversion.txt`. Each contains exactly one
`VERDICT:` line (`grep -c VERDICT` = 1 for each). Both bodies were read end to end. Neither is a
repetition loop; neither contains contradictory PASS and FAIL text; both ran to completion.

Every finding below was re-derived by opening the cited line. Findings that did not survive that
check are listed under REJECTED with the reason. Four browser probes are committed beside this
file with their scripts, so each measurement can be re-run.

Citation quality: Grok's `file:line` citations were exact. Gemini's were within ±2 lines. I opened
every one; **no fabricated citations in either arm.**

---

## RECOMMENDATION: **DO NOT MERGE.** Three blockers, all reachable, none caught by any gate.

Two of the three are on the DESKTOP path, which the lane claims is unchanged. I ran seven of the
eight changed test files (37 tests, 37 pass, 1 skipped) and all three blockers are green.

Fix list, in order of severity:

1. `workspaceMenuItems()` must filter on visibility, not on the `hidden` attribute.
2. The mention picker must be flushed synchronously before `Enter` decides to submit.
3. `scrollTo(0, 0)` must be gated on `app.dataset.state === "channel"`.

---

## CONFIRMED — BLOCKER 1: the new menu item breaks desktop keyboard navigation

Found independently by BOTH arms and by me. Measured.

The lane adds a "Workspace settings" `role="menuitem"` button inside the workspace `role="menu"`
and hides it above 52rem with **CSS**:

- `site/src/components/app/LiveDashboard.astro:239-247` — the new button, the LAST item in the menu.
- `site/src/components/app/LiveDashboard.astro:8945-8947` — `.dashboard__workspace-settings-item { display: none }` on desktop.
- `site/src/components/app/LiveDashboard.astro:10050-10052` — `display: flex` below 52rem.

The existing roving-focus enumeration filters on the HTML `hidden` **attribute**, not on visibility:

- `site/src/components/app/LiveDashboard.astro:2809-2811` — `.filter((item) => !item.hidden)`.
- `site/src/components/app/LiveDashboard.astro:5515-5526` — `Home`/`End`/`ArrowDown`/`ArrowUp` index into that array and call `.focus()`.
- `site/src/components/app/LiveDashboard.astro:2830-2835` — `openWorkspaceMenu("last")` focuses `items.at(-1)`.

`.focus()` on a `display: none` element is a silent no-op, so the array holds a member that can
never take focus, and it is the LAST member.

**Measured** — `verify-menu-keyboard.txt`, script `verify-menu-keyboard.probe.mjs`. Headless Chrome
against the built `site/dist`, the same synthetic keydown sequence at three widths:

| width | settings `display` | enumerated items | focus after `End` | ArrowDown ×1 | ArrowDown ×2 |
|---|---|---|---|---|---|
| **1440x900** | `none` | 2 (incl. the hidden one) | **New workspace — unchanged** | **unchanged** | **unchanged** |
| 390x844 | `flex` | 2 | Workspace settings | New workspace | Workspace settings |
| 320x568 | `flex` | 2 | Workspace settings | New workspace | Workspace settings |

The 390 and 320 rows are the positive control on the same invocation: the same probe, the same
events, the same code DO move focus there. At 1440 focus never moves at all. `ArrowDown` from the
last visible item is a permanent dead end — it can never wrap back to the top of the menu.

By code reading (**NOT measured** — my probe's own control for this case failed, see REJECTED #4):
`ArrowUp` on the workspace trigger calls `openWorkspaceMenu("last")`, which focuses the invisible
item, so the menu opens with focus still on the trigger; a second `ArrowUp` returns early at
`LiveDashboard.astro:2825` because the menu is already open. Both arms assert this; I could not
measure it.

Why no gate caught it: `the workspace menu supports keyboard, Escape focus restore, and
click-outside close` (`workspace-switcher.observer.test.ts:69-92`) is a source-regex test. It
asserts the handler exists. It cannot see a CSS-hidden item, so it passes.

**Fix:** filter on visibility in `workspaceMenuItems()` (`getClientRects().length > 0`), or hide the
item with the `hidden` attribute driven by a `matchMedia` listener instead of `display: none`.

---

## CONFIRMED — BLOCKER 2: `Enter` within 150ms of an `@word` posts a BROADCAST

I found the debounce/`Enter` race; the Gemini arm found what it actually costs. Verified.

- `site/src/components/app/LiveDashboard.astro:5690` — the input handler now calls `scheduleMentionPicker()` where it used to call `renderMentionPicker()` directly.
- `site/src/components/app/LiveDashboard.astro:2769-2782` — that schedules the render 150ms later; the picker stays hidden until then.
- `site/src/components/app/LiveDashboard.astro:5784` — the mention branch of the keydown handler runs only `if (picker && !picker.hidden)`.
- `site/src/components/app/LiveDashboard.astro:5812-5816` — so `Enter` falls straight through to `requestSubmit()`.

Then the send path:

- `site/src/components/app/LiveDashboard.astro:5845` — `const address = composerAddressFrom(rawBody);`
- `site/src/components/app/LiveDashboard.astro:5858-5860` — `const recipients = address.recipients.length === 0 ? [{ kind: "everyone" }] : address.recipients;`
- `site/src/components/app/LiveDashboard.astro:2211-2213` — "A body with no tag is a broadcast."

An INCOMPLETE tag (`@Riv`) matches no roster name, so `address.recipients` is empty and the fallback
makes it a broadcast. **A user who typed a prefix and relied on autocomplete posts to the whole
workspace instead of to one person.** CommonSwarm signals are immutable, so it cannot be taken back.
Before this diff the picker was open synchronously and `Enter` completed the mention.

A fully typed name still resolves correctly, so the harm is specific to "typed a prefix, expected
the picker".

Related, lower severity: once the picker IS open, the keydown handler recomputes `candidates` fresh
(`LiveDashboard.astro:5785-5786`), so the visible highlight can be up to 150ms staler than the name
that gets inserted. Displayed name and inserted name can disagree.

**Fix:** in the keydown handler, if a mention timer is pending and `mentionSearch()` matches, call
`renderMentionPicker()` synchronously before deciding what `Enter` means.

---

## CONFIRMED — BLOCKER 3: `scrollTo(0, 0)` is not gated to the state that needs it

Raised by both arms; verified independently.

`site/src/components/app/LiveDashboard.astro:2633-2651`:

```
const syncDashboardViewport = (): void => {
  viewportSyncFrame = 0;
  if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
```

registered on `window` `resize` and on `visualViewport` `resize` and `scroll`. The only gate is
"the page is scrolled" — which is exactly the condition under which the reset hurts.

The reset is correct only for the channel shell, and only the channel shell is locked:

- `site/src/components/app/LiveDashboard.astro:6349-6354` — `overflow: hidden` and a fixed block-size apply to `.dashboard[data-state="channel"]` only.
- `site/src/components/app/LiveDashboard.astro:6344-6347` — every other state uses `min-block-size`, so the document scrolls.
- `site/src/components/app/LiveDashboard.astro:6409-6410` — `.dashboard__gateway { min-block-size: 100svh }`.
- The five states are `loading`, `signed-out`, `create`, `workspace-error`, `channel` (`LiveDashboard.astro:28, 35, 106, 147, 175`). **`signed-out` and `create` both carry text inputs** — exactly where iOS raises the keyboard and scrolls the layout viewport, and exactly where the mobile URL bar collapses as you scroll and fires a `visualViewport` event.

**Measured** (`verify-page-scroll-CONTROL-FAILED.txt`): at 390x844 in the `signed-out` state the
root computes `overflow: visible` with `scrollHeight` 2844 against `clientHeight` 844; flipping
`data-state` to `channel` computes `overflow: hidden`. So "only the channel state locks the page"
is measured.

**NOT measured:** whether the reset actually yanks a scrolled page. Headless Chrome would not let
the probe scroll the iframe document at all — `controlA_immediate` read 0 with no event fired — so
that probe never reached the path and its zeros are not evidence about the feature. The consequence
above is a code reading.

**Fix:** gate the reset on `app.dataset.state === "channel"`.

---

## CONFIRMED — SHOULD-FIX 1: going hidden mid-post now deletes the draft

Raised by Grok; the Gemini arm found a second instance of the same shape. Both verified.

`site/src/components/app/LiveDashboard.astro:5920` — the send path clears `input.value = ""`.
`site/src/components/app/LiveDashboard.astro:6005` — `clearComposerDraft()` runs only after the
posts resolve.

Between those two points:

- the new `visibilitychange` listener (`LiveDashboard.astro:5708-5710`) can fire, calling `persistComposerDraft()` with an empty body, which takes the `body === "" && !hadAttachments` branch at `LiveDashboard.astro:2311-2313` and does `localStorage.removeItem(key)`. Before this diff there was no lifecycle handler at all, so the last synchronously-written draft survived in storage through the post. Being killed while backgrounded mid-post now loses the text.
- if the user starts typing the NEXT message while the first is still posting, `clearComposerDraft()` at `:6005` cancels that pending timer (`cancelComposerDraftTimer()` at `:2292`) and removes the key. The text is still in the textarea, so this is a narrow window, not visible loss — the next keystroke reschedules.

**Fix:** skip the flush and the clear while `setComposerSending(true)` is in effect.

---

## CONFIRMED — SHOULD-FIX 2: two observer assertions got weaker

Both arms flagged this family. These two clauses hold; a third they raised does not (see REJECTED #7).

**(a) The phone branch lost its ceiling on the floating band.**
`site/src/components/app/mobile-feed-layout.observer.test.ts:387-389` sends every non-1440 width
into `assertPhoneHeaderRule` and returns. The old rule was
`measurement.header.height <= measurement.shell.channel.top` — a CEILING on the head. The new rule
is `measurement.header.height > 0 && measurement.header.top >= appBar - 0.5`
(`mobile-feed-layout.observer.test.ts:372-376`), which is a FLOOR. `channelBody.top <= appBar + 0.5`
(`:365-369`) is satisfied by any out-of-flow head, including one that covers half the transcript.
The same swap is at `mobile-feed-layout.observer.test.ts:492-494`, in a test whose name still says
"keeps the whole header inside the app bar row".

The other two deletions in that function are NOT weakenings: the phone `transcriptMin` went 500 →
600 (`:377-380`), which is stricter, and the ratio floor it replaced is subsumed at a fixed viewport.

**(b) The viewport assertion no longer pins where the height comes from.**
`site/src/components/app/composer-sprint.observer.test.ts:438-439` replaced
`/window\.visualViewport\?\.height \?\? window\.innerHeight/` with
`/const viewport = window\.visualViewport;/`. Nothing in that block now asserts that the published
custom property is written from `viewport.height`. I enumerated the whole mutation list
(`composer-sprint.observer.test.ts:598-717`, 19 mutations): **none targets the height write.** A
mutation replacing `Math.round(viewport.height)` with a constant would pass every assertion.

Lower, same family: `composer-sprint-browser.observer.test.ts:365` now dispatches `pagehide` before
reading storage, so the draft control exercises only the `pagehide` flush. A regression that dropped
the `visibilitychange` and `blur` flushes would still pass.

**Fix:** add an upper bound on `measurement.header.height` in `assertPhoneHeaderRule`; re-pin
`Math.round(viewport.height)` with a matching mutation.

---

## PARTIALLY CONFIRMED — SHOULD-FIX 3: the caret restore fires with a caret nobody set

Both arms called this BROKEN. The mechanism is real; the user-visible harm is NOT established in
Chrome, and I could not test the browsers where it would show.

The mechanism, verified by reading and by measurement:

- `site/src/components/app/LiveDashboard.astro:2570` — `composerCaret` initialises to `{ end: 0, start: 0 }`.
- `site/src/components/app/LiveDashboard.astro:2536` — `restoreComposerDraft()` sets `input.value = draft.body` and never updates `composerCaret`.
- `site/src/components/app/LiveDashboard.astro:2545-2554` — `focusComposerOnEntry()` focuses the box on desktop; `Tab` does it on any device.
- `site/src/components/app/LiveDashboard.astro:5717-5722` — with no pointer in the last 500ms, the focus listener calls `restoreComposerCaret()`, which runs `setSelectionRange(0, 0)`.

**Measured** (`verify-caret-restore.txt`): setting `.value` does put the caret at the end
(`[11, 11]`), and focus does end at `[0, 0]`. **But the control landed at `[0, 0]` too.** With a
`pointerdown` first — which makes the listener return early at `:5720` — Chrome still gives
`[0, 0]`. So `focus()` alone produces 0 in Chrome and the probe does not isolate the new code. The
restore itself demonstrably works when something HAS been remembered
(`case2_caretRestored` = `[5, 5]`).

What that leaves: in a browser that preserves the end-of-value selection across `focus()`, the code
would move the caret to the start of a restored draft. I have no measurement for Safari or Firefox.
The fix is one line and free, so take it regardless.

**Fix:** make `composerCaret` nullable and skip `restoreComposerCaret()` until a caret has actually
been remembered.

---

## CONFIRMED — NIT 1: five bare `2.5rem` literals must agree or the band breaks

`site/src/components/app/LiveDashboard.astro:10205, 10206, 10234, 10239, 10243` — the toolbar's
`min-block-size`, the negative `margin-block-end` that takes its height back out of the flow, the
filter buttons' `min-block-size`, and the two `padding-block-start` clearances. Four must be equal
and the fifth must not exceed them. None is a shared custom property, and no test asserts they
agree. Same failure shape as the repo's "an enumeration inside a message must be generated, not
typed" rule.

## CONFIRMED — NIT 2: a measured claim in a comment is false

`site/src/components/app/LiveDashboard.astro:10023-10025` says "1rem is not 16px on this page —
measured 6rem = 82px at 390px wide". **Measured** (`verify-band-geometry.txt`): the root font-size
on `/app` is `16px` and the body is `16px`. The `minmax(9rem, 1fr)` beside that comment therefore
reserves 144px, not the ~123px the comment implies. Nothing breaks; the stated measurement is wrong.

## CONFIRMED — NIT 3: 40px of dead space when "Load older updates" is showing

Raised by the Gemini arm; **measured** (`verify-band-geometry.txt`, 390x844). With
`[data-feed-more]` hidden the first message sits at y=113. With it visible, `.dashboard__feed-more`
runs 73..197 and the first message starts at 237 — a 40px gap, because the toolbar's `-2.5rem`
margin is consumed by `.dashboard__feed-more` (`LiveDashboard.astro:10243`) while `.dashboard__feed`
still adds its own 2.5rem (`LiveDashboard.astro:10239`).

## CONFIRMED — NIT 4: a `<p>` is a direct child of `role="menu"`

`site/src/components/app/LiveDashboard.astro:372` adds `<p class="dashboard__user-menu-account">`
inside the `role="menu"` at `:359-366`. A menu's children should be menuitems. Note the pattern was
already violated by the sibling `<a class="dashboard__wordmark …">` at `:388`, so the diff makes an
existing problem one item worse rather than creating it.

## CONFIRMED — NIT 5: `resetComposer()` leaves a draft timer running

`site/src/components/app/LiveDashboard.astro:2780-2804` clears the textarea but cancels neither
`composerDraftTimer` nor `composerResizeFrame`/`composerResizeTimer`. I could not name a
user-reachable route where this loses data (see REJECTED #6), but a `cancelComposerDraftTimer()`
there costs nothing and closes the class.

---

## REJECTED findings

**1. "The floating band hides the first message."** (Grok SHOULD-FIX; Gemini ATTACK A "BROKEN".)
Both arms computed head = 3.25rem = 52px against a 2.5rem = 40px clearance and concluded the first
message is overlapped. The BOX overlaps; no CONTENT does. **Measured** at 390x844
(`verify-band-geometry.txt`): channel head 73..125, roster pill 77..**121**, first message box
113..225, first message BODY **129**..209. The message's own 16px `padding-block-start`
(`messagePaddingTop: "16px"`) absorbs the 12px overlap and the body text starts 8px clear of the
pill. Rejected as stated.

**2. "A short feed's only row sits under the band."** (Grok.) Same measurement:
`.dashboard__feed` carries `padding-block-start: 40px` INSIDE the scroller, so a single row's body
still starts at 129. Rejected.

**3. "Scroll-to-bottom can land under the band."** (Mine, going in.) **Measured**: at
`scrollTop = scrollHeight` (3996) the last message occupies 656.1..769.4 — far below the band's 125
and above the composer's 781. The band is at the TOP; the newest message is at the BOTTOM. Rejected.

**4. "`ArrowUp` on the trigger strands focus outside the menu."** (Both arms; also my own reading.)
The reasoning is sound and I have kept it in BLOCKER 1 as a code reading, but it is **not measured**:
my probe's positive control failed. `control_afterTriggerArrowDown` left focus on the trigger at
1440 AND at 390, because `openWorkspaceMenu` defers its `focus()` to `requestAnimationFrame`
(`LiveDashboard.astro:2835`) which headless virtual time did not deliver. A probe whose control
cannot pass proves nothing, so this specific sub-case is reasoned, not measured.

**5. "`contain: layout` will break the entity popover."** (Mine, going in.) `contain: layout` does
create a stacking context and a containing block for positioned descendants. I enumerated every CSS
rule whose selector mentions `dashboard__message` and that sets `position`, `z-index`, `transform`
or `filter`: the only hits are `contain: layout` itself (`:9539`) and a `transform: rotate` on a
`summary::after` (`:9873`). `.dashboard__entity-panel` (`position: fixed`, `:9998`) is declared at
`LiveDashboard.astro:766` as a top-level sibling, not a descendant of a row. No breakage. Rejected.
(Side note: the justifying comment at `:9536` is therefore imprecise — paint containment would not
have clipped that panel either, because the panel is not inside the row.)

**6. "A workspace switch deletes the other workspace's draft."** (Gemini BLOCKER 2; also my own
reading.) The race is real in the abstract: `resetComposer()` at `LiveDashboard.astro:4628` clears
the box, `activeWorkspaceId` changes at `:4649`, and neither cancels a pending draft timer, so a
timer from workspace A would fire against workspace B's key with an empty body and `removeItem` it.
Gemini's argument that this is reachable rests on "in WebKit/macOS Safari, clicking a `<button>`
does not blur a focused textarea" — which is true, but does not finish the job: opening the menu
focuses a menu item through `requestAnimationFrame` at `LiveDashboard.astro:2835`, and THAT blurs
the textarea, so the `blur` listener at `:5711-5716` flushes and cancels the timer while
`activeWorkspaceId` is still A. Every route to `openWorkspace` that a user can take with an unsaved
draft goes through that menu. Neither arm named a route that skips it and neither did I. Downgraded
to NIT 5. Not established as a blocker.

**7. "`header-roster.observer.test.ts` deleted four assertions and got weaker."** (Gemini ATTACK I
item 3.) The four deleted assertions pinned a `@media (max-width: 34rem)` grid
(`minmax(2rem, 1fr) auto minmax(2.75rem, auto)`, `grid-column: 2/3` placements) and a
`text-overflow: ellipsis` on a title. That grid and that visible title no longer exist — the head is
`position: absolute` with `flex-wrap: nowrap` and the titleblock is clip-hidden. The replacements
pin the new mechanism and are of the same strength, and the regexes actually TIGHTENED from
`[\s\S]*` to `[^}]*` (scoped inside one rule block). Retiring a claim whose mechanism was deleted is
not weakening it. Rejected.

**8. "`aria-current` desyncs across the duplicated view-switcher buttons."** (Mine, going in.) All
three writers use `all("[data-workspace-view]")` — `LiveDashboard.astro:4550-4552`, `:4892`,
`:6083`. Same for the duplicated account name: every writer of `[data-rail-account]` uses `all()`
(`:1422`, `:4376`, `:4566`, `:5164`). Rejected.

**9. "The one-row app bar overflows at 320px."** (Mine, going in.) `minmax(9rem, 1fr)` will not
shrink below 144px. **Measured** (`verify-menu-keyboard.txt`): `.dashboard__rail` reports
`scrollWidth` 320 against `clientWidth` 320 at 320x568, and 390/390 at 390x844. No overflow.
Rejected.

---

## Claims I checked and found TRUE

- **Header geometry (claim 1).** Measured at 390x844: app bar 0..73, channel top 73, channel head floating at 73..125 out of flow, filter row sticky at 73..113 with `margin-block-end: -2.5rem`, first message at 113. In-flow header = 73px = the app bar exactly. Matches the lane's `after-measurements.json`.
- **Viewport fallbacks (claim 3, first part).** All ten CSS readers of `--dashboard-viewport-height` carry the `100dvh` fallback: `LiveDashboard.astro:6309, 6346, 6351, 6695, 6744, 9281, 10250, 10262, 10270, 10492`. With no `visualViewport` the JS returns at `:2637` and never sets the property. **No browser is left with no value.** Both arms agree; enumerated independently.
- **Composer bound (claim 3, third part).** `max-block-size: 2.75rem` was not removed, it was replaced: `LiveDashboard.astro:10492` is `min(calc(var(--dashboard-viewport-height, 100dvh) * 0.25), 5rem)`. At 390x508 that is `min(127px, 80px)` = 80px. Bounded. Both arms agree.
- **Scroll-to-bottom (claim 1).** Measured; see REJECTED #3.
- **Gates.** I re-ran seven of the eight changed files — `composer-sprint`, `transcript-shape`, `header-roster`, `workspace-switcher`, `workspace-entry` (32 pass) and `mobile-feed-layout`, `composer-sprint-browser` (5 pass, 1 skipped). 37 pass, 0 fail. I did NOT re-run the full 271-test suite, so the lane's 271/270/1 line is corroborated, not reproduced.

## Claims I did NOT establish

- **The INP numbers (claim 2).** 136ms → 72ms at 400 rows and 20x throttle is the lane's own measurement; I did not reproduce it. Every mechanism it credits is present in the code. The lane's own README already says the production 314.3ms figure was not reproduced.
- **Claim 4, "desktop at 1440x900 is unchanged", is FALSE** as written. Desktop keyboard navigation of the workspace menu is measurably broken (BLOCKER 1) and the `resize` listener now runs `scrollTo(0, 0)` on desktop (BLOCKER 3). Desktop LAYOUT at 1440x900 does appear unchanged; desktop BEHAVIOUR is not.
- **Anything about real iOS Safari.** Every measurement here is headless Chrome on an M4 mac mini, the same limit the lane's own README states. The keyboard, accessory-bar and layout-viewport-scroll behaviours are addressed in code and are not proven fixed.
- **Whether the ungated `scrollTo(0, 0)` actually yanks a scrolled page** — see BLOCKER 3; that probe's control failed.

---

## Files in this directory

| File | What it is |
|---|---|
| `grok-exact.txt` | Arm 1 raw output, unedited |
| `agy-inversion.txt` | Arm 2 raw output, unedited |
| `verify-menu-keyboard.txt` / `.probe.mjs` | BLOCKER 1 measurement and its script |
| `verify-band-geometry.txt` / `.probe.mjs` | Band geometry at 390x844, and REJECTED #1, #2, #3, NIT 2, NIT 3 |
| `verify-caret-restore.txt` / `.probe.mjs` | SHOULD-FIX 3 measurement, including the control that failed to discriminate |
| `verify-page-scroll-CONTROL-FAILED.txt` / `verify-page-scroll.probe.mjs` | BLOCKER 3 — the state/overflow result is valid; the scroll result is NOT, its control never moved the page |
