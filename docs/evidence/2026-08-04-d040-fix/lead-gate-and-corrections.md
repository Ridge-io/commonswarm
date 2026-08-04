# D-040 fix — Lead gate run, and three corrections to my own claims

Candidate: **`de848ee`** on `fix/v015-d040`, based on the frozen `175f894`.
Evidence commits sit on top of it; **the code is `de848ee`** and that is verifiable —
`git diff de848ee..HEAD -- src/ supabase/ tests/` is empty.

## Gate, re-run by me rather than read from the worker's report

| Gate | `175f894` | `de848ee` |
|---|---|---|
| `npm test` | 376/376 | **390/390** |
| `test:p1-local` | 4/4 | **4/4** |
| `test:p1-server` | 69/69 | **69/69** |
| site suite | 113/113 | **113/113** |
| `build` / `check:tests` / `check:edge` | 0 | **0 / 0 / 0** |
| generated bundle undirtied | clean | **clean** |

The worker's report carries a **named red assertion for each of the 18 causal controls**, shown
failing before passing. That, not the count, is the evidence: 376 green tests and 22 causal controls
were simultaneously true of a build that bricked two different ways.

---

## Correction 1 — the release candidate was not in custody, and my probe hid it

For several hours the **only copy of this fix lived in a `/private/tmp` session clone.** No branch, no
remote, nothing in the durable repo. A tmp cleanup would have destroyed the fix, its 18 red-first
proofs, and the worker's report, leaving a defect register describing a repair that no longer existed.

Worse, I checked and got the wrong answer:

```
git rev-parse de848ee     -> de848ee      # looks like the object exists
git cat-file -e de848ee^{commit} -> fatal: Not a valid object name
```

**`git rev-parse` echoes a well-formed abbreviated SHA back without resolving it.** It is not an
existence check. `git cat-file -e` is. This is precisely the repo's own "measure the artifact, not its
name" rule, and the instrument I reached for first was the one that cannot fail.

Caught by the Fable review, not by me. Fixed: `fix/v015-d040` is now pushed to `origin` and
`origin/fix/v015-d040 == de848ee`.

## Correction 2 — I said "scope clean" about a diff I had not read

I reported the fix as in-scope on the basis of a filename list. `src/listener/delivery-journal.ts`
was **not** in the packet's expected-files list, and it received a **persisted-schema change**: a new
`signalFingerprint` field, plus a `legacyWithoutFingerprint` branch that relaxes the strict key-count
check in the journal parser.

Having now read it, the change is **correct and necessary** — it binds a recovery ACK to the
authoritative immutable signal fields, without which C-1's recovery path could ACK an effect belonging
to a different signal. It also handles journals written before the field existed, so an existing
journal still loads.

**But there is a hazard I had not identified and would not have found by listing filenames:** a
journal written by the *fixed* build is rejected as malformed by the *frozen* build, whose parser
requires exactly the old key set. **Downgrading a listener across this change bricks it on parse** —
the same failure class we are fixing. Exposure is limited to dogfood listeners, since 0.1.4 has no
journal at all. It must be called out to both review arms explicitly rather than left for them to
notice.

The lesson is narrow and unflattering: *in scope* is a property of a diff, not of a file list, and I
asserted it from the list.

## Correction 3 — a silent loss the fix introduces, now recorded

The MAJOR-3 fix maps **any** unmatched `failureCode` to `local_effect_failed`. That is the right trade
— a listener must never die because it cannot name an error — but it means a **systematic classifier
gap becomes invisible**: every unclassifiable failure now reports the same code, so a whole family of
failures could be mislabelled with nothing surfacing. Recorded here because a fix that converts a loud
failure into a quiet one owes the next reader that sentence.

---

## Where the Fable review was wrong, stated for symmetry

It reported `test:p1-server` as never having completed, on the basis of a 10-line log ending at the
`--- p1-server ---` header. It read the log **mid-run**. The suite completed at **69/69** and the file
now ends `=== DB GATES DONE ===`. A snapshot of an in-flight log is a timing artifact, not a result —
the same class of error as the manufactured zeros this repo keeps cataloguing, arriving from the
opposite direction.

## Not established

No live-fire drill has been run: nothing has yet killed a real listener mid-lease and restarted it
past the TTL against a real database. Every instrument used so far is one that **already failed to
catch D-040**. That drill is the only new class of evidence available and it has not happened.
