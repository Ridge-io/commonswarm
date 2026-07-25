# P3-1 signal plane — first real use, 2026-07-25

**Who:** Lead6, as `tom@ridge.io`, on the mini, against hosted, immediately after G5 passed.
**What:** posted a `note`, a `working-on` and an `ask` about work genuinely in flight, then read them
back. Not a test script — the signals describe the spawn-hang investigation that was running at the
time.

**Status of the plane:** G5 **PASS**. Post-then-read returned the exact row, six fields matching
(`id`, `workspace_id`, `about`, `body`, `kind`, `from`). This also closes the overclaim from Phase M:
the `authenticated` GRANT is now *measured*, not assumed — the read path returns rows to a logged-in
human, which is the exact failure mode that would otherwise have surfaced as "no signals" rather than
"permission denied".

---

## ★ F1 — THE FEED SHOWS RAW UUIDs AND RAW TIMESTAMPS, WHILE `status` IN THE SAME CLI DOES NEITHER

This is the finding. It is not a missing capability; **it is an inconsistency inside one binary.**

What `coswarm feed` renders:
```
- [ask] member d37e2ff2-2efb-4bdc-b8fb-176ce4bfccbc at 2026-07-25T20:27:33.254463+00:00: "..."
```
What `coswarm status` renders, same session, same identity, seconds apart:
```
- Ridgeio (d37e2ff2-2efb-4bdc-b8fb-176ce4bfccbc) — owner — you
- Tom Langridge (919ce195-4e19-4c89-852b-8f09a4b556d9) — member
  ... hosted-dogfood-0e28313d — done — expired 2d ago
```
`status` already **resolves the UUID to a display name**, already **marks which one is you**, and
already **renders relative time**. The feed does none of the three.

**Why it matters more than it looks:** I could not tell my own signal was mine. In this workspace
there are two members and two agents; with a real collaborator you would be memorising UUIDs to read
your own feed. **The feed is the primary read surface of the entire product** — it is what §1d means
by "coswarm holds the intentions" — and it is the surface that did not get §1c's
comprehension-before-commitment treatment, while a secondary command did.

The data is demonstrably available: `status` joins it from the same tenancy-gated views.

**Fix shape:** resolve `from` → display name + `(you)` marker, and render `created_at` relatively, in
`feed` and `inbox`. Keep the principal id available under `--json`, since "who said it is an auditable
principal, not a Slack display name" is a *collapse-test* property and must not be lost — but a human
reading a feed should never see a bare UUID.

## ★ F2 — `until` IS INVISIBLE IN THE FEED, AND `until` IS THE WHOLE MODEL

The brief's §1.2 is emphatic: *"`until` IS the lifecycle — this is why there is no close verb."* I
posted `--until 24h` on the `working-on`. **The feed does not show it.** So the mechanism that
replaces a state machine — the single design decision that lets the plane stay simple — is not
visible to the person reading the plane.

A reader cannot distinguish "Tom is working on this for the next hour" from "Tom said this three
weeks ago and it expires tomorrow". Both render identically.

**Fix shape:** render the horizon inline (`for 24h` / `expires in 3h` / `(expired)`). G7 already
requires `(expired)` for stale rows under `--include-stale`, so half the rendering exists; the
non-stale half is missing.

## ★ F3 — CROSS-DEVICE IS NOT AWKWARD, IT IS ABSENT

The product's thesis (§1d) is cross-machine, cross-swarm awareness. Measured on the second machine
(the laptop, same human, same tailnet):

| check | result |
|---|---|
| `coswarm` on PATH | **not found** |
| repo `dist/cli.js` present | yes, but **built before the P3-1 land** |
| signal verbs in that build | **0** — `working-on`/`feed` absent entirely |
| `~/.coswarm/credentials.d/` | **empty** — no login |
| `node` on the ssh PATH | **not found** |

So to read *my own signals* on *my own second machine* I would have to: get node onto the
non-interactive PATH, rebuild the CLI, then complete a full browser OAuth flow again.

This is §1c's *"a lot of steps… I didn't really know what I was doing or why"* — but one level worse,
because it is not a step count, **it is that the product is not present on the second machine at
all.** Whatever the distribution story is (the P2-connect-UX agent-skill layer is the obvious
candidate), it is load-bearing for the thesis and does not exist yet.

## ★ F4 — A SUPERSEDED PIN IN SUCCESSION-PLAN.md, FOUND BY POSTING RATHER THAN BY READING

`note` and `ask` both came back with an `until` I never set. §1d's schema line said `until` is
`working-on` **ONLY**. The brief's §1.2 says **every kind has one**, with defaults 24h/7d/30d, and
`supabase/functions/command/index.ts:292` matches the brief.

**The code was right and the succession plan was stale.** Two normative statements of one fact, which
then disagreed — §0e.5 precisely. Fixed: the pin now *references* the brief instead of restating it.

★ **Two review rounds and a fan-out consistency audit did not catch this. Ten minutes of posting real
signals did.** Each document was internally consistent; only an artifact produced by *running* the
code showed they disagreed with each other.

---

## What is genuinely good, stated because a findings list that only finds is not calibrated

- **★ CORRECTED — THIS ENTRY WAS WRONG, AND THE ERROR IS THE SAME CLASS THE REST OF THIS DOCUMENT IS
  ABOUT.** The original text praised *"Signal shared. It is immutable, tenancy-scoped, and will
  quietly expire at its horizon."* as the best writing in the product and as proof the write path had
  received §1c's comprehension treatment.
  **That sentence lives only in the `--json` branch** (`src/cli.ts:1354` gates it; the string is at
  `:1358`). The human branch at `:1371` prints `Signal shared.` and a rendered feed row — nothing
  more. It has never been otherwise; the same shape exists at `c87a653`, the first signals commit.
  **★ AND THE REASON I MISSED IT: EVERY POST I MADE DURING THIS SESSION USED `--json`.** I never
  executed the human write path, then wrote a finding about human comprehension from machine output.
  That is *verifying the right property of the wrong object* — the dominant error of the day —
  committed inside the document that names it.
  **★ SO F1's HEADLINE IS NARROWER THAN STATED.** It is not "the write path got the §1c treatment and
  the read path did not." It is: **the write path got it IN JSON ONLY. The plain human write path
  never had it either.** Found by Pitch on its first task, with the command attached.
  *(What survives: the sentence itself is good writing, and it is the model for what the human
  surface should say. It just is not what a human is shown.)*
- **`--about <pr-url>` is natural, not ceremony.** Typing a real GitHub URL as the subject felt
  obvious and made the signal actionable rather than chatty. The decision to keep `about` an opaque
  string rather than a parsed type costs nothing in use.
- **The three-kind enum held.** Writing real signals, I never wanted a fourth kind. `working-on` for
  intent, `note` for a heads-up, `ask` when I needed an answer — the tone went in the body, exactly as
  pinned.

## §0g's three questions, answered from use rather than from review

1. **Is `working-on` the right verb?** Yes. It read naturally and I reached for it without thinking.
2. **Does a 24h horizon feel right or absurd?** The *default* is right. But the question is
   unanswerable from the UI as shipped, because **F2 means you cannot see the horizon at all.** Fix
   F2 before asking anyone to judge the number.
3. **Is `--about <pr-url>` natural or ceremony?** Natural, and the most valuable optional flag.

## Recommended order

1. **F1** — name + relative time in `feed`/`inbox`. Small, and it is the difference between a feed a
   human can read and one they cannot.
2. **F2** — render the horizon. Without it the central design decision is invisible.
3. **F3** — distribution. Large, and it is the thesis. Belongs with the P2-connect-UX agent-skill
   layer, not with signals.

F1 and F2 are the same shape: **the write path got the §1c treatment and the read path did not.**
