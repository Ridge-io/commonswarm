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

## What is NOT established

- **Nothing here reached production.** Every browser measurement runs against `site/dist` in
  sample mode, where a send is a local row and no `post_signal` is issued. The wire claim is
  about the body this client BUILDS, read from the exported builder; the served edge answers
  for that shape in `tests/p1-server/chat-signals.test.ts`, which this lane did not run.
- **The empty-roster guard is a source claim.** Sample mode has its roster before the first
  render, so no browser step can reach the state the guard exists for.
- **The screenshots are window-sized.** Headless Chrome on macOS refuses a window narrower
  than 500px, so the app is measured inside an iframe sized to the phone. The numbers are the
  phone's; a screenshot may carry a blank gutter beside it.
- **The 108px resting budget is measured at 1440x900 and 390x844 only.**
  `composer-polish.observer.test.ts` opens those two viewports and no other. At 320x568 the
  composer rests at 128.81px, above that number; it is recorded in
  `mobile-measurements.json` with its screenshot rather than gated. The old wording said the
  budget held "on every screen" and never opened the smallest one.
- **Pruning on ENTRY is silent, and deliberately so.** A prune while the composer is open is
  reported, because a chip cannot vanish from under somebody writing to that person. The set
  restored on arrival is pruned without a word: people leave a workspace between messages,
  and greeting every reader with a notice about a set they have not looked at yet is noise.
- **The source sweep in `composer-to-field.observer.test.ts` reads one file.** It shows that
  the module building the To: sentences takes its cap and its wake position from the server's
  constants. It does not prove the app has no other typed cap anywhere, and a source regex
  cannot: there is no complete set for it to run over.
