# Defect register

The single source of truth for findings. **Chat is not a handover** — a defect that exists
only in a conversation is a defect nobody will act on tomorrow. Every entry names its
evidence, and every closed entry names the artefact that proves it closed.

Adopted 2026-07-29 alongside the Advisor → Operator → Executor model (`docs/org/OPERATING-MODEL.md`).

**Status values:** `OPEN` · `IN REVIEW` (bound to a SHA) · `FIXED` (**merged to `main`**, evidence
attached) · `DEFERRED` (a ruling was made to not act yet, with the reason) · `WONTFIX` (with the
ruling) · `DISPROVEN` (the finding was wrong — kept, not deleted).

Parenthetical qualifiers — `(tooling)`, `(pattern)` — describe the KIND of entry and never the
status. `FIXED` means merged to `main` and nothing else; a fix that exists only on a branch is
`IN REVIEW`, however finished it looks.

---

## D-001 — Published binary contained no renewal code · FIXED

**Found:** 2026-07-29, by dogfooding — a 120s credential was minted in production, used at
105s, and no successor was ever written to the agent credential store.

`src/cloud/renewal.ts` does not exist at `3488472`, the commit `v0.0.1` was built from. The
release was 17 commits behind `main`. Every stranger who installed got a client whose agent
credential expires after an hour with no recovery — the exact failure §2.3 exists to prevent.
All the renewal work was on `main`, correct, tested, and unreachable by anyone who installed.

**Evidence:** grep of the shipped binary for five renewal symbols returned 0 for all five;
the same probe against a fresh build returned 2/1/2/4/1.

**Closed by:** `v0.1.0`, commit `43db30e`. Verified by installing from the live site and
re-running the same probe.

**Class:** *pushed ≠ landed ≠ applied.* The register exists partly because of this one.

---

## D-002 — CLI told every operator renewal was unavailable while it worked · FIXED

**Found:** 2026-07-29, immediately after D-001, on the first mint with a client new enough to
say anything about renewal.

`cswarm token mint` sent a `create_renewal_grant` command first. The reducer has never
implemented that kind — `git grep create_renewal_grant src/protocol` returns nothing — so it
was refused `invalid_request` on every deployment that has ever existed. The refusal was
caught and reported as advice: *"this deployment did not open a renewal window … it will not
renew itself — re-issue one by hand when it expires."* False on every mint. The server creates
the grant atomically inside the mint transaction.

**Evidence:** production mint printed the warning; the next agent call renewed successfully
against a grant the server had already created.

**Closed by:** `v0.1.1`, commit `8c5dc23`. Message now keys off the stated expiry alone.

**Class:** wrong advice is worse than no advice — the remedy it recommended was hand-rotation.

---

## D-003 — Three renewal tests could pass with the property absent · IN REVIEW

**Found:** 2026-07-29, by cross-model adversarial review of the renewal work.

1. The one-successor CAS probe accepted `23505 OR 55000`. `55000` is the successor fence's
   catch-all for ~18 named refusals, so a fixture drift could satisfy the assertion with the
   CAS index missing entirely.
2. Both write-once triggers on `first_used_at` had zero coverage — either could be dropped and
   the suite stayed green.
3. Nothing searched the database for the raw successor credential; the only guard was an HTTP
   assertion that the replay body omits `agent_token`.

**Status: STALLED, not in flight.** Branch `l6/renewal-test-gaps`, SHA
`505eee8cbcf26c1b9363edd8ff180e66e1189cde`, pushed and confirmed with `git ls-remote`. **Not
merged.**

★ The reviewer assigned to it **died** — see D-014: a `codex exec` one-shot that produced zero
bytes over 40 minutes at 0.07s CPU, killed. This entry read as awaiting a verdict for some time
after the reviewer no longer existed. No reviewer is currently assigned; the reroute to grok was
stated as an intention and never dispatched. Whoever picks this up must re-dispatch, not wait.

---

## D-004 — Expired agent credential is reported as revoked · FIXED

**Found:** 2026-07-29, while testing renewal.

An expired credential fails authentication with 401 before renewal is decided, so
`src/cloud/renewal.ts` falls into the generic 401/403 branch and tells the operator *"This
agent credential is no longer accepted … revoking a credential, a device, or a person's
membership revokes everything descended from it. Ask whoever runs this workspace what was
revoked and why."*

Nothing was revoked. The credential timed out. The operator is sent hunting for a revocation
that does not exist, and the file already has a correct, distinct message for expiry —
reachable only when the server decides `predecessor_expired`, which it cannot do once auth has
already failed.

**Required shape of fix:** the client knows its own `expiresAt` and already has an `expired()`
predicate. At the 401/403 branch, if the credential is past its own expiry, report expiry
rather than revocation. Do not guess when `expiresAt` is null — the generic message is correct
there.

**Closed by `ebedf997ded5f63a105a2578aa4c0a5dde62f3ed`, merged to `main` 2026-07-29** — the
first change through the full model. History below is kept because the review round is the
evidence.

**First verdict: REQUEST CHANGES at `8ca72df`** (Cinder authored, Mica reviewed 2026-07-29).

Fix and wording approved. Rejected on the observer: all 7 tests call `requestSuccessor`
directly and never construct an `AgentCredentialSession`, so the `expiresAt` handoff at
`src/cloud/renewal.ts:788` — the line that connects the fix to production — is unobserved.

**Verified by the advisor rather than relayed.** Isolated worktree at `8ca72df`, deleted line
788 only, `tsc` clean:

```
mutated (handoff deleted)   ->  tests 7, pass 7, fail 0
grep 'AgentCredentialSession|bearer(' in the test file  ->  0
```

So the entire fix can be disconnected from production and the suite stays green.

★ **THIS IS THE FIRST FINDING THE OPERATING MODEL PAID FOR, AND IT CAUGHT THE ADVISOR.** I
re-executed Cinder's mutation independently, got 4-of-7 red, and recorded "verified". But I
mutated the MESSAGE CONSTANT — the thing the tests already cover. I proved the observer works
for what it observes and never asked whether it observes the production path. Claude verifying
Claude, missing it; codex catching it. That is §2 of `OPERATING-MODEL.md` doing exactly the job
it was adopted for, one day after adoption, and it is worth more as evidence than the defect
it found.

**Prescription (binding):** a session-level observer — `AgentCredentialSession.bearer()` with
an expired presented credential, a writable stub store, and a 401/403 fetcher — asserting
`predecessor_expired_local` and the expiry wording. Acceptance is the mutation, not the pass:
delete the :788 handoff, show that observer red, restore, show green.

---

## D-005 — `SWARM_CAPABILITY_URLS` cannot be verified from outside · DEFERRED

The §7 capability endpoint answers `404` both when the feature is off and when a presented
token is bad — the no-enumeration rule working as intended. Flipping the gate therefore
produces no externally observable change, so turning it on would be a switch whose effect
cannot be measured.

**Ruling:** stays dark until it can be verified from inside a real session, during dogfood.
This is a deliberate deferral, recorded so it is not mistaken for an oversight.

---

## D-006 — Stale workspace membership and unenforced archiving · OPEN

**Found:** 2026-07-29 by Dana, on the laptop, during the first two-machine dogfood run.

`cswarm workspaces` lists a "Dogfood Workspace" the user was already a member of, and the CLI
states *"project archive enforcement is not available yet; archived projects remain selectable
while your membership is live."* Both are honest, and both mean a real user's workspace list
accumulates things they cannot get rid of.

**RULED 2026-07-29, and the entry's original premise was wrong.** It conflated two unrelated
defects:

- **The archive notice is wording** — split out, ruled, and **MERGED to `main` at `8da566f`**
  after a REQUEST CHANGES round (the drift test observed the renderer, never either JSON
  payload — D-018 instance 4). Advisor-verified: drifting the builder's message turns exactly
  the two payload observers red, 11 → 9/11, restored 11/11. Patch-id `848c177d…` identical
  across Cinder's head, Mica's approved SHA and the merged commit. The CLI explained the system's state to someone asking about their own
  list and gave them no action.
- **The list accumulating is a MISSING SURFACE, not archiving.** `remove_member` exists as a
  protocol command kind (`src/protocol/workspace-commands.ts`) and is **not exposed in the
  CLI** — `grep remove_member src/cli.ts` returns nothing. That is almost certainly the real
  complaint: no surface can prune a membership.

As originally written this entry would send someone to fix archiving when the actual complaint
is membership. The archive-enforcement half moved to **D-016**, and its priority went DOWN
rather than up once Cinder found that nothing anywhere sets `archived_at`.

---

## D-007 — Namecheap dropped the root SPF while adding unrelated TXT records · FIXED

**Found:** 2026-07-29 by Forge, adding the three Resend records at Namecheap. Forge stopped
rather than continuing, which is the correct behaviour and is why this was caught at all.

Two of the three records were added successfully (`resend._domainkey` DKIM, `send` SPF).
Neither touches the root host. **After the zone rebuilt, the root SPF was gone.**

`v=spf1 include:spf.efwd.registrar-servers.com ~all` had been on the root host. It is now
absent from every resolver tested — `1.1.1.1`, `8.8.8.8`, `9.9.9.9`, and both authoritative
nameservers `dns1`/`dns2.registrar-servers.com`. Independently re-measured by the advisor
before acting on the report; not a caching artefact.

**Nobody edited it.** Forge's report and the advisor's re-measurement agree that no existing
row was modified or removed. The likely mechanism is that Namecheap AUTO-GENERATES that SPF as
part of the Email Forwarding feature rather than storing it as a user row, so adding TXT
records triggered a zone rebuild that did not re-emit it.

**Impact, stated precisely because the scary reading is the wrong one:**

- Inbound forwarding is NOT broken. The root MX is fully intact (all five `eforward` hosts),
  and MX governs receiving. `legal@commonswarm.com` and `security@commonswarm.com` still
  reach their destination.
- What was lost is outbound AUTHORISATION. The SPF authorised Namecheap's servers to re-send
  mail as `commonswarm.com` when forwarding. Receivers now see SPF **`none`** — which is
  neutral, not a failure. Forwarded mail is likelier to be filtered as spam.

So: a real regression on addresses named in the published Terms and Privacy Policy, worth
fixing promptly, but not an outage and not blocking anything.

★ **SUPERSEDED — DO NOT EDIT NAMECHEAP.** `commonswarm.com` is now authoritative at Cloudflare
(`dig +short NS commonswarm.com` → `chelsea.ns.cloudflare.com`, `ezra.ns.cloudflare.com`), per
the D-008 option-B migration. Editing a Namecheap record would change nothing and would read as
a completed fix — the exact failure this register keeps recording. **This defect was closed by
the migration**, which put the SPF back as a Cloudflare-managed record:
`v=spf1 include:_spf.mx.cloudflare.net ~all`, verified serving from both authoritative
nameservers. The instruction below is retained only as the record of what the fix WAS while the
zone was still at Namecheap.

**Superseded required shape of fix:** re-add ONE TXT record on host `@` with exactly
`v=spf1 include:spf.efwd.registrar-servers.com ~all`. Adding it explicitly makes it a user row
rather than a generated one, which should survive the next rebuild. Do **not** add
`include:amazonses.com` to it — Resend sends from the `send` subdomain, which carries its own
SPF, and a second SPF record on one host is invalid and would break both.

---

## D-008 — Namecheap cannot host the Resend return-path MX alongside Email Forwarding · FIXED

**Found:** same session as D-007.

Namecheap does not offer the MX type in Host Records while Mail Settings is set to Email
Forwarding. Its documented path is Mail Settings → Custom MX, which replaces the forwarding
configuration wholesale. Forge declined to take it, correctly: that would have traded the
legal contact addresses for a mail-sending feature.

Resend reports all three records `pending` and the domain unverified, so the missing
return-path MX blocks magic-link email at scale. Nothing else is blocked — GitHub sign-in
works, and email sign-in still functions at the built-in 2/hour cap.

**Two candidate resolutions, needing an operator ruling rather than an agent's judgement:**

- **A — Custom MX on Namecheap.** Re-add the five `eforward` MX rows manually plus the `send`
  MX. **Unresolved risk:** the forwarding RULES (`legal@` → a real inbox) are configured in the
  Email Forwarding section, and it is not established whether they keep working once Mail
  Settings is switched to Custom MX, even with identical MX targets. If they do not, this
  trades a legal-surface address for a convenience feature.
- **B — Move DNS to Cloudflare.** Free, full record control, and Email Routing replaces the
  forwarding cleanly. Removes this class of problem permanently. Larger change that also
  touches the live site's records, so it wants a deliberate window.

**Advisor recommendation was B**, and the operator chose B. **Executed and complete
2026-07-29** by Mica via browser-harness, under
`docs/org/charters/2026-07-29-dns-to-cloudflare.md`.

`commonswarm.com` is now authoritative at `chelsea.ns.cloudflare.com` /
`ezra.ns.cloudflare.com`. Ten records, Email Routing Enabled, DNS Locked. D-007's missing root
SPF came back as a Cloudflare-managed record in the same move.

**The charter's ordering turned out to be impossible and that is worth keeping.** It said build
the zone fully, then switch nameservers. Cloudflare will not create Email Routing records until
the zone is ACTIVE, and a zone only becomes active once nameservers already point at it —
a circular dependency. Mica stopped rather than working around it. The resolution was to create
the five Cloudflare-managed records **manually**, using values Cloudflare itself proposed, so no
window existed in which the domain had no MX.

**ACCEPTANCE, and it is the only evidence that counts:** a real email sent from
`tlangridge@gmail.com` to `legal@commonswarm.com` **arrived in the `<employer-b-address REDACTED 2026-08-10>`
inbox** at 11:57 CDT, marked External. Mailbox arrival, not DNS inference.

*Advisor's limit on that claim, stated because it matters:* DNS, HTTP and record state were
verified independently by me from authoritative nameservers. **Mailbox arrival was not** — I
have no access to that inbox and no outside mail account. That leg rests on Mica's report, and
the operator can confirm it in one glance. An earlier SMTP probe I attempted was rejected as
`550 Sender IP reverse lookup rejected` — a judgement about my host, not the recipient, so it
proved nothing in either direction.

---

## D-009 — `cmux close-surface` reports a surface ref it did not close · OPEN (tooling)

**Found:** 2026-07-29 by Cinder, closing the orphaned Atlas seat.

`cmux close-surface --surface surface:61` succeeded — surface:61 was removed, `ttys000` was
destroyed, and nothing else was touched — but it printed:

```
OK surface:120 workspace:1
```

`surface:120` **does not exist in the tree before or after the operation.** The command
reported success against a ref that names nothing.

**Why this is worth an entry in a product repo's register:** our operating model turns agent
reports into merge decisions, and this is a tool whose success line is not bound to the thing
it acted on. Here the outcome happened to be right and Cinder caught the mismatch by comparing
against the tree. A tool that says OK about the wrong ref is one bad inference away from a
wrong kill that reads as a clean success — the same shape as a green check against the wrong
target, which this codebase has now shipped three times in other forms.

**Operating rule, effective immediately:** never trust `close-surface`'s OK line. Verify
against `cmux` tree state and the process table before and after. Cinder did exactly this
unprompted, which is the only reason the wart is known.

**Not ours to fix** — it is in the swarm/cmux tooling, not this repo. Recorded so nobody
scripts against that output.

---

## D-010 — `swarm spawn` with no arguments spawns rather than printing usage · OPEN (tooling)

**Found:** 2026-07-29 by Lead6, the hard way.

`swarm spawn` was run to read its usage. It does not print usage; it **acts**, creating a
Claude Code session and joining it to the swarm. That produced an unintended seat (Cinder) on
a machine already under reported memory pressure.

The flags exist and are documented in the source (`--agent <claude|codex>` / `--codex`,
`--split`, `--new-workspace`), but there is no argument-less help path.

**Operating rule:** read spawn flags from `src/index.ts`, never by invoking the command to see
what it says.

(An earlier version of this entry tallied what the accidental seat went on to find. The tally
is removed: a count that needs maintenance is a liability, and the seat's later output has no
bearing on whether spawning it was a mistake. It was.)

---

## D-011 — The 401/403 fallback asserted revocation in every unmeasured case · IN REVIEW

**Found:** 2026-07-29 by Cinder's own class test, while fixing D-004 — the test went red naming
a deviation Cinder had not predicted.

D-004 fixed the case where a credential was measurably past its expiry. The class test then
showed the defect was wider: the generic fallback asserted revocation whenever **nothing was
named and expiry was not measured-past** — so `expiry=future` and `expiry=null` both claimed a
cause the client never established. Same shape as D-004, different input.

Cinder correctly did **not** fix it inside D-004: out of scope, and the wording was an advisor
ruling. It recorded the two cases as known deviations so the test would fail on a third rather
than quietly tolerating the family.

**Ruling given:** at 401/403 with no reason sent and no expiry measured, the client knows one
thing — the deployment refused and will not say why. Say that. Name neither cause. The remedy
is identical either way, so honesty costs nothing.

**Status:** `cinder/d011-unexplained-refusal` @ `2a032b09d3759dfbf6727748e031a00a8b2f74b8`,
rebased onto `main` after D-004 landed. **Not merged**; awaits Mica.

The earlier heads (`003d565`, then `5857dce`) are orphaned. Mica's P1 against the middle one
became **D-017** — the class test could not detect an asserted cause — and the fix for that is
carried here. Advisor-verified at the current head: baseline 15/15; a prose mutation and a
structural mutation each turn exactly one test red, and they are **different** tests; restored
15/15 with an empty diff.

---

## D-012 — `src/cloud/renewal.ts` had zero client-side tests · FIXED (by D-004)

**Found:** 2026-07-29 by Cinder, incidentally, and it is worth more than the defect it was
found under.

856 lines. Called **"PROVEN in production"** in a status report by the advisor — truthfully:
it was exercised end to end against real infrastructure, and a credential renewed itself and
answered a call after its predecessor had expired. And it had **no unit tests at all**. Only
`tests/p1-server/command.test.ts` mentioned renewal, and that exercises the server.

That gap is why nobody noticed the 401 branch was lying about the cause of a refusal for as
long as it existed. An end-to-end proof exercises the happy path; it says nothing about the
branch that only runs when something has gone wrong.

**The lesson is about the claim, not the code:** *"proven in production"* and *"tested"* are
different statements, and the advisor conflated them. `tests/p1-cli/renewal-refusal-cause.test.ts`
is the file's first client-side test.

**Closed by D-004's merge (`ebedf99`) alone.** The citation previously read "by D-004/D-011",
which credited an unmerged branch — the same error as D-017's premature FIXED, one entry apart.
D-011 deepens this coverage; it did not close it.

---

## D-013 — Success lines not bound to what actually happened · OPEN (pattern)

**Found:** 2026-07-29, four independent instances in one session. Recorded as a pattern
because the individual cases are unremarkable and the family is not.

| Tool | Said | Did |
|---|---|---|
| `cmux close-surface` | `OK surface:120` | closed surface:61 |
| `sed` mutation (advisor) | tests went red | red from a **compile error**, not a behaviour change |
| `git checkout <branch>` | names the branch you asked for | silent about whose branch you just left |
| `git checkout <file>` | restores the file | silently destroys uncommitted work in it |

Every one reports success against something other than what it acted on, and every one is
survivable alone. Together they are the mechanism by which a wrong action reads as a clean
one — which is the same failure as a green check against the wrong target, arriving through
tooling instead of through tests.

**Operating rule:** a tool's own success line is not evidence. Verify against the state it
claims to have changed — tree, process table, file content — before recording an outcome.
Both agents hit this today; two of the four are the advisor's.

---

## D-014 — A wedged reviewer is indistinguishable from a thinking one · OPEN (tooling)

**Found:** 2026-07-29. A `codex exec` one-shot dispatched to review `505eee8` ran for **40
minutes and produced zero bytes** at **0.07 seconds of CPU**. Not slow — wedged. It was killed
and the review rerouted.

The operating model already names narration-only output as a failure mode. This is worse:
there was no narration at all, so nothing distinguished "still reasoning at high effort" from
"stopped" except sampling CPU time, which nobody does by default.

**Operating rule:** a dispatched reviewer that has produced **no bytes** must have its CPU time
sampled before it is waited on further. Flat CPU across two samples is a dead process wearing
the costume of a thoughtful one. Reroute to another family rather than extending the wait.

**Consequence recorded:** with that one-shot dead, Mica is the swarm's only working non-Claude
reviewer, so both of Cinder's branches queue behind a single seat. Named so the queue is a
known constraint rather than a surprise.

---

## D-015 — A wrong rebase base presents as a content conflict · OPEN (tooling)

**Found:** 2026-07-29 by Cinder, rebasing D-011 after D-004 was amended.

Amending D-004 orphaned `8ca72df`. A plain `git rebase cinder/d004-expiry-not-revocation`
from D-011 then tried to replay **both** the orphaned D-004 commit and D-011 onto the new
head, and produced an add/add conflict in the test file with D-004's session observer on one
side.

**Taking that conflict at face value would have produced a D-011 branch containing a
duplicated, half-merged D-004** — and it would have looked like ordinary conflict resolution
while doing it.

The correct form replays only what is *after* the old base:

```sh
git rebase --onto cinder/d004-expiry-not-revocation 8ca72df cinder/d011-unexplained-refusal
```

Clean, no conflict. Verified by the advisor at the resulting head: D-004's session observer
appears **exactly once**, history is linear (`6e34b88` → `406a96a` → `main`), 12/12 green.

**Same family as D-013.** The conflict presented itself as a content disagreement for a human
to resolve, when the actual fact was that git had been given the wrong base and had no way to
say so. A prompt for judgement is not evidence that judgement is what is needed.

**Operating rule:** after an amend or force-push that orphans a base, rebase dependent
branches with explicit `--onto <newbase> <oldbase>`. If a rebase you did not expect to conflict
conflicts, suspect the base before resolving the content.

---

## D-016 — Two surfaces disagree about whether an archived workspace is live · OPEN

**Found:** 2026-07-29. Cinder asked whether `archived` is a server state with an authorization
consequence or a client-side label, correctly saying the answer would change the D-006 ruling.
It is a server state, and the two surfaces do not agree about it.

Measured:

| Surface | Enforces `archived_at`? |
|---|---|
| capability endpoint | **Yes** — `workspace_archived` is a pinned refusal, `capability_workspace_archived` |
| command endpoint | **No** — `archived_at` is loaded into workspace state (`command/index.ts:1787`) and the reducer never consults it. `grep -c archived src/protocol/workspace-commands.ts` → **0** |

So archiving a workspace stops an anonymous capability link from reading it, and does not stop
a member or an agent posting to it. The state exists, is carried all the way into the decision
core, and is then ignored by every decision.

**Consequence for D-006, and it inverts the obvious fix:** filtering archived projects out of
`cswarm workspaces` would make the list look right while commands still succeed against them.
That HIDES this defect rather than fixing it, and it is exactly the shape this register keeps
recording — presentation that a determined client bypasses, reading as enforcement.

**Ruling: do not filter the list.** Enforcement, if it is wanted, belongs in the reducer where
the state already is. Until then the honest surface is a CLI that says archived projects are
still live, which is what it says today.

**Unresolved and deliberately not decided here:** whether archiving is *meant* to be an
authorization boundary at all, or only a shelf-tidying label that the capability path
over-enforced. Those are opposite fixes — one adds a reducer refusal, the other removes the
capability refusal — and the answer is a product decision, not an engineering one. Nobody
should write code against either until it is made.

---

## D-017 — A measurement-shaped thing that measured nothing · FIXED

**Found:** 2026-07-29 by Mica, reviewing D-011. The sharpest instance of this register's
recurring pattern, because it was inside the guard built against that pattern.

D-011's class test was sold — by its author, in a commit message, and accepted by both the
advisor and the reviewer — as proving *"the client never reports a cause it did not measure"*.

Mica appended one sentence to the unexplained-refusal message:

> This credential was revoked by an administrator.

`tsc` clean. **12 of 12 tests passed**, including the test named *"names neither cause"* and the
class test with its empty deviation list. A flat lie about revocation passed a suite whose
entire purpose was to prevent that lie. Reproduced independently by the advisor: same 12/12.

**Why it could not work.** `assertedCauses()` read English prose with two regexes and called
the result "the causes this message asserts". That is a guess about natural language wearing
the costume of an invariant. Prose can assert a cause in words a regex does not contain, and
no regex over English decides the question.

**The author's own account, quoted because it is the lesson:** *"I flagged the regexes as my
weakest joint twice and still shipped them as the load-bearing check; flagging a risk is not
the same as not taking it."*

**Closed by `7f34523`, merged to `main` 2026-07-29.** Verified after the merge:
`grep -c assertedCauses` on main → **0**; `grep -c CAUSE_BY_CODE` → **4**. The regex classifier
is gone from the shipped tree, not merely from a branch.

The paragraph below is kept, marked dead, because it was true for several hours and the entry
that recorded it was itself the register's live untruth.

★ **(WAS TRUE UNTIL `7f34523`) THE DEFECT WAS ON `main`.** Measured 2026-07-29 after this entry was first
written as FIXED — which it was not:

```
git show origin/main:tests/p1-cli/renewal-refusal-cause.test.ts | grep -c CAUSE_BY_CODE  -> 0
git show origin/main:tests/p1-cli/renewal-refusal-cause.test.ts | grep -c assertedCauses -> 2
```

`main` carries the broken regex classifier. The structural fix exists only on
`cinder/d011-unexplained-refusal` and is unmerged. Marking this FIXED was itself an unmeasured
claim, in the entry whose whole subject is unmeasured claims — caught by Cinder auditing the
register, not by me.

**Status: FIXED.** It became FIXED when D-011 merged, as this line required, and not before.
Final SHA `7f34523` after two further review rounds — Mica broke the hand-kept mirror by adding
a sixth production reason (15/15 green, nothing presented it), and then required a doc-only
amend because `src/` still claimed compile-time enforcement that D-019 proved inert.

**Acceptance criterion, re-executed by the advisor at the merged SHA:** add a production reason
to `REVOCATION_REASONS_LIST`, touch no test file → `14/15`, with the class test naming it:
*"unclassified refusal code `credential_disabled` — add it to CAUSE_BY_CODE and say which cause
it asserts"*. Restored → 15/15. The input space is genuinely derived
(`REVOCATION_REASONS_LIST.flatMap` in the test); the only occurrence of the probe reason in the
test file is a comment recording Mica's finding. (An earlier version of this entry cited `5857dce`, now
orphaned by the rebase onto `main` that D-004's landing forced.)

**Fix, all three parts, verified by the advisor:**

- **Structural.** The invariant now reads `RenewalRevoked.code` — a closed set the client itself
  chooses — mapped to the cause each code stands for. An *unrecognised* code is a violation
  rather than a silent pass, which was the deeper version of the same hole.
- **Prose pinned by exact equality** against literal copies, deliberately **not** the imported
  constants: comparing a constant to itself passes whatever it says.
- **The regex classifier is deleted, not narrowed.** No claim beats a false claim.

**Both halves proven to catch different failures** — neither would catch the other's, which is
why both stay:

```
prose lie (the mutation that passed 12/12)   -> 15 tests, 14 pass, 1 fail  (prose pin)
wrong code, prose untouched, tsc clean       -> 15 tests, 14 pass, 1 fail  (class test)
restored                                     -> 15/15, clean tree
```

**Generalises D-013.** A green test is a stronger claim than a log line, and this one was cited
in a commit message as the reason to trust the change. The rule is not "distrust tests" — it is
that an invariant must be checked against **structure the code commits to**, never against
prose a human wrote and a pattern happened to match.

---

## D-018 — Four tests in one day asserted against the test's own choices, not production · OPEN (pattern)

**Found:** 2026-07-29. Four separate REQUEST CHANGES verdicts from the same cross-family
reviewer, on three branches, from one author. Each individual fix was correct. Treating them as
four defects is the mistake — they are one root, and naming it is worth more than any of the
fixes.

| # | Branch | The test claimed | What it actually checked |
|---|---|---|---|
| 1 | D-004 | the fix reaches production | `requestSuccessor` called directly; the session handoff at `:788` never executed |
| 2 | D-011 | the client asserts no unmeasured cause | two regexes over English prose |
| 3 | D-011 | unrecognised codes are caught | a hardcoded input space that never emits one |
| 4 | D-006(b) | printed text and JSON never drift | never exercised the JSON path at all |

Every one passed a full suite. Every one was named for the property it did not check. In three
of the four the *name of the test* was the strongest evidence offered that the property held.

**The root, in one sentence:** each test asserted against a value or path **the test itself
chose**, rather than against the path production takes. A test that constructs its own inputs
and calls its own entry point is testing a model of the system, and a model agrees with itself.

**The author's reframing, which is sharper than mine and worth using instead:** in all four,
what went unobserved was *the seam between the change and the surface someone else reads*. The
question to ask before writing a test is therefore not "does my change work" but **"what
carries it to a consumer, and does anything watch that."** D-004's seam was the session handoff;
D-011's was prose reaching an operator; D-006(b)'s was the JSON payload reaching a script.

**The rule, added to `OPERATING-MODEL.md` §4:**

> A test is not evidence for a property until a mutation **of the production call site** — not
> of a constant, not of the test's own fixture — turns it red. If the only mutation that
> reddens it is one the test author chose, the test observes the author's model, not the system.

**Why the existing mutation-proof rule did not catch it.** It required a mutation and got one
every time. What it did not require was that the mutation be applied where production actually
runs. Instances 1 and 4 were reddened by mutating things the tests already watched; nobody
asked whether the watched thing was on the executed path.

**Not a competence finding.** The author flagged its own weakest joint twice in writing,
reproduced every verdict before fixing it, and found the fourth-round hole in its own work. The
advisor missed instance 1 while believing it had verified it, and approved instance 2's test on
the strength of its description. The reviewer caught all four because it was standing somewhere
neither of them was — which is the argument for §2, not against anyone.

---

## D-019 — No test file in this repo is ever typechecked · OPEN

**Found:** 2026-07-29 by Cinder, while implementing D-011's round-three fix. It declined to
count a `Record<RefusalCode, Cause>` exhaustiveness check as the mechanism, on the grounds that
nothing evaluates it — and was right.

`tsconfig.json` is `include: ["src/**/*.ts"]`, and every test script runs through `tsx`, which
strips types without checking them. Measured by the advisor, not inferred — appending
`const _x: number = "definitely not a number"` to a test file:

```
npx tsc --noEmit     exit 0   did not notice
npm run build        exit 0   did not notice
npm run test:p1-cli  exit 0   did not notice
```

**So every type-level guarantee written in `tests/` is decoration** — including one added
deliberately as the mechanism that would catch a new production reason. That is D-017's shape
again: a guarantee no gate evaluates, described as the thing that makes the change safe.
Cinder documented it as inert *inside the test* rather than claiming it worked, which is the
correct handling and the reason this is a finding rather than an incident.

**Sizing it — and my first two measurements of this were both wrong:**

- A throwaway config in `/tmp` reported **0 errors**. Wrong: absolute include paths resolved
  differently.
- A `tsconfig.tests.json` extending the base reported **17**. Also wrong: all 17 were `TS6059`,
  the inherited `rootDir: src` rejecting every test file before typechecking a line.
- With `rootDir` overridden: `grep -c "error TS"` reported **0**. Wrong again — ANSI colour
  codes split the pattern. Stripping them: **7 real errors in 3 files.**

Three bad measurements in five minutes, in the entry about things that measure nothing. Two of
the three read as *good news* (0 errors), which is the direction that does not prompt a
recheck.

```
tests/p1-cli/command-client.test.ts:109         TS2352
tests/p1-cli/renewal-refusal-cause.test.ts:216,218,222,222   TS2339
tests/p1-cli/workspaces.test.ts:101,409         TS2322, TS2790
```

**Not landed, deliberately.** The gate is ~10 lines, but 4 of the 7 errors are in a file that is
currently mid-review on two branches. Landing a gate that reddens someone else's in-flight work
is how a good change becomes a bad afternoon. It goes in once the review queue drains, with the
7 fixed in the branches that own those files.

---

## D-020 — An unidentified intermittent failure in the suite every merge rests on · OPEN

**Found:** 2026-07-29 by Cinder, reported without a reproduction and without being asked.

One run of `npm run test:p1-cli` returned **105/106** with a single failure that was not
captured before the output was lost. Four subsequent full runs returned 106/106. So there is a
flake that has been seen once and cannot be named.

**Why this is in the register despite having no reproduction.** `test:p1-cli` is the evidence
base for every merge decision made today, including two branches in cross-family review and one
already on `main`. A suite that fails once in five without explanation weakens every "green"
cited above it. Recording it late, after a second sighting, would mean every merge in between
had rested on an instrument with a known and unlogged defect.

**Consequence for claims already made:** every "106/106" and "green" in this register and in
today's commit messages should be read as *"green on the run I looked at"*. That is what a
suite with an unidentified intermittent can support. It does not invalidate the mutation
proofs — those turn specific tests red and green on demand, which a flake cannot fake in both
directions — but it does weaken any claim resting on a whole-suite pass alone.

**IDENTIFIED — reproduced on run 1 of 8**, by re-running the suite in a loop and capturing
full output on non-zero exit rather than only the summary line:

```
tests/p1-cli/local-integration.test.ts
  ✖ fixture bridge is idempotent and CLI client drives cradle-to-grave  (4963ms)
    AssertionError: cswarm: command failed (HTTP 502): unknown_error
```

Runs 2–8: 95/95. So roughly **1 in 8**, and it is the one test `AGENTS.md` already documents as
requiring live local Supabase. A 502 from the local edge runtime is a cold-start or restart
artefact of the local stack, **not a logic defect** in the code under test.

**Revised consequence, narrower than the original entry feared.** The flake lands in the
live-infrastructure test, not in the pure ones. Every mutation proof cited today ran against
targeted pure tests and turned specific assertions red and green on demand — which a transport
502 cannot fake in both directions. So the merge evidence stands.

What genuinely changes: a bare "`test:p1-cli` is green" has about a **1-in-8 chance of being
red for reasons unrelated to the change**, which means a red on that test is not evidence of a
defect until it is re-run. Anyone treating a single red there as a blocker will chase a ghost;
anyone treating a single green as proof of the live path is being slightly lucky.

**Not fixed, and deliberately not chased further.** The fix is either retry-with-backoff around
the local edge call or a readiness gate before the suite starts, and neither is worth doing
mid-review-queue. Status stays OPEN with the cause named, which is a better state than the
unnamed intermittent it started as.

**The reporting is the point.** An agent noticed a one-in-five anomaly it could not explain, in
its own favour to ignore, and wrote it down. That is the behaviour that makes the rest of this
register trustworthy.

---

## D-021 — A reviewer's precondition can be satisfied by a stronger proof than it names · RULING

**Raised:** 2026-07-29 by Cinder, against its own interest, at the last merge of the day.

Mica approved D-011 with a stated precondition: *"origin/main has advanced from `d190f1e` to
`34d47e3` in DEFECT-REGISTER docs only; a byte-identical base move preserves verdict."*

By the time the merge came round, **that precondition was false** — D-006(b) had landed,
advancing `main` with code (`src/cli.ts`, `src/cloud/workspaces.ts`, and a test file). Cinder
noticed, proved the underlying property held anyway, and **refused to resolve it**: *"that
distinction is yours to rule on rather than mine to quietly resolve in my own favour — I am the
interested party."*

**Verified by the advisor rather than taken:**

```
literal precondition   docs-only advance?      FALSE — three code files moved
the property it stood for:
  git diff d190f1e e66be08   vs   git diff f6a87e1 7f34523   ->  byte-identical
  patch-id both sides                                        ->  e979b4ed…
  files touched by D-006(b) ∩ files touched by D-011         ->  empty
```

**RULING: a precondition stated as a cheap proxy is satisfied by a strictly stronger proof of
the same property.** "Docs only" was Mica's inexpensive way of asserting *no reviewed content
moved*. Diff-of-diffs byte-identity, identical patch-ids and disjoint file sets prove that
directly. Accepting the stronger evidence is not weakening the rule; requiring the weaker
evidence specifically would be cargo-culting its wording over its purpose.

**The limit, so this is not a loophole.** The stronger proof must establish *the same property*,
must be run by someone who is **not the interested party**, and the reviewer must be told the
proxy failed so it can object. All three happened here. If the file sets had intersected — if
any content had genuinely moved — no amount of proof would substitute and it goes back for
re-review.

**The behaviour is the finding.** An agent with three branches waiting, at the last merge of a
long queue, stopped to say the reviewer's stated condition no longer held and handed the call
upward. That is worth more than the ruling.

