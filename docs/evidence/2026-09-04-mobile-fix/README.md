# 2026-09-04 — mobile header, keyboard, and composer INP

Lane `lane/mobile-fix`. Three defects the operator reported from iOS Safari, with screenshots.
Everything below was measured on `yulanbots-mac-mini` in Chrome against the built `site/dist`.

## What is in this directory

| File | What it is |
|---|---|
| `before-01-header-390x844.png` | The header stack at rest, before the change |
| `before-02-keyboard-390x508.png` | Composer with the keyboard simulated, before |
| `before-03-keyboard-dismissed-390x844.png` | After the simulated keyboard closes, before |
| `after-01-header-390x844.png` | The one-row header at rest, after |
| `after-02-keyboard-390x508.png` | Composer with the keyboard simulated, after |
| `after-03-keyboard-dismissed-390x844.png` | After the simulated keyboard closes, after |
| `before-measurements.json` / `after-measurements.json` | The rectangles behind the numbers below |

`inFlowHeaderHeight` is the distance from the top of the screen to the top of the transcript's
own box — the header height that is taken OUT of the reading area. `floatingBandBottom` is the
bottom of the lowest header bar, whether or not that bar is in the flow.

## 1. Header height at 390x844

|  | before | after |
|---|---|---|
| workspace bar (app bar) | 73px | 73px |
| channel head | 53px, in flow | 52px, **floating over the transcript** |
| filter row (All / Broadcast / Direct to you) | 45px, in flow | 40px, **floating over the transcript** |
| **header height taken from the reading area** | **171px** | **73px** |
| transcript box height (composer top − transcript top) | 655px | 708px |
| first message top at rest | 171px | 125px |

The operator's rule was that the entire mobile header must be no taller than the workspace
header row. The header that consumes layout is now exactly that row: 73px, the same number as
the bar itself. The channel head (live dot + roster pill) and the filter row are painted over
the top of the transcript in one band, which the transcript scrolls under.

The blurb ("Intent posted by every agent in this workspace…") is not on screen on a phone. It
was already hidden below 34rem in `main` as of 2026-09-03; the operator's screenshot came from a
deploy that predates that, and the titleblock that held it is now clipped entirely.

Reachability that moved rather than went away:

- The **view switcher** (Signals / Files / Brain) moved from the channel head into the app bar.
  It is the same three buttons, not a copy — they are `display: none` above 52rem, where the
  rail's own STREAMS and ARTIFACTS lists are the navigation.
- The **gear** left the bar (55px of a row that has to hold three things) and its dialog is
  reached from a "Workspace settings" item in the workspace menu. Verified live at 390px: the
  item is a 222x44 target and it opens the same dialog.
- The **account name** left the trigger (75px; with it there the workspace name got 24px, "R…")
  and is a line inside the account menu, carrying the same `data-rail-account` every writer of
  that name already selects.
- The **channel title** is clipped rather than removed: it is the accessible name of the channel
  section through `aria-labelledby`, so `display: none` would empty that name.

At 1440x900 nothing moved: gear `grid`, tabs `none`, channel head `static` at 0..76, blurb
`block`, rail foot at the bottom of the rail.

## 2. Keyboard and scrolling

Fixed in code:

- `--dashboard-viewport-height` is written from `visualViewport.height` only. `window.innerHeight`
  is no longer the fallback: on iOS Safari it reports the LAYOUT viewport, which does not shrink
  when the keyboard opens, so it wrote a height that was too tall at exactly the moment a shorter
  one was needed. With no `visualViewport` the property stays unset and the stylesheet's `100dvh`
  applies.
- The sync now returns the page to `scrollTo(0, 0)` on every visual-viewport event. iOS scrolls
  the layout viewport when a field near the bottom takes focus, which is what threw the composer
  to the top of the screen and then dropped it part way.
- The sync is coalesced into one write per animation frame; `visualViewport` `scroll` fires many
  times per keyboard animation and each write invalidated layout for the whole shell.
- The caret is remembered while the field has focus and restored when focus returns WITHOUT a
  pointer landing in the text, then scrolled back into the textarea's scrollport.
- Height caps that were written in `dvh` are now written against the measured height: the
  composer textarea, the short-viewport textarea cap, and the mobile bottom sheets.
- The short-viewport rule `max-block-size: 2.75rem` on the textarea is gone. It clipped the second
  line of what was being typed: measured at 390x508, the box needed 64px and was given 44px. Both
  lines are visible in `after-02` and clipped in `before-02`; composer height 63px → 83px.

**NOT ESTABLISHED.** A desktop browser cannot raise a real iOS keyboard. The "keyboard" shots
shrink the viewport to 390x508, which models the SIZE change `visualViewport.height` reports; it
does not reproduce Safari's black accessory bar, its layout-viewport scroll, or its focus and
selection behaviour on show/hide. The clipped-second-line defect IS reproduced and IS fixed. The
accessory-bar and lost-caret reports are addressed by the code above but are **not proven fixed** —
they need a real iPhone.

## 3. Composer INP

Probe: `browser-harness` driving Chrome at 390x844 with mobile emulation and touch, against the
built `/app` in sample mode (real agents and members, so the @mention branch is reachable — the
picker opens with 2 options, asserted on every run). 75 real key events dispatched through CDP,
one per character, 50ms apart, ending in `@ri`. `PerformanceObserver` on `event` and `first-input`
with `durationThreshold: 0`; "worst interaction" is the longest `duration` grouped by
`interactionId`. Three runs per configuration; the same script, the same build pipeline, and the
same assertions on both sides.

### Configuration B — 400-row transcript, 20x CPU throttle

| | before | after |
|---|---|---|
| worst interaction (3 runs) | 80 / 192 / 136 ms — **median 136 ms** | 64 / 72 / 80 ms — **median 72 ms** |
| mean interaction | 48.4 / 57.5 / 57.3 — median 57.3 ms | 43.9 / 45.9 / 50.3 — median 45.9 ms |
| longest handler time | 16.5 / 38.2 / 18.2 — median 18.2 ms | 7.7 / 7.4 / 8.6 — median 7.7 ms |

### Configuration A — 120-row transcript, 6x CPU throttle

| | before | after |
|---|---|---|
| worst interaction (3 runs) | 40 / 48 / 56 ms — **median 48 ms** | 40 / 48 / 40 ms — **median 40 ms** |
| mean interaction | 32.1 / 31.3 / 35.1 — median 32.1 ms | 34.0 / 31.4 / 30.6 — median 31.4 ms |
| longest handler time | 4.4 / 4.3 / 5.4 — median 4.4 ms | 1.9 / 1.5 / 2.8 — median 1.9 ms |

What changed in the keystroke path:

- The @mention search is debounced by 150ms. It closes the picker immediately when the text no
  longer holds an @word, because closing is cheap and a stale open picker offers dead names.
- The draft write is debounced by 300ms. `localStorage` is synchronous, and on iOS Safari it is
  synchronous across processes. It is flushed on `pagehide`, on `visibilitychange` to hidden, and
  on blur, so the draft still survives a reload — there is a control for that in
  `composer-sprint-browser.observer.test.ts`.
- The autogrow (`blockSize = "auto"`, read `scrollHeight`) moved into an animation frame with a
  32ms timer under it, so the forced layout happens after the handler returns and several
  keystrokes in one frame pay for one layout. The timer matters: a hidden tab and a headless run
  get no animation frame.
- `.dashboard__message` carries `contain: layout`, so that forced layout can reuse each
  transcript row's box instead of measuring its contents again. `layout` only — paint containment
  would clip the entity popovers a row opens, and `content-visibility` would change the
  `scrollHeight` `renderFeed` reads to hold the reader's scroll position.

**NOT ESTABLISHED.** The Vercel Toolbar's production figure of **314.3ms** was NOT reproduced and
is NOT the number that improved. This is Chrome on an M4 mac mini, not iOS Safari on the
operator's phone, and the production page also carries the Vercel Toolbar's own listeners. The
absolute numbers here are not the operator's numbers; the before/after comparison is the evidence,
and configuration B is deliberately amplified so a difference is visible above frame quantisation
(the durations land on 8ms multiples).

Also NOT done: `renderFeed` still rebuilds every row from scratch when it runs. That was checked
rather than assumed — every call site was enumerated, and none of them is in the composer input
path, so it is not a cause of the reported INP. Memoising rows is a separate lane.

## Gates

- `npm --prefix site test` — 271 tests, 270 pass, 0 fail, 1 skipped.
- `npm run check:tests` — clean.

Eight test files were touched. Seven were claims about the old layout or the old function names;
each keeps its claim and moves to the new mechanism. `mobile-feed-layout.observer.test.ts` has a
new rule, `assertPhoneHeaderRule`, that states the operator's ruling directly — the transcript's
top edge is no lower than the app bar's bottom edge — with a positive control that the app bar is
a real one-row bar, and a control that the channel head still FLOATS rather than having been
deleted. Its reverted-styles variant was rewritten to put both bars back in the flow, and it still
has to fail.

## Correction, added when the lane was landed

The gate line above ("271 tests, 270 pass, 0 fail, 1 skipped") was true of this lane on its own
base. It is NOT the gate result for the landed code: `main` gained brain-links after it, and the
site suite is 323 tests, 322 pass, 1 skip on the rebased tree. The landing gates, the browser
measurements taken after the rebase, and one defect found reviewing this lane are in
`docs/evidence/2026-09-05-mobile-fix-landing/`.

## Correction: the 171px → 73px row compares two different measurements

The header table above has a row "**header height taken from the reading area**: **171px** →
**73px**". The two numbers are not the same measurement, and this file defines the field they are
labelled with. `inFlowHeaderHeight` is "the distance from the top of the screen to the top of the
transcript's own box", and `before-measurements.json` records it as **126**, not 171. 171 is that
file's `floatingBandBottom` / `totalHeaderChrome`: where the first message began, because the
45px filter row lived INSIDE the transcript box rather than above it.

Under one definition at a time, at 390x844:

| | before | after |
|---|---|---|
| header above the transcript box (`inFlowHeaderHeight`) | 126px | 73px |
| where the first message begins (`totalHeaderChrome`) | 171px | 125px |

Both are real gains. The retired row is kept above because readers will meet it; the commit
message for the lane repeats the same pairing and is wrong in the same way.

The 125px in the "first message top at rest" row was ALSO not what the code did when this file was
written: the clearance under the floating band was the filter row's 2.5rem while the band is as
tall as the roster pill's 3.25rem, so the first message began at 113px and 12px of it sat under
the pill. That is fixed in the landing lane and 125px is now measured. See
`docs/evidence/2026-09-05-mobile-fix-landing/`.
