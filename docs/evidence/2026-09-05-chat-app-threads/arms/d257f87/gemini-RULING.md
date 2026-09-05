# Ruling on the Gemini arm, d257f87 — VERDICT: FAIL, finding 5 verified WRONG

Gemini's FAIL rests on one finding. Verified at the cited lines before ruling.

> 5. "The block sets `composerSending = false` unconditionally. Because it is placed in
> `finally`, it runs even if the screen guard fired."

**Wrong on two counts, both checked against the file.**

1. **The call is guarded, not unconditional.** `LiveDashboard.astro:8450` reads
   `if (composerSendToken === sendToken) setComposerSending(false);`. The token is the SEND's
   own identity, and it is exactly the question Gemini says is not asked.
2. **A workspace switch takes the flag away from that send first.** `resetComposer` runs on the
   switch and does `composerSendToken += 1` (`:3701`) then `setComposerSending(false)` (`:3702`).
   So the old send's `finally` finds a token that is no longer its own and lowers nothing, and
   the composer in the new workspace has had its flag lowered by the teardown that built it.
   The scenario in the finding — a send from workspace A clearing the lock for workspace B —
   cannot happen.
3. **The line is not this lane's.** `git diff 89ac83b..d257f87 -- LiveDashboard.astro` contains
   no `setComposerSending` hunk. It landed with `lane/composer-to-field` and carries its own
   mutation entry there ("the send flag comes down because the SEND says so, not because the
   screen has not moved"), which fails when the guard is replaced by a screen comparison.

**Not acted on.**

Its other seven entries are "cannot be refuted". Two are worth naming because they read as
findings rather than confirmations:

- **7, `?m=` is not built.** Correct, and already in the README's "did NOT establish" list, as it
  is in the channels lane's. Owed, not a defect of this lane.
- **8, the liveness margin is shadowed.** Correct and deliberate: it is a SQL interval literal
  inside a tagged template, so there is no constant to import. The arm names the observer test
  that pins the copy to the edge's own SQL, which is the control the doctrine asks for.
