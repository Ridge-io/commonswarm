# Lead handoff — Lead6 (claude) → Lead7 (codex)

**Written:** 2026-07-29, ~18:15 · **Reason:** the Claude account hit its monthly spend limit, so
the claude-family Lead cannot continue. The mission does not stop for a billing condition.

Read this file, then `docs/org/DEFECT-REGISTER.md` from **D-018 onward** (today's entries), then
`docs/design/2026-07-29-WORKSPACE-FIRST-DASHBOARD.md` (the operator's own binding ruling). That is
the whole context. `AGENTS.md` is the standing brief and is current as of `abf3de7`.

---

## 1. The mission, verbatim from the operator

> A **stranger** — not the operator, not a friend — can **find, understand, install, sign up for,
> and use** CommonSwarm. Free tier only, no billing.

And the second half, which is what the last several hours have been about:

> Every surface a stranger touches must be **consumer-shaped** — warm, plain, obvious — and not
> **developer-shaped**. Every surface: email templates, website, URLs, OG metadata, marketing copy,
> calls to action, buttons, instructions, illustrations. *"There's no reason people who are not
> developers shouldn't be able to use an agent-to-agent communication app."*

Non-negotiable operator constraints, quoted:

- Legal posture: *"we're promising nothing and guaranteeing nothing… no liability… total use at your
  own risk… as friendly as possible to US, the company."* Entity is **Yulan Ventures, LLC**, a
  Washington LLC at **1200 W 6th St, Ste 600-188, Austin, TX 78703**. DMCA agent **Thomas
  Langridge** at that address. `legal@` and `security@commonswarm.com` both deliver (verified).
- *"Humans prefer convenience over security constraints."* Reduce ceremony that only adds friction.
- **Never** paste a credential, invite link, or token into the swarm bus. Auth-blocked is a valid
  terminal state — report and stop.
- Review by **model inversion**, not by humans: *"my rule is not to review things by a human but to
  rely on model-inversion for review."*
- Leave in TODO, do not attempt: DMCA registration, attorney review, USPTO clearance.

---

## 2. What is live in production right now

All verified against the deployed site with paired positive/absence greps, not against source.

| Surface | State |
|---|---|
| `commonswarm.com` | live, Cloudflare DNS, apex+www 200, cert to 26 Oct 2026 |
| Self-serve signup | **OPEN** — `SWARM_SELF_SERVE=1` since 2026-07-28, free, 3 workspaces, no card |
| Installer | `curl -fsSL https://commonswarm.com/install.sh \| sh` → cswarm 0.1.1, public repo |
| `/start` | pure two-step on-ramp (merged `0ed02a9`) — no stepper, no dead ends |
| `/download` | real command, correct version, prerequisites before paste |
| Legal pages | Terms/Privacy/AUP — false archiving + member-removal remedies deleted |
| Email | **all 13 Supabase templates branded in production; custom SMTP active at 30/hour** from `CommonSwarm <hello@commonswarm.com>` |
| OG card | per-route metadata; card shows the real installer command; served SHA verified |
| Docs/briefs | AGENTS.md, README, SITE-BRIEF corrected — they no longer instruct agents to write the closed-signup world |

~~**Resend DKIM went VERIFIED at ~18:05. This unblocks custom SMTP, which lifts the 2/hour
magic-link cap — currently the tightest limit on a stranger signing up.**~~ **Dead as an
open blocker:** Kestrel completed the cutover. Resend is verified, Cloudflare routes
`hello@`, `legal@`, and `security@`, Supabase reports the exact CommonSwarm sender and
`rate_limit_email_sent=30`, and a production `/start` request reached a Resend delivered
record. Inbox-visible receipt and the cold-browser magic-link return leg remain unestablished.

---

## 3. Two branches are frozen and should merge FIRST

Both are complete, green, grok-approved, and were held only because their authors could not obtain
a claude verdict. ~~**I ruled that unnecessary in D-032 (`abf3de7`): a grok verdict alone satisfies
inversion for codex-authored work**, because the principle is *different family*, not *those two
families*. Conditions: the DONE says grok-alone and why; everything else unchanged; retroactive
claude read when capacity returns.~~ **Dead before either branch merged. Operator ruling D-033
supersedes it: every swarm mate now runs BOTH Grok and AGY/Gemini exact-SHA reviews instead of
Claude.** The existing Grok verdict is one arm; each frozen branch needs an AGY/Gemini verdict
before merge. A changed SHA voids both arms.

1. **L7A — the workspace-first dashboard** (Lumen), `fd7b7733f3126483eb97cc717dde85899828a992`.
   This is the operator's personally-requested redesign. Grok PASS after four adversarial rounds.
   Site build 7/7, site observers 6/6, root 79/79, signed-browser real feed + pagination + mutation
   all passed.
2. **L6 — internal docs** (Mica), `eae52d5fbf01f265500b9e6708c553cfaa1da56c`. Root-cause fix for the
   stale-state class. Grok APPROVE after two REQUEST_CHANGES rounds folded. Observer green (17
   live-stale absent / 11 dead retained), two mutation proofs, npm test 79/79.

**My merge procedure, which caught real problems today — follow it:**

```sh
git fetch origin --quiet
git branch -f _m origin/<branch> && git checkout -q _m && git rebase -q main
FILES=$(git diff --name-only main...origin/<branch> | tr '\n' ' ')
git diff <REVIEWED_SHA> HEAD -- $FILES | wc -l     # MUST be 0 — content identity after rebase
git checkout -q main && git merge --ff-only _m && git branch -D _m
# then run the gates YOURSELF, reading exit codes, not greps
```

Deploy (every trap here cost a deploy — `AGENTS.md` documents all five):

```sh
cd site && rm -rf dist && npm run build
cp -r .vercel dist/.vercel        # LOAD-BEARING: without it you deploy to a NEW project called "dist"
vercel deploy dist --prod --yes --scope ridgedotio
# then verify the DEPLOYED page with a positive control on the same invocation
```

---

## 4. The queue, in priority order

1. ~~**Configure custom SMTP now that DKIM is verified.** Add the `hello@` Cloudflare route,
   apply the guarded full SMTP block, and raise `rate_limit_email_sent` above 2/hour.~~
   **DONE by Kestrel.** The three routes are Active, the guarded apply succeeded, Management
   GET reports the exact sender/host/port/user and rate 30, and Resend recorded a production
   message delivered. **Still open:** inbox-visible receipt, inbound `hello@` forwarding, and
   the cold-browser magic-link return leg.
2. **D-031 — the local suite trips a global latching spend breaker** (Cinder, in progress).
   `SPEND_CEILINGS.workspace_create = 100/hour`, latching until `swarm.reset_spend_breaker`. The
   suite burns ~30 creations/run, so it self-poisons. **Operator-visible implication I flagged and
   did not change: production runs the same latch — a launch spike over 100 creations/hour pauses
   signup globally until someone resets it.** That belongs on the launch checklist and the ceiling
   is an operator ruling, not a fleet fix.
3. **Cinder's chartered queue after D-031:** unguarded direct-fetch cold-start sites (the `:3284`
   class), splitting `local-integration.test.ts` out of `test:p1-cli` so 43 pure tests stop needing
   a DB slot (D-030), then **hosted `remove_member` exposure** — the protocol command exists but
   neither the edge function nor the CLI expose it, so Privacy's removal promise had to be deleted.
   A Slack-channel product needs it.
4. **Dana's cold-browser stranger walkthrough** was dispatched against the freshly deployed site and
   has not reported. Chase it — fresh-eyes QA on the real flow is the closest thing to the operator's
   own test.
5. ~~**Retroactive claude reads** on today's merges once capacity returns (D-032 condition 3).~~
   **Dead under D-033.** Claude is replaced by the Grok + AGY/Gemini pair; do not wait for or
   claim a Claude verdict.

---

## 5. How to run the fleet

**Seats and families — verify with `swarm members`, never assume. I got this wrong twice in one
day, in opposite directions (D-029 and its correction).**

- claude: Lead6 (retiring), Quarry — **both spend-blocked**
- openai/codex: Mica, Kestrel, Juniper, Lumen, Nori, Tundra
- a2a, family UNKNOWN so cannot review: Anvil, Dana

**Anvil never answered a status check with a deadline.** L6 was reassigned off it to Mica. Do not
depend on Anvil for anything on the critical path.

**The exclusive DB slot protocol, which binds the Lead too (D-028 — I broke it and contaminated
three measurements):** `test:p1-server`, `test:p1-cli`, and `db:*` all require an announced slot.
Announce start, announce finish **with the numbers** — a release without its measurement is a
window paid for and returned empty. Never compose the finish broadcast into the same command as the
run (D-025's author did, and it broadcast success for a failed run).

**Noise discipline:** seats fix in-lane findings without reporting them; a FINDING is for
out-of-lane defects or rulings they cannot make. One writer per lane, lanes file-disjoint, each in
its own worktree, and merging is the Lead's alone.

**What makes a DONE acceptable:** branch + exact SHA + `git ls-remote` line, the observer's name,
the **verbatim red** from a mutation at a **production call site**, gate counts read from real
output, adversarial verdicts bound to that SHA, and everything REJECTED with its evidence. Plus an
explicit **NOT ESTABLISHED** section. Today's best reports all had one.

---

## 6. The doctrine that actually earned its keep today

Eleven defect-register entries were written today (D-022…D-032). The pattern behind most of them:

- **Measure the artifact, not its name.** Resolve the path, URL, ref, SHA before trusting a result.
- **Positive control on the same invocation.** A probe that cannot fail is not a probe. I recorded
  **seven** instrument failures of my own today; every one was a green or a zero that meant nothing.
  The most recent: a grep for `^# pass` against output that prints `ℹ pass`, and a "stale copy"
  hit that turned out to be `placeholder="you@company.com"` on an email input.
- **A claim wider than its mechanism is the house defect.** It appeared four separate times *inside
  instruments*: the typecheck gate that missed `.tsx`, the readiness gate that erased refusals, the
  observers filed where no script reached them, and the review rule that named two families where
  the principle needed one. All four were caught before merge.
- **Corrections go in the artifact, not in a message.** Keep the superseded line, marked dead. A
  correction in chat never reaches whoever pulls the repo tomorrow.
- **State what you did NOT establish.** Cinder's *"I reasoned from a number I had measured to a
  mechanism I had not"* prevented a fix that would have fixed nothing.
- **Pushed ≠ landed ≠ applied.** Say which one you mean.

The fleet is in good shape and self-correcting: today three seats caught their own errors publicly
within a minute, two reviewers found real defects in already-merged work, and three refused to claim
a verdict they could not obtain. Trust that behaviour and keep asking for it.
