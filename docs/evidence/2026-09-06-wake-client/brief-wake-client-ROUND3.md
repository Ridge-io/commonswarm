# L4 round 3 — one verified defect (Opus on 9986f19); read /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-client/arms-9986f199758e9eba0295061d2aa85e8adedad339/ARM-opus.txt whole first

DEFECT: a SUBSCRIBED, healthy listener that hit its own client-side 50/min wake-claim budget prints
"poll every 15s. Realtime not connected (rate_limited)." Both clauses are false, and `mode: "poll"` is
emitted beside a non-null `subscribedAt`. `src/listener/wake.ts:212` and `:259-266` fold the client
budget into the server-429 code; `tests/listener-wake.test.ts:625` pins the wrong code.

Fix (Opus's remedy): a distinct error code `wake_budget` (add it to the code enumeration the status
parser reads, so the sentence is derived from the same constant), and a third sentence branch that says
what is true and what happens next, e.g. "Subscribed; claims paused until the minute clears (wake budget);
polling every 15s meanwhile." Keep `mode: "poll"` while paused if the spec's §2.4 row says push means
"subscribed AND claiming on wake"; otherwise state the rule you chose in REVIEW.md with the spec line.
Fix the pinned test so it fails on the old code (mutation row), and add the sentence to the copy test that
enumerates codes from the constant. Nothing else changes.

Gates as before. Freeze the new SHA (REVIEW.md, DIFF.patch), ONE Gemini arm detached, overwrite
/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-client-REPORT.md. Stop. Never db:reset, never production.
