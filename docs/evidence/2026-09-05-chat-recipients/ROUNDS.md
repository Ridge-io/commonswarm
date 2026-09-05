# lane/chat-recipients — the six D-036 rounds

Two arms per round, cross-family, on the exact SHA: Grok (`grok`) and Gemini
(`agy --model gemini-3.1-pro-high`). Every file here is the arm's raw stdout
(`*-ARM.txt`) and the brief it was given (`*-REVIEW.md`), named by the SHA it
reviewed. Nothing is edited.

| Round | SHA | Grok | Gemini | What the FAIL found |
|---|---|---|---|---|
| 1 | `07ffc67` | PASS | FAIL | A cap gate that substring-matched its own bound (`BETWEEN 0 AND 7` matches `75`), and a compat claim that did not name the one thing that differs. Grok also found a real product defect nobody had asked about: a later recipient could read a signal and got 403 replying to it. |
| 2 | `bf8118c` | FAIL | PASS | The delivery fan-out wrote rows nothing can deliver — `hydrateDeliveryRefs` filters on the scalar recipient, so a row for recipient 1 leases, fails to hydrate, answers 403 and commits, burning an attempt until the row terminalizes; and an installed listener refuses a delivery whose `signal.to_agent` is not its own principal. The trigger was removed. |
| 3 | `5761bf6` | FAIL | FAIL | Four sentences still promised a fan-out after it was removed, one of them current prose. And `includes(String(N))` on a bound is satisfied by a longer number ending in the same digits, in three more places. |
| 4 | `d679b00` | FAIL | PASS | "L2 addresses N recipients and wakes ONE of them" is false whenever position 0 is a person. The group-DM story was told two ways at once. |
| 5 | `456527d` | FAIL | FAIL | "right about every agent except one" and "recipient 0 woken once" are the same slip again. "Exactly what the recipient set grants on the read path" reads as if there were one read path; there are two, and the agent one is narrower. |
| 6 | `327c6ad` | PASS | PASS | — |

Five successive rounds each found one more wrong summary of one rule, each
written to fix the previous one. Round 6 stopped writing summaries: the wake
rule is one string repeated verbatim on three surfaces, with a claim-family gate
in `tests/chat-channel-constants.test.ts` that fails if a surface drops it or if
a retired wording appears with no retirement marker before it.

## Residual named by Grok on the passing SHA, not fixed

The build plan's ORIGINAL L2 paragraph still contains "enqueues one row per
agent recipient". The gate's needle carries the word "delivery" and so does not
match it, and the `CORRECTED` banner that retires that paragraph sits about 920
characters earlier, outside the gate's 400-character window. Grok read it as a
kept historical plan rather than a live claim and did not fail the lane on it.
It is recorded here so the next reader can widen the needle, move the banner, or
rule that the banner above the paragraph is enough.
