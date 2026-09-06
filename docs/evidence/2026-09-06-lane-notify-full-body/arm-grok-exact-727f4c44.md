I'll review L1 against C1 by reading the changed files, the CLI JSON emit, and the tests that pin the body and suffix.I'll keep reading the snippet helpers, the notify emit path, and the new tests so I can check each C1 claim against the code.I'll check the test gate, the notify writer, and any JSON snapshots that could still assume a snippet-only payload.I'll sweep help text, JSON field lists, and related claims so a stale field list cannot pass as a review.SHA `727f4c44`. Two files. `src/cli.ts:4054-4058` still does `JSON.stringify(notification)` vs `formatArrivalNotification(notification)`. `tests/support/arrival-watch.test.ts` is in the `npm test` list. That file: 22 tests, 22 pass.

**(1) `--json` body, up to 8,000 chars — yes.**  
`arrivalNotification` sets `body: signal.body` with no clip (`src/cloud/arrival-watch.ts:421`). The CLI prints that object when `--json` is set (`src/cli.ts:4055-4056`). The test round-trips 8,000 `x` chars and keeps `body !== snippet` (`tests/support/arrival-watch.test.ts:243-255`).

**(2) Suffix from the cap and run-time lengths, never typed — yes.**  
Cut check uses `ARRIVAL_SNIPPET_MAX` (`arrival-watch.ts:360-361`). The phrase uses `snippet.length` and `body.length` plus `ARRIVAL_FULL_TEXT_COMMAND` (`arrival-watch.ts:370-377`). Grep of `src/cloud/arrival-watch.ts` finds `180` only at the constant (`arrival-watch.ts:35`).

**(3) Test fails if the constant and the phrase differ — yes.**  
At cap: no phrase. One more char: phrase uses `ARRIVAL_SNIPPET_MAX` and `ARRIVAL_SNIPPET_MAX + 1` (`arrival-watch.test.ts:277-298`). A 1,234-char body checks the same phrase against run-time lengths (`arrival-watch.test.ts:257-270`). A typed `180` in the suffix would fail as soon as the constant moved.

**(4) Regression for readable-line or JSON readers — no blocking one.**  
Under the cap the readable line is unchanged (suffix `""`, `arrival-watch.ts:373`; old tests at `arrival-watch.test.ts:192-237`). Over the cap, the extra phrase sits after the snippet and before attachments and ` — reply:` (`arrival-watch.ts:431-434`, `arrival-watch.test.ts:270`). JSON gains `body` next to `snippet`. Old keys stay. Additive.

**(5) Claim the code does not enforce — none that fail C1/L1.**  
Comments and test names match the cut rule, the generated phrase, and the 8,000-char JSON body.

Notes (not fail):

- C1’s prose says `body.length > ARRIVAL_SNIPPET_MAX`. The code cuts after whitespace collapse (`arrival-watch.ts:360-361`, `386-391`). The extra test at `arrival-watch.test.ts:304-314` encodes that. For the required cap pair (`z` × MAX / MAX+1) the two conditions match.
- C1’s “ends with” is the snippet cut, not the last bytes of the line. The line still ends with the reply command (`arrival-watch.ts:434`).
- The `--json` test stringifies the notification object. It does not spawn `cswarm inbox --notify --json`. The CLI path is the same stringify (`src/cli.ts:4055-4056`).
- After a cut, `snippet.length` can be &lt; `ARRIVAL_SNIPPET_MAX` if `trimEnd` eats a space at the slice (`arrival-watch.ts:383`). The phrase then reports that shorter length. That matches C1’s run-time lengths. The comment at `arrival-watch.ts:367-369` is a bit strong.

Not established: a live Monitor/`cswarm inbox --notify --json` process; phone OS clip of the readable line; `npm run test:p1-cli`.

VERDICT: PASS
