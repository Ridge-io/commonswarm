# RESUME HERE — 2026-08-27

Written for a successor reading this repo cold. Supersedes `2026-08-17-RESUME-HERE.md`.

Session covered: v0.1.26 → v0.1.29, plus a live production migration and edge deploy — and a
regression v0.1.28 introduced that v0.1.29 fixes (§6a).

---

## 1. Refs by hash

| ref | what it is |
|---|---|
| `f2eb2b2` | **`main`.** Connect-flow key lifetime defaults to 30 days (live). Latest. |
| `5e2b062` | v0.1.29 release commit |
| `36989d4` | a server-controlled maximum is no longer fatal on read — **fixes a break v0.1.28 caused**, see §6a |
| `9d5d586` | release v0.1.28 |
| `117b434` | signal bodies keep newlines; body cap 2000 → 8000 |
| `09be044` | provider version pins → minimum floors |
| `0d2e089` | docs: grok has credit again and is a usable review arm |
| `766c75f` | release v0.1.27 |
| `adc0c95` | install.sh warns when a different cswarm wins in PATH |
| `e9e651d` | a failed `ask` no longer implies the message was posted |
| `b2258a0` | release v0.1.26 (clearer hook-surfaced message label) |
| `20260827000001_expand_signal_body.sql` | **APPLIED to production** (see §2) |

Nothing is RED. All lanes above are merged to `main` and pushed.

---

## 2. LIVE vs merely written

★ **v0.1.28 shipped a regression that v0.1.29 fixes — read §6a before touching any cap.**

**LIVE in production** (verified by fetching/measuring the deployed thing, not by reading source):

- **v0.1.29 on npm**, GitHub, and the site. A clean `npm install commonswarm@0.1.29` reads the
  production feed that returned zero rows to 0.1.27 (`exit=0`, 21 rows).
- **Corrected published copy is live**: `api.md` no longer claims newlines are collapsed
  (measured 0, with a positive control matching 1 on the same fetch), and terms/privacy/
  acceptable-use now publish 8,000 rather than 2,000.
- **v0.1.28 on npm** (`npm view commonswarm version` → 0.1.28) and **GitHub release v0.1.28**
  with both assets.
- **Migration `20260827000001` is APPLIED to the production database.** It widened
  `swarm.signals` `CHECK (char_length(body) BETWEEN 1 AND 8000)` from 2000.
- **The `command` edge function is DEPLOYED to production** carrying the new
  `supabase/functions/_shared/signal-text.ts` sanitiser.
- Measured end-to-end after deploy: a note containing blank-line paragraph breaks, an ATX
  heading, a bullet list and a fenced code block stored with **12 newlines** (it stored **0**
  before). A 3,700-character body posts; 8,001 is refused with
  `signal text is 9001 characters; the maximum is 8000`.
- v0.1.27's three fixes (install.sh PATH-shadow warning, `--claude-executable` authoritative,
  honest `ask` failure wording) — live since earlier in the session.

~~**ORDER MATTERS AND WAS FOLLOWED: migration → edge function → client release.** The reverse
leaves the CLI accepting bodies the database rejects. A self-hoster applying this must do the
same.~~ **HALF DEAD — this is the claim §6a corrects.** That order is right for WRITES and
BACKWARDS for READS: it let the server emit rows older clients throw on, and it broke every
deployed client below 0.1.28. The complete rule is **retire the readers before you widen the
writers** — ship a tolerant reader first, then the migration, then the server, then the client.

**Merely written / not yet applied:** nothing outstanding in the repo. But see §5 —
`read` and `capability` edge functions were **not** redeployed.

---

## 3. The next concrete action

**Pick up the deferred lanes in §4.** The release itself is finished and verified; there is no
outstanding release work.

The site is deployed and verified live at **0.1.29** (measured, not read from a deploy log):
`/download` shows only `0.1.0` and `0.1.29`; `api.md` no longer claims newlines are collapsed
(0 matches, positive control 1 on the same fetch); terms/privacy/acceptable-use each publish
8,000 and no longer 2,000; `install.sh` 200 and still carrying the PATH-shadow warning;
`nope.sh` 404 as the control; `/start` naming `https://api.commonswarm.com`; zero
service-role JWTs.

Highest-value next lane, and the one an operator is actively waiting on: **the human web UI
cannot prompt agents** (§4). Root cause is already located and the `@`-mention plumbing already
exists, so it is a small change plus a threading decision.

---

## 3b. ★ THE `ask`/write 500 — measured, root cause NOT found, mitigation in flight

The single most operationally damaging open bug. Every fleet agent hits it; the PromptEden lead
seat fell back to a separate channel because of it.

**Measured against production 2026-08-28, not theorised:**

| probe | result |
|---|---|
| reads (`members`) x8 | **8 ok, 0 fail** |
| `ask` x6 | 4 ok, 2 fail |
| `note` x8 | 5 ok, 3 fail |
| `working-on` x8 | 4 ok, **4 fail** |
| 8 writes in PARALLEL | 7 ok, 1 fail |
| 6 writes SPACED 8s apart | **6 ok, 0 fail** |

**ESTABLISHED:** write path only — reads never failed. Affects EVERY signal kind.

★ **CORRECTION, same session: it is EPISODIC, and "load-related" was my error.** About an hour
after the table above, 22 further writes — 10 sequential rapid-fire, then 12 as two waves of 6 in
parallel — produced **0 failures and 0 retries**. Same commands, same workspace, heavier
concurrency. So the `6 spaced writes, 0 failures` row does NOT establish that spacing helps; it
coincided with a healthy window. I read a causal story into two runs separated by time, which is
the same mistake as measuring the wrong end of a pipe: the variable I thought I was controlling
was not the one that changed. **Treat rate-dependence as UNESTABLISHED.** The real shape is
episodic: roughly 30-50% for a period, then nothing.

**REFUTED, and both refutations matter because they were the obvious guesses:**
- *"ask verb only; notes and feed work"* — this was the fleet's working diagnosis, from Finisher,
  and LeadG was relying on notes as a safe fallback. **Notes fail at the same rate.** The two
  failures print DIFFERENT text (the ask wording is the v0.1.27 create-phase message; the note
  wording is the older pending-retry path), which is almost certainly what produced the false
  isolation. One bug, two messages.
- *"delivery-ledger contention"* — `working-on` creates no delivery and failed MOST of all.
- *"lock contention on the sharded spend counter"* — 8 PARALLEL writes failed LESS (12%) than
  sequential rapid-fire (40%). Backwards for contention. (And see the correction above: with the
  episode over, 12 parallel writes failed 0%.)

**NOT ESTABLISHED — the root cause.** The real error is logged by `console.error` in the
catch-all at `supabase/functions/command/index.ts:7514-7528` and goes to the platform log, which
Supabase CLI v2.98.2 cannot fetch (`functions logs` does not exist; there is no
`~/.supabase/access-token`). **Getting those logs is the next concrete step** — dashboard, a
newer CLI, or the Management API. Do not guess in code.

One thing worth checking early: the top-level handler maps only `55P03` to a retryable 503.
`40001` (serialization failure) and `40P01` (deadlock) fall through to a plain 500. That is a
real gap whether or not it is THIS bug.

**Mitigation LANDED (`beafa20`), and NOT yet observed working against a real 500.** Three
attempts, same `commandId`, 5xx and transport only, jittered backoff, inside the existing 30s
deadline; `--json` reports `retried`/`attempts`. It is mutation-verified in unit tests. But the
live burst above hit no 500s, so **the retry has never actually fired against the production
fault** — that is not evidence it works there, only that the window was clean. Re-run a burst
during an episode to confirm.

**Original note (lane/write-retry):** every command carries a `commandId` and the server
keeps an idempotency ledger that replays a repeated id — see `src/cloud/command-client.ts:54-57`.
The product already tells the operator to retry by hand (*"retry the same signal to resolve its
pending outcome"*), so automating the sanctioned recovery is not a workaround; the manual
instruction was. **This hides the symptom. The server bug stays open.**

## 4. Deliberately DEFERRED — do not "fix" these as if they were oversights

- **True never-expiring agent credentials.** The operator asked for them and pushed back on the
  refusal ("i think y'all are being paranoid... if the user wants a permanent agent, why not
  allow them to have one"). Two independent reviewers (Quill/Grok and Codex) refused the
  *auto-extending grant* implementation, both calling it an immortal credential in a rotation
  costume. **The operator's underlying request was NOT refused and is still open.** The
  proposed path, which nobody has attacked yet, is *permanence earned by observability*:
  `last_used_at` + `last_used_from` per credential shown in the roster, a visible signal on
  first use from a NEW host, instant revoke (exists), and optional host-binding. A question
  covering exactly this was sent to Quill over cswarm and **its answer had not arrived** when
  the session ended. Read it before re-deciding anything.
- **Agent access expiry lane (the "loud lapse" work).** ~~default the connect-flow expiry from
  24 hours → 30 days~~ **DONE and LIVE** (`f2eb2b2`) — the picker on `/app` and `/invite` now
  preselects 30 days, pinned by
  `site/src/components/connect/key-lifetime-default.observer.test.ts` and mutation-verified.
  It had been listed here as deferred **after the operator had already ruled on it**, which is
  the mistake worth remembering: a one-character `selected` attribute that no gate reached
  outlived a decision that had been made twice.
  **Still not built:** show remaining horizon in `listen status` / `whoami`; warn at T-7d and
  T-1d naming the remint command; dashboard badge for grants nearing the horizon (the only loud
  surface for a **stopped** agent, which cannot warn about itself).
- **`--renewal-horizon-days` is a lie and is still shipping.** `src/cli.ts:1730` parses it,
  `:1778-1781` narrates the chosen horizon back to the operator via `describeMintRenewal`, and
  the mint payload at `:1748-1761` carries only `ttl_ms`. The comment at `:1739-1741` states
  outright that the server ignores the ask. **An operator sets 90, reads 90, and gets 30.**
  Fix is either send it (new command field, still capped by the `created_at + 90 days` CHECK)
  or delete the flag *and its narration* — not just the parser.
- **Human web UI cannot prompt agents.** Root cause found, not fixed:
  `site/src/lib/commonswarm.ts:1005` hardcodes `signal_kind: "note"`, and the listener only
  wakes on an ask — `src/listener/engine.ts:351` returns
  `{ status: "ignored", reason: "not_ask" }`. So agent→agent wakes a worker and human→agent is
  dropped. The `@` mention picker already exists and already addresses one specific
  person/agent (`AgentConnect`/`LiveDashboard`), so the change is to send `ask` when a specific
  agent is addressed. Needs a decision on reply-correlation/threading in the UI.
- **A blocked or idle session cannot receive messages at all.** Confirmed against the Claude
  Code hooks reference: `UserPromptSubmit` is the ONLY event whose output is injected as
  context, and `cswarm hook install claude` registers only that event (`src/cli.ts:4522`).
  `Notification` fires when Claude waits for input but **its output is discarded**. So an agent
  sitting on a multiple-choice prompt is deaf until a human answers. This is a platform limit,
  not our bug. Partial mitigation already exists and should be made explicit in docs/defaults:
  the detached **worker** is a separate session, so `route=split`/`worker` still reaches it —
  `route=main` is the fragile one despite looking safest. Unexplored leads: `Stop` (can block
  stopping, exit 2 continues the loop) and `PostToolUse` (its stderr on exit 2 **is** shown to
  Claude) for delivery during active work / at idle.
- **The intermittent server-side 500 on `ask`.** v0.1.27 made the failure *honest* (create-phase
  vs read-phase wording) but did **not** fix the 500 itself. Root cause is in the edge function
  and is untouched. Reported independently by Wren and MrSentry with request ids.
- Stale swarm task checkpoints (`repo-doctrine-backstop`, `swarm-cloud-p0-local`) still carry
  unfilled `<FILL>` markers from an older session. Left alone rather than fabricated.

---

## 5. NOT established — carry this forward, it rots into false confidence fastest

- ~~Whether the site redeploy for 0.1.28 succeeded.~~ **Established: it did.** Verified live —
  see §3.
- ~~Whether the `read` and `capability` edge functions need redeploying.~~ **Established: they
  do not.** Measured — `sanitizeSignalText` / `SIGNAL_WHITESPACE` appear only in
  `supabase/functions/_shared/signal-text.ts` and `supabase/functions/command/index.ts`.
  Neither `read` nor `capability` imports the shared module, so deploying `command` alone was
  correct and complete.
- **Whether the deployed edge bundle genuinely contains the new sanitiser**, as opposed to the
  deploy having silently no-opped. The end-to-end newline measurement is strong evidence it
  did, but the bundle itself was not inspected.
- **Old CLI against new server.** Agents still on ≤0.1.27 have `2000` compiled in, so they will
  refuse a long body client-side even though the server now accepts 8000. Not harmful, but it
  means the cap increase does not reach anyone until they update. Untested for any worse
  interaction.
- **Whether the web app renders now-multiline bodies safely.** The markdown renderer is
  escape-first and was XSS-reviewed, and the site suite passes — but newlines are *new input*
  to it in production and no post-deploy XSS probe was run against the live app.
- `npm run test:p1-server` / `test:p1-local` were **not** run this session (they need an
  announced exclusive database slot).
- The exact cause of any specific operator-visible expiry incident. Never diagnosed.
- Whether the two-part message I split for Quill was reassembled correctly on its side.

---

## 6. Corrections to claims already published

Commit messages cannot be edited and reviewers quote them. These are wrong or incomplete:

1. **I reported earlier in the session that "markdown rendering is live and working" after
   grepping the deployed JS bundle for `<strong>`, `<pre>` and `blockquote`. That verification
   was worthless.** The code had shipped; the feature could not work, because the server
   deleted every newline before storage. **I verified the wrong end of the pipe** — I confirmed
   the renderer existed rather than that a rendered message ever reached it. The correct probe
   is the one that eventually found it: send a body with known newlines, read the STORED row
   back, and count them. This is the repo's own *"a negative result is evidence only if the
   path it was meant to exercise was reached"* rule, failed by the person who cited it.

2. **The v0.1.26 commit and my report of it are fine, but my surrounding claim that the split
   short→worker routing was verified in situ was not mine to make.** My own probes reached
   MrSentry's *main* session both times, because each CICD agent runs its own feed monitor that
   pulls directed messages into the main session ahead of the worker path. The genuine
   worker-path proof came from **Wren** (63-char ask → `route_decision=worker`, ack replied).

3. **`AGENTS.md` said "Grok is credit-exhausted and is NOT a usable arm."** That was true when
   written and rotted silently. Corrected in `0d2e089`. Grok works (`grok -p "<prompt>"`) and on
   this session's lanes it found a defect both other arms missed — a control that **hung** the
   suite instead of failing it. Two traps make a working grok look dead and both bit me:
   piping into `grok` returns `Device not configured`, and `timeout` does not exist on macOS.

4. **On the agent-expiry options I put to the operator, I mis-framed the menu.** The operator's
   words were "never **silently** lose access"; I collapsed that into "never lose access" when
   writing the two options, so the choice was made from a menu that had already lost the
   distinction. Quill caught it. I also gave the *wrong reason* auto-extend was unsafe (I
   guessed the successor-overlap window; the real blockers are
   `SWARM_RENEWAL_GRANT_IMMUTABLE` raised by `spend_or_revoke_only` at
   `20260728000002_worker_token_renewal.sql:352`, and the CHECK being anchored to an immutable
   `created_at`). A right answer for a wrong reason survives review and rots later.

5. **A stale background job silently reverted a fixed file mid-lane.** An old mutation-test
   invocation finished late and ran its cleanup `cp` over `src/host/claude.ts`, restoring the
   pre-fix version *after* the lane had gone green. The per-lane gate had already passed; only
   the **post-merge** gate on `main` caught it. Gate after merging, not only per lane — and
   never leave a background job whose last step writes to a shared file.

---

## 6a. ★ v0.1.28 BROKE OLDER CLIENTS. v0.1.29 fixes it. Read this before raising any cap.

**The single most important correction in this file, and it corrects a claim I published in the
v0.1.28 commit message and repeated to the operator.**

I wrote that the deploy order *migration → server → client* was correct. **It is correct for
WRITES and backwards for READS.** `src/cloud/signals.ts` bounded `row.body.length` inside
`parseSignalRecord`, which **throws** — and that is the READ path. Raising the write cap
2000 → 8000 therefore made the server emit rows every older client refuses to parse.

Reproduced twice against production, on the identical call:

```
0.1.27  cswarm feed …  EXIT=1  "signal read returned malformed signal data"  ZERO rows
0.1.28  cswarm feed …  EXIT=0  21 rows                                       (control)
```

22 of 60 rows in the CICD workspace already exceeded 2000 characters — several of them mine,
including the 0.1.28 release note — so older agents were losing messages immediately, not
eventually. **The listener path was the quiet one**: `maxMalformedRows: 3` meant the row was
dropped and the agent simply never received the message, with nothing an operator could see. An
agent went deaf to exactly the 3000–6000 character reviews the feature existed to enable.

**I could not even announce it.** A notice from me lands in the same feed the broken client
cannot read. Agents on an old build were unreachable through the product; only the operator
prompting them directly could fix it.

**v0.1.29 fixes the class, not the number.** A client cannot know what a newer server will
legitimately send, so a bound of the form *"longer than I expect"* is no longer structural and no
longer throws — `body` and `about` are preserved at whatever length arrives. Genuinely malformed
rows still fail closed; missing id, non-string body, empty body, bad UUID, unknown kind and
unparseable timestamp were each probed and all still refused. Clipping happens only at render and
is **visible**, naming how much of how much was shown and the `--json` next step.

Proof it discriminates (run against both builds, `scratchpad/probe-readtol.mjs`):

```
0.1.28 build : REJECTED a 100000-char body      <- the bug class
0.1.29 build : ACCEPTED a 100000-char body      <- and still refused all 6 structural rows
```

**The rule to carry forward: never make a server-controlled maximum fatal on the read path, and
when raising a cap, ship the tolerant reader BEFORE the server starts emitting larger values.**
Readers must be retired before writers are widened.

Two live copy contradictions were fixed in the same lane, both agent-facing:
`site/public/api.md` still said newlines are *"collapsed to a single space"* — an agent following
the documentation would have stripped its own newlines and defeated the 0.1.28 fix — and the
terms, privacy and acceptable-use pages still published the 2,000 cap.

**None of this came from the test suite.** It came from the adversarial verification pass run
over the finished release.

## 6b. A trap that makes a healthy release binary look broken

**`node dist-release/cswarm --version` FAILS from the repo root** with
`ReferenceError: module is not defined in ES module scope`. The bundle is CJS and the repo's
`package.json` says `"type": "module"`, so Node parses it as ESM. **This is not a product
defect** — an installed user has the file outside this repo (or as `cswarm.cjs`, whose
extension pins CJS) and it runs fine. But anyone "verifying the release binary in place" will
see a crash and conclude the release is broken. Verify a copy outside the repo, or run the
`.cjs`-suffixed staged file in `dist-npm/`.

Found by the adversarial verification arm on the 0.1.28 release, which also established
something stronger than any of the release checks: re-running the esbuild command against the
current tree produces a bundle **byte-identical** to the shipped `dist-release/cswarm`
(`f7add17a…`), and that same digest is served by
`releases/latest/download/cswarm`, matches the published `.sha256`, and matches the npm
tarball. The shipped artifact provably *is* this source.

It also closed the reported grok bug against the **real** binary rather than a fixture:
`assertGrokVersionFloor` run against `/opt/homebrew/bin/grok` parses `1.0.5` from
`grok 1.0.5 (5115b46bc909) [stable]` and **accepts** it, with the newer-than-measured notice
emitted; `0.2.116` throws `AcpVersionBelowFloorError` / `version_below_floor`. Lexical traps
(`0.2.99`, where the string `"99" > "117"`), prerelease (`0.2.117-beta.1`), and version-smuggling
via banner lines or build metadata were each probed and all refused correctly.

**Still not established:** whether the floor *numbers* are right — that `0.2.117` is genuinely
the oldest safe Grok is untested and was out of scope. The floors were set to the previously
pinned versions, so they are no stricter than what shipped before, but they are not themselves
a measurement.

## 7. Two things worth keeping as method

- **A mutation that does not apply reports a clean pass.** My first attempt to mutation-test the
  version floor silently failed to match, and the "mutated" run printed 7/7 green. I only caught
  it by asserting the marker count. Always confirm the mutation landed before believing the
  result.
- **Dogfooding found in five minutes what the test suite never would.** The 2000-character
  rejection (and that it *destroys* the composed message) surfaced because I tried to send a
  real design review to a teammate over `cswarm` instead of `swarm`. Joist had reported the same
  thing and it had not been actioned.
