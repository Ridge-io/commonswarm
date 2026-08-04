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

## D-011 — The 401/403 fallback asserted revocation in every unmeasured case · FIXED

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

**Closed by `7f34523`, merged to `main` 2026-07-29**, after three review rounds — each of
which found a real hole (see D-017, D-018). Advisor-verified at the merged SHA against the
acceptance criterion: add a production reason, touch no test file → 14/15 with the class test
naming the unclassified code; restored 15/15.

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

**★ ADDENDUM, added 2026-07-29 after the advisor did this four times in one session: VERIFY THAT
THE MUTATION APPLIED BEFORE READING THE RESULT.** Four separate mutation attempts by the advisor
silently changed nothing — a `python` substring lookup that raised, a regex that did not match, a
`sed` line address that missed — and each time the suite came back green against an unmutated
tree. **A mutation that did not run is indistinguishable from a mutation the test survived**, and
the failure mode is green, which is the direction nobody rechecks. Print the diff, or assert the
edit landed, before running anything.

**The concrete form, contributed by Cinder and better than the discipline it replaces** — every
mutation Cinder ran today used this, and it caught a stale anchor on D-011 that would otherwise
have been recorded as "the mutation survived":

```python
old = '...'
assert s.count(old) == 1, s.count(old)   # raises loudly on 0 (no match) or 2 (double edit)
open(p, 'w').write(s.replace(old, new, 1))
print('mutation applied')
```

It **cannot proceed**, rather than relying on someone reading and correctly interpreting a diff —
a mechanism, not a convention, which is the same distinction that took apart the D-017 class test.
The `== 1` matters as much as the match: it also catches an anchor appearing twice and being
silently edited in both places, or a declaration edited instead of the use site — exactly the
global-`sed` trap the advisor hit on `LOCALLY_EXPIRED_MESSAGE`.

★ **A SIXTH FAILURE, AND A NEW SHAPE: COMPARING INCOMMENSURABLE DIFFS.** Merging L1, the advisor
compared `git diff <sha>^ <sha>` (the LAST commit's diff) against `git diff <base> <branch>` (the
WHOLE branch's diff) and read the mismatched patch-ids as evidence that a rebase had altered
reviewed content. It had not — the branch simply had three commits. 31 lines versus 842.

The scare was harmless because the merge was halted and re-measured, but the lesson is that
**patch-id is only meaningful between two diffs of the same span.** On a multi-commit branch, compare
`base..head` on both sides, or ask the question directly: `git diff <reviewed-sha> <merged-head>`
empty, and `git merge-base --is-ancestor <reviewed-sha> main`. Both of those are unambiguous where
the patch-id comparison was not.

**Its honest limit, stated by its author:** it guarantees the TEXT changed, not that the change was
semantically the mutation intended. It would not catch editing the right line to something
harmless. `sed` line addresses and regexes remain strictly worse, because they fail **silently**
and this fails loudly.

★ **It caught the advisor within minutes of being adopted** — while writing this very paragraph,
the assert fired on a line-wrapped anchor and refused to write. Under the old convention that
would have been a silent no-op edit followed by a confident commit message.

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

---

## D-022 — The primary install command on `/download` has been broken all day, behind two passing checks · IN REVIEW

**Found:** 2026-07-29 by Lumen (codex, L3), reading the DEPLOYED DOM rather than the source or the
build output. This is the most consequential instance of D-018 recorded, and the author of the
failed verification was the advisor.

`site/src/components/download/InstallPanel.astro:150`:

```astro
{cmdHead}<span class="dl-cmd__host">&lt;host&gt;</span>{cmdTail}
```

The host placeholder is **hardcoded in the markup as an HTML entity**. Earlier today `HOST_TOKEN`
was changed from the literal `"<host>"` to `INSTALL_HOST`, which correctly fixed how `cmdHead`
and `cmdTail` split — and left the span *between them* emitting the entity. So the primary
install command on the site renders as:

```
curl -fsSL https://<host>/install.sh | sh
```

The single most important string on the product's site. Live, all day, through a commit whose
message asserted it was fixed and verified.

★ **WHY BOTH OF MY CHECKS PASSED.** This is the part worth keeping:

- The absence check grepped built HTML for the **contiguous** string `https://&lt;host&gt;`. The
  tinting `<span>` splits the URL across markup, so the pattern matched nothing and **0 was read
  as "gone"**.
- The positive control counted `curl -fsSL https://commonswarm.com/install.sh` and found **4** —
  all of them in the lower-page variants, which were genuinely correct. **So the control passed
  while the headline CTA was wrong.**

A passing absence check *and* a passing positive control, on the same invocation, per the
doctrine — and the defect was on neither path. Pairing the two greps is necessary and was not
sufficient, because both looked at a place the defect was not.

**The rule this adds, and it is narrower and more useful than "look harder":** an observer for
rendered copy must assert on **extracted text with markup stripped**, never on HTML source. Any
styling span re-breaks a source-level grep, so a source-grep observer will keep missing this
class forever. Lumen's observer reads the DOM text node; mine read the file.

**Status:** assigned in-lane to Lumen rather than fixed by the advisor, deliberately — Lumen was
actively editing that file and a shared-checkout collision (D-013) is worse than the extra
minutes. Fix + markup-stripping observer + mutation at line 150.

---

## D-023 — The home page tells every visitor signup is switched off. It is on. · OPEN

**Found:** 2026-07-29 by the codex consumer critique; verified against production by the advisor.

Live on `https://commonswarm.com`:

> "Free — three workspaces, no card. **Signup is not switched on for everyone yet, so the flow is
> a preview.**"

`SWARM_SELF_SERVE=1` was set on the production project on 2026-07-28. Self-serve creation works —
it created the workspace this fleet coordinates in. **The front page has been telling every
visitor they cannot have the thing they can have.**

**This is D-002 recurring on the marketing surface.** Same mechanism: availability copy asserts
deployment state, lives in git, and nothing fails when the deployment moves. D-002 was the CLI
telling operators renewal was unavailable while it worked; this is the website telling strangers
signup is unavailable while it works. The register entry for the first one is four hours old.

★ **It also corrupted the review.** The critic, told by the page that signup was off, prescribed
retreating to invitation-only language and a waiting list across three pages. Those prescriptions
were rejected — but a stale claim did not merely misinform a visitor, **it misled a reviewer into
recommending we build the false state for real.** A lie on a surface propagates into the judgement
of anyone who reads it, including our own tooling.

**Assigned:** L2 (Juniper). Delete the claim; state what is true and make it the primary action.

★ **THE ROOT WAS OUR OWN PROJECT DOC, found by Juniper and fixed by the advisor.** `AGENTS.md`
line 8 read *"Status: P3-1, invited dogfood — pre-launch, invite-only, not self-serve."* That file
is the brief every agent reads first. So the stale marketing copy was not an oversight in one
component — **it was downstream of the canonical status line being wrong**, and any agent writing
new copy would have reproduced it faithfully. Juniper found it, correctly refused to edit it as
outside its lane, and reported it instead. Corrected on `main` with the superseded line kept and
marked dead.

**The standing rule this earns:** when a deployment gate flips, grep every surface for copy that
asserts the old state — site, CLI, installer, email templates, OG description — before the flip is
called done. That check has now been skipped twice.

---

## D-024 — A test's name, its comment, and its assertion all contradicted each other · IN REVIEW

**Found:** 2026-07-29 by Nori (codex) on its first review, against `cinder/d020-edge-cold-start`
@ `642ca46`. The sharpest self-contradiction recorded, and it defeated the advisor's own binding
constraint.

The constraint on D-020 was explicit: *"the observer must prove the retry masks ONLY transport
failures and never a real refusal."* Cinder built a gate rather than a retry specifically to make
that structural, and wrote a test for it. Then:

```ts
test("D-020: the gate never treats a real refusal as a reason to keep waiting", () => {
  // A 403 is a decided refusal. If the gate retried on it, a genuinely forbidden probe would
  // spin until timeout and be reported as a cold runtime — a real answer hidden by the gate.
  assert.equal(readinessVerdict(403, JSON.stringify({ error: "forbidden" })), "not-yet");
```

- The **name** says a real refusal is never a reason to keep waiting.
- The **comment** explains precisely why retrying on a 403 would be harmful.
- The **assertion** requires `403 → "not-yet"` — and `"not-yet"` **is** the keep-waiting value.

`readinessVerdict` opens `if (status !== 401) return "not-yet"`, so every non-401 — including a
decided 403 — is indistinguishable from "the runtime is still cold". Nori demonstrated the
consequence: a scripted 403 followed by the function's own 401 **resolves successfully in two
calls**, erasing the refusal.

The test asserts the exact behaviour its own comment identifies as the harm. All three layers
disagree, and the comment is the most damning, because it proves the author understood the risk
while encoding its opposite.

*Advisor's limit on this verification, stated rather than glossed:* the source is unambiguous and
I concluded from reading it. **My attempt to execute Nori's scenario failed twice** on module
resolution and produced no evidence either way — so the runtime demonstration is Nori's, not
independently reproduced by me.

**Prescription (binding):** the verdict must be at least tri-state. Retry only explicitly
identified cold-start/gateway responses. Any decided refusal or unexpected non-transient status
must fail **immediately**, retain its status and body, and never be erasable by a later readiness
response. Plus an observer proving 403-then-401 rejects after one call.


---

## D-025 — the p1-server harness converts "the runtime never came up" into a random assertion failure

**Found by:** Cinder (codex) · **Verified by:** Lead6, source read at `b0e5af1` · **Severity:** P2
**Site:** `tests/p1-server/command.test.ts:825`, the local `postCommand` helper.

```ts
for (let attempt = 0; attempt < 10; attempt += 1) {
  response = await fetch(...);
  if (response.status !== 502) return response;
  await response.arrayBuffer();
  await delay(100);
}
return response!;          // <- hands back the last 502 as if it were a normal response
```

Retrying **only** 502 is defensible — that is the narrow transport case. The defect is the
**exhaustion path**. After ten failures the helper returns the 502 to a caller that will assert on
a status or a body, so a runtime that never boots is reported as whatever assertion happens to run
next. The suite is our evidence for server behaviour, and its failure mode is misattribution.

Same family as **D-024**: the honest answer is available at the point of failure and is
deliberately converted into a confusing one. There the gate erased a 403; here it erases "the
runtime is not up".

**Cinder's second observation, which is the more useful half:** the cold-start fix landed in
`test:p1-cli` (D-020) but the same cold start exists in `test:p1-server`, where it was already
being papered over by this loop. The fix belongs in both harnesses.

**Prescription (binding):** on exhaustion, throw naming the condition — attempts made, elapsed
time, last status — rather than returning the response. Not fixed inside D-003; it is its own
change with its own mutation proof.

---

## D-026 — an approved SHA was merged while a second assigned reviewer was still working

**Found by:** Mica (codex), surfaced as a REQUEST CHANGES on an already-merged commit
**Owner of the error:** Lead6 (advisor) · **Severity:** process, P1

I assigned two reviewers to D-019, merged `3137f52` when Nori approved, and Mica then returned
REQUEST CHANGES on the same SHA with a real finding Nori's review had not reached: `include` was
`tests/**/*.ts`, and `tsx` also executes TSX, so a `.test.tsx` would run **untypechecked** while
the config comment claimed it covered `tests/`. Cinder reproduced it — a `.tsx` containing
`const mustBeText: string = 42;` passed `check:tests` at exit 0.

**The defect inside the defect:** the gate committed the exact fault it exists to catch — a claim
wider than its mechanism — and did so *inside the instrument* rather than in the code under test.

**Impact is LATENT, not live, and the register says so on purpose.** There are zero `.tsx` files in
this repo, no JSX and no React. No bad test ever passed because of it. Recording it as a near-miss
rather than an escape is the difference between a register that can be trusted and one that
inflates.

**Two rules out of this, the first mine:**

1. **When more than one reviewer is assigned to a SHA, do not merge until every one has reported.**
   "Review the decision set, not the items" was already doctrine for rulings; it applies to reviews.
   Merging on the first approval home discards the second reviewer's work by construction.
2. **Two verdicts on one SHA are not resolved by choosing a reviewer.** Mica's finding was
   *additive* — the fix makes both verdicts true rather than overturning either. Cinder declined to
   arbitrate as the interested party and escalated, which is the correct move. Where a fix does
   overturn a prior approval, the rebind is narrow: the first reviewer re-confirms the **delta**,
   not the file.

Because `3137f52` is already on `main`, the correction lands as a follow-up (`f704b66`), not a
replacement. **Pushed ≠ landed ≠ applied** cuts both ways: a merged defect cannot be un-merged by
amending a verdict.

**Still open, flagged by Cinder and deliberately not fixed under this entry:** the test *runner*
globs remain `.test.ts`, so a `.test.tsx` is now typechecked but never executed. Smaller instance
of the same gap, safe direction, latent for the same reason.

---

## D-027 — published legal documents promised remedies the product cannot perform

**Found by:** surface sweep (archiving) + Kestrel's retro claude review (member removal)
**Verified by:** Lead6 with positive controls · **Severity:** P1 — capability claims in contracts

Two capability claims shipped in the live Terms, Privacy Policy, and Acceptable Use Policy:

1. **"Archiving a workspace frees its slot"** — in all three documents, and offered beside the
   free-tier cap as its escape hatch. Nothing writes `archived_at`; the code convicts itself at
   `src/cloud/workspaces.ts:742`: *"no command sets archived_at; only tests do."* Positive
   control: the same grep shape finds 7 write sites for `first_used_at`.
2. **"A workspace administrator can remove a member"** — in Privacy's "Your choices" section.
   `remove_member` exists only in the protocol; the hosted command function and the CLI have
   **zero** exposure of it. Nothing but the INSERT ever writes `swarm.memberships.revoked_at`.

The Privacy instances are the worst of the class: both were published as **controls the reader
has over their own data**. A data right that cannot be exercised is a false statement in a
document that exists to be relied on.

**Ruling (applied):** delete the claim, do not build the feature to save the sentence. Archiving
semantics stay deferred behind D-016's operator ruling; the archiving copy is gone from all
three documents (merged `d0fb1ce`) and from DonePanel (Juniper's L2). Member-removal copy is in
Kestrel's follow-up. **Hosted `remove_member` exposure is chartered separately as real
functionality** (Cinder, after D-025) — the Slack-channel model needs it, but it lands as code
with its own observer, not as a paragraph.

**The class rule:** a legal document is a deployment-state surface like any other. When a
capability gate flips — or turns out never to have been open — grep the legal pages with the
same discipline as the marketing pages. They are the pages with consequences.

---

## D-028 — the Lead ran the shared suite inside another agent's exclusive window

**Owner of the error:** Lead6 · **Severity:** process, P2 · **Cost:** three contaminated
measurements and ~20 minutes of a seat chasing failures that were me.

After merging D-003 locally I ran `test:p1-server` twice (a full run scoring 32/33, then a full
re-run to capture failure detail) and one isolated single-test run — without announcing a slot,
while Cinder had announced one. Two suites against one local stack share rate limits, audit-row
counts, and signal caps in both directions. My 32/33, Cinder's "3 failures", and the control run
Cinder started were all suspect; Cinder's subsequent exclusive runs came back green twice, which
is strong evidence the reds were the collision.

I had granted exclusive windows all day and enforced them on others. **The window protocol binds
the Lead.** Merging is not a licence to measure outside a slot.

Two rules:

1. **Announce a slot before any `test:p1-server` or `db:*`, whoever you are.** The grant list
   has no Lead exception.
2. **A slot release must carry its measurement.** "DB SLOT FINISHED" with no counts is a window
   paid for and returned empty; the numbers travel with the release message.

What survived the contamination, recorded because it answered a standing question: the committed
`supabase/functions/_shared/protocol.js` is **current** — clean before the run and clean after
`pretest:p1-server` regeneration, confirmed independently in Cinder's window. The AGENTS.md
caveat "a stale bundle typechecks fine while being wrong" now has its first positive measurement
on the other side.

---

## D-029 — three merges satisfied the inversion rule only in the Lead's imagination

**Owner of the error:** Lead6 · **Severity:** process, P1
**Surfaced by:** Nori's own identity correction: *"Nori is a codex/openai seat, not Claude."*

I assigned Nori as reviewer for Cinder's work all day believing Nori was claude-family. Nobody
told me that; I never checked. Nori is codex. Consequence: **D-019, D-020, and D-003 all merged
to main carrying only codex-family verdicts on codex-authored work** — Mica and Nori are
independent instances, but independence within a family is not inversion, and the charter says
so explicitly: *"self-family review satisfies nothing."*

Mitigations that were real: all three changes had execution evidence (mutation proofs, exclusive
suite runs), two independent same-family reviewers, and repeated informal claude-side
verification by me during the day — but no claude or grok verdict was ever **bound to the merged
SHAs**. The remediation is a retroactive cross-family review of all three merged diffs, recorded
in this register when complete.

**The rule:** a review only counts toward inversion when the reviewer's **family is verified,
not assumed** — and the DONE/verdict message must state it. The seat registry as of now:
Lead6 = claude; Mica, Cinder, Kestrel, Juniper, Lumen, Nori = codex/openai; grok = via
subagent CLI only. The operator's standing rule (claude+grok self-review before DONE) closes
this gap structurally for future work, which is exactly why it was the right rule.

---

## D-030 — 43 pure tests are gated behind a stack-touching glob

**Found by:** Cinder, falling out of Nori's mid-flight reversal on D-025 observer placement
**Severity:** structural, P2

`test:p1-cli` globs `tests/p1-cli/**`, and ONE file in that directory —
`local-integration.test.ts` — spawns `supabase functions serve`, creates auth users, and writes
Postgres. Everything else (43 tests: edge-readiness, archive-notice, renewal-refusal-cause, and
now the moved cold-start observers) is pure. Consequence: every pure observer filed there can
only be run by whoever holds the exclusive DB slot.

Nori's principle, worth the entry on its own: **a gate you must queue for is a gate that gets
skipped.** Nori had first prescribed moving the D-025 observers INTO that directory, then
reversed after Cinder's warning — the reversal is the finding.

Also recorded: the slot protocol now covers `test:p1-cli` alongside `test:p1-server` and `db:*`
(Cinder ran it three times during Lumen's slot before anyone realised it touches the stack —
same D-028 class, self-caught, broadcast).

**Prescription (chartered to Cinder, after the D-025 chain):** split `local-integration.test.ts`
into its own script (`test:p1-local` or similar) so `test:p1-cli` becomes genuinely pure and
slot-free. Small and mechanical; the payoff repeats on every pure observer for the life of the
project.

**Resolved by Nori.** `local-integration.test.ts` now lives under `tests/p1-local/` and is the
only file reached by the separately named `test:p1-local` script. `test:p1-cli` remains globbed
over `tests/p1-cli/**` and is genuinely pure and slot-free. The old "43 pure tests" count above
was true when the defect was filed but had already rotted: the measured final split is **121
existing pure tests + 3 D-030 structural observers = 124/124** in `test:p1-cli`, with the isolated
stack suite **3/3** in its one announced exclusive DB slot.

The new observers derive every `*.test.ts` / `*.test.tsx` path from the filesystem, derive its
real execution reachability from `package.json`, and ask TypeScript's own config parser whether
the config actually named by `check:tests` includes it. They run in both pure gates. Grok's
first exact-SHA review found that the initial purity observer could not reject a copied-back
stack file, an `npm run test:p1-local && ...` chain, or deletion of the moved file; that SHA was
rejected. The corrected observer pins both boundary commands and asserts exactly one on-disk
`local-integration.test.ts`, at the isolated path.

Five printed mutations then went through the real pure `npm test` gate: copying the file back
under `tests/p1-cli/` and chaining `test:p1-local` into `test:p1-cli` each produced **81/82** with
the purity observer red; removing the isolated file and pointing its script at a missing path
each produced **80/82** with the reachability and purity observers red; placing an orphan path
only in a shell comment produced **81/82** with the reachability observer red. Restored:
`npm test` **82/82**, `test:p1-cli` **124/124**, `test:p1-local` **3/3** in its one announced
exclusive slot, `check:tests` exit 0, build exit 0.

### D-029 CORRECTION (same day, ~40 minutes later) — the central claim was wrong

The entry above asserts *"D-019, D-020, and D-003 all merged to main carrying only codex-family
verdicts on codex-authored work."* **That claim is dead.** `swarm members` prints each seat's
family, and reading it instead of assuming shows: **Cinder is `family=claude`** (a
`cmux/claude-code` seat). All three changes were therefore **claude-authored work reviewed by
two openai seats — the inversion was satisfied correctly the whole time.**

What actually happened is worse for the Lead and better for the process: I made the family error
**twice in one day, in opposite directions** — first assuming Nori was claude (it is openai),
then "correcting" my ledger by assuming Cinder was openai (it is claude). Neither assumption was
ever checked against the tool that prints the answer.

The measured registry, from `swarm members` at 17:36:
- **claude:** Lead6, Quarry, Cinder
- **openai:** Mica, Kestrel, Juniper, Lumen, Nori, Tundra
- **a2a / family unknown:** Anvil, Dana

The rule in the entry above **survives and is strengthened** — a review counts toward inversion
only when the reviewer's family is *verified, not assumed*, and verdicts state it — because the
verification is one command, and I skipped it twice. The "retroactive remediation" review panel
was dispatched under the false premise; its results remain useful as an extra independent voice
on merged infrastructure, but nothing was actually broken that it needed to remediate.

---

## D-031 — the p1-server suite is not idempotent against its own database

**Found by:** Cinder, via the D-025 parent×2/branch×2 control · **Severity:** P1 — it corrupts
the shared instrument

**The measurement:** `SELECT count(*) FROM swarm.workspaces WHERE created_at > now() - interval
'1 day'` returned **1,540** on the local stack. Three self-serve tests assert free-tier
rolling-window caps, and the window had accumulated every suite run of the day — so they fail as
a function of **how much the suite has been run**, not of what the code does. Nothing clears the
window between runs.

This single fact explains the whole afternoon of "turbulence": 33/33 early, then 32/33, 31/33,
30/33, 29/33 as the day wore on — a monotonic counter nobody clears, wearing the costume of
flakiness. It also exonerated D-025 twice over: zero cold-start trace lines in all four control
runs (the widened budget never engaged), T-03 passed all four (its earlier 33.6s belonged to the
contaminated window-collision period), the same three tests fail on parent and branch alike, and
the worst run of the four was the one **without** the change.

**Standing caveat this entry places on the register itself:** every whole-suite p1-server count
reported today is conditional on the database state at the time it was taken. A clean checkout
can go red because someone ran the suite four times an hour ago; a defective change can go green
because the stack was freshly reset. Treat historical suite numbers accordingly.

**Prescription (chartered to Cinder, ahead of the extension, the local-integration split, and
remove_member):** make the cap assertions hermetic — fresh identity per run where the cap is
per-identity, window reset in the fixture where it is not, and the fix must state which caps are
per-identity and which are global **as measured**, since that distinction decides the design.
With the usual observer + mutation discipline.

### D-029 second addendum — the "extra voice" panel produced nothing usable

For the record, since the correction above mentions it: the retroactive review panel came back
codex=timeout, claude=timeout, grok=a two-sentence preamble with no verdict. No usable output.
Per the corrected ledger no remediation was required, so the thread is closed rather than
re-run; the three merges stand on their original (valid) cross-family reviews. Silence is not
agreement, and an empty panel is not a review — recorded so nobody later cites this run as one.

### D-031 CORRECTION (Cinder, same hour) — the measurement was real, the mechanism was not

The entry above infers *"a rolling-day cap blown by 1,540 accumulated workspaces."* **That
mechanism is dead.** Both per-identity caps key on `created_by` (`FREE_TIER_WORKSPACE_LIMIT = 3`
live; `SELF_SERVE_CREATE_DAILY_LIMIT = 6` per 24h), and the fixture mints a fresh identity per
test via `randomUUID` — a per-identity cap on a brand-new identity cannot accumulate across
runs. The 1,540 never enters either predicate. In Cinder's words, kept because the register is
for exactly this sentence: **"I reasoned from a number I had measured to a mechanism I had
not."**

**The actual cause, measured:** the failures are `503 !== 200`, and `swarm.spend_breaker` holds
`trip_id 1, proxy workspace_create, observed 102, ceiling 100, tripped_at 22:31:49, cleared_at
NULL, tripped_by automatic`. The suite tripped the **global, hourly, latching spend breaker**
(`SPEND_CEILINGS.workspace_create = 100/hour`), after which the command function answers
`503 signup_paused` for every create — on parent and branch alike — until a human with
`swarm_admin` runs `swarm.reset_spend_breaker(who, why)`.

**The breaker is working as designed.** Its migration comment
(`20260728000001_spend_circuit_breaker.sql:260`) is explicit: trips are counted on operation
proxies, only self-serve creation pauses, rows persist as the record, latch clears manually.
The defect is the SUITE's: it consumes ~30+ creations per run against a 100/hour global ceiling
and neither clears the latch in its fixture nor uses a test-scoped ceiling. Fresh-identity-per-run
— the fix the dead mechanism implied — would have fixed nothing.

**Wider caveat, sharpened from the entry above:** every create-path suite result taken after
22:31:49 today measured a service in `signup_paused`, not the code under test. Re-take rather
than trust.

**Operator-visible implication (flagged, deliberately NOT changed):** production runs the same
latch. A launch spike exceeding 100 workspace creations per hour pauses self-serve signup
globally until someone runs `swarm.reset_spend_breaker` — by design, protecting spend over
growth. The launch checklist should carry the reset procedure and, ideally, an alert on
`spend_breaker` rows with `cleared_at IS NULL`. Changing the ceiling or the latch semantics is
an operator product ruling, not a fleet fix.

**Prescription (unchanged owner, corrected direction):** the fixture clears or scopes the
breaker in the TEST environment only — never in any production path — with an observer proving
a tripped-then-cleared local breaker lets the suite run green, and a mutation proving the
fixture reset cannot fire outside the test environment.

---

## D-032 — the inversion gate named two families where the principle requires one · SUPERSEDED

**Ruled by:** Lead6, 2026-07-29, immediately before handing the Lead role to a codex seat
**Severity:** process ruling, unblocks two frozen branches

The operator's standing rule was broadcast as *"every codex seat runs its own claude AND grok
adversarial review before DONE."* The Claude account then hit its monthly spend limit, and
**every** reachable claude-family seat — Lead6, Quarry, and local `claude -p` — began exiting
with `You've hit your monthly spend limit`. Three seats correctly refused to report DONE rather
than claim a verdict they could not obtain (Lumen at `fd7b773`, Mica at `eae52d5`), which is the
right instinct and exactly what the rules asked of them.

**The ruling: a `grok` verdict alone satisfies the inversion gate for codex-authored work.**

`OPERATING-MODEL.md` §2 requires the reviewer be **a different family from the author** —
self-family review satisfies nothing. `grok` is xAI; the authoring seats are OpenAI. The
inversion is satisfied. "claude AND grok" was belt-and-braces from a period when both were
available, not the principle; naming two specific families in the rule where the principle
requires *difference* is the same defect class this register keeps recording — **a mechanism
narrower than the claim it serves, which then fails closed on something irrelevant to the risk.**

**Conditions attached, so this is not a quiet lowering of the bar:**

1. The DONE report states the verdict came from grok **alone** and names the reason (claude
   family unavailable, account spend limit). No report may imply a claude verdict exists.
2. Everything else in the standing rule holds unchanged: exact-SHA binding, mutation proof at a
   production call site, gate counts from real output, rejections argued with evidence.
3. When claude capacity returns, the merged SHAs get a retroactive claude read — recorded here as
   a follow-up, not as a blocker to shipping now.
4. This ruling covers **codex-authored** work only. Claude-authored work still needs a non-claude
   reviewer, which is unaffected — grok and five codex seats remain available.

**Rejected alternative:** waiting for spend restoration. Two complete, green, grok-approved
branches — the workspace-first dashboard the operator personally asked for, and the internal-docs
root-cause fix — would sit frozen behind a billing condition that has nothing to do with their
correctness. Blocked is an honest state; blocked on the wrong thing is a defect in the rule.

### D-032 SUPERSEDED before either frozen branch merged

The Grok-alone exception above is **dead for work not already merged**. The operator issued a
new first-order ruling after Lead7 accepted the handoff: every swarm mate now runs adversarial /
model-inversion reviews with **both Grok and AGY/Gemini instead of Claude**. D-033 is the live
rule. Different-family review remains necessary but is **not sufficient**; the operator has
replaced it as a passing gate with the named two-family mechanism.

---

## D-033 — Grok + AGY/Gemini replace Claude for every swarm mate · RULING

**Ruled by:** operator, 2026-07-29, before either D-032-frozen branch merged
**Applied by:** Lead7 · **Severity:** process ruling, first order of business

The operator removed Claude from the required review path after the headless/shared-account
path hit its token limit. Effective immediately:

1. Every swarm mate obtains **both** an xAI/Grok verdict and a Google Gemini verdict through
   `agy`, instead of a Claude verdict.
2. Both verdicts bind to the exact SHA. If either review produces changes, the replacement SHA
   gets both reviews again.
3. Reports name each actual reviewer family and verdict honestly. They do not wait for, imply,
   or claim a Claude verdict.
4. Mutation proof at a production call site, real gate counts, argued rejections, and
   `NOT ESTABLISHED` remain required.
5. D-032's Grok-alone exception is superseded for all work that had not already merged. At the
   moment of this ruling, L7A `fd7b7733f3126483eb97cc717dde85899828a992` and L6
   `eae52d5fbf01f265500b9e6708c553cfaa1da56c` were both still unmerged, so each requires the
   AGY/Gemini arm before merge.

A single different-family verdict does **not** pass D-033. Grok alone, Gemini alone, and Codex
review are each insufficient. The current fleet has no xAI- or Google-family authoring seat;
if that changes, the Lead must obtain an operator ruling before assigning that lane because
self-family review still counts as no review.

Each required arm returns substantive findings or reasoning; an empty `PASS` is not a review.
An optional Claude read does not replace either arm. **Do not widen the capacity observation:**
Lead6 and local headless `claude -p` were spend-limited, while Quarry's interactive Claude seat
remained live and proved it by continuing to send messages and run work. The operator's choice
of Grok + AGY/Gemini is the gate regardless; it is not evidence that every Claude invocation
is unavailable.

**Measured availability, not inferred:** `/opt/homebrew/bin/grok` and
`/Users/yulanbot/.local/bin/agy` both resolve. `agy --help` exposes non-interactive `--print`;
`agy models` enumerates Google models including `gemini-3.1-pro-high`. The old durable claim
that Gemini was not installed is marked dead in `OPERATING-MODEL.md` and the active consumer
charter.

**Instruction-surface sweep:** an exhaustive repository `rg` for Grok-alone, Claude+Grok,
Gemini-not-installed, no-Google-voice, and Claude-reviewer variants found the current
instruction surfaces corrected above. Remaining matches are historical defect evidence,
superseded text retained and marked dead, product examples naming supported agent brands, or
source comments describing past reviewer identity; none is an alternate live review gate.

**Both reviewer command paths produced substantive positive and negative verdicts on related,
but non-identical, D-033 instruction controls.** Grok rejected real SHA
`3d5ed0a24b55924443c138b290e2b229e5b3ddf7` for stale alternate-review mechanisms, then
approved corrected SHA `f8588b738862dc5f72d93293624c2ecabbad6c3e`. AGY with
`gemini-3.1-pro-high` approved that corrected SHA, then rejected a later deliberate mutation
that required Claude only, made Grok and AGY/Gemini optional, and removed exact-SHA rebinding.
The captured stdout and exact finding labels are committed at
`docs/evidence/2026-07-29-d033-reviewer-controls.md`. This demonstrates positive and negative
results for this instruction class; it does not establish universal reviewer quality or future
determinism.

---

## D-034 — signal status fallback could wait forever on a pending fetch · IN REVIEW

**Found by:** Tundra, 2026-07-29, read-only audit of exact main
`c152c2cd78194007be57fb8671ae6820699f0ee1`
**Owner:** Tundra · **Severity:** P1 status-path availability

`settleSignalStatus()` used `Promise.allSettled()` to turn rejected signal reads into a warning,
but all three underlying signal/member `fetch` call sites had no application deadline. A
provider connection that stayed pending therefore never rejected, `allSettled()` never
returned, and the fallback it advertised could not fire.

The signals-only patch on `swarm/Tundra/d034-signal-fetch-deadline` puts the human signal read,
agent signal read, and agent member read through one 30-second `AbortController` deadline.
The deadline covers both fetch and successful-response JSON consumption, composes any existing
caller signal, and races the full read so even a non-cooperative injected fetcher cannot keep
the caller pending. Successful responses are unchanged, rejections and timeouts retain the
existing `could not reach the cloud service` wording, and timer/listener cleanup runs on every
settled caller path.

The pure observer is explicitly named in root `npm test`. It drives all three production fetch
sites with providers that never answer, proves each receives and obeys an `AbortSignal` at
30 seconds, proves a successful-response body stall remains under the same deadline, and proves
the real `settleSignalStatus(readSignals(...), readSignals(...))` path returns its warning.
Removing production signal propagation made the initial observer fail 0/2. Deliberately ending
the timer at response headers made the corrected body observer time out; restoring it made the
targeted observer pass 3/3 and root `npm test` pass 82/82 on the pre-rebase signals-only branch.
Those counts and the evidence-document run IDs are frozen historical evidence, not the final
integrated gate count; the post-rebase task ledger and Lead handoff carry that count. Full
commands, ledger run numbers, the first-SHA Gemini rejection, its accepted correction, scope,
and non-claims are recorded in `docs/evidence/2026-07-29-d034-signal-fetch-deadline.md`.

**Scope boundary:** the exact-main audit found 14 default-native fetch/fetcher call sites:
6 already carried application deadlines and 8 did not. D-034 changes only the three signal
read sites.

**Superseded integration-history statement — DEAD after browser lane `e7537289`:**
~~Browser create-workspace, CLI login, accept-link, and workspace-list reads remain separate
defects and are not fixed or claimed here.~~

**Current integrated truth:** the separate landed browser lane at
`e7537289a5a0f6d4b034764dbdf2caa13480610b` bounds browser create-workspace, signup membership,
and dashboard feed reads. Those browser outcomes are not evidence claimed by this signals lane.
CLI login, accept-link, and workspace-list reads remain open and outside the signals-only scope.

**D-034 content reconciliation (measured 2026-07-30, Onyx hosted-remove-member-final):** orphan
browser candidate `4be37fc` and primary-clone `main` carry byte-identical
`site/src/lib/commonswarm.ts` and `tests/p1-cli/browser-fetch-deadline.test.ts` relative to the
landed browser runtime path; the browser lane landed via `e753728` with later evidence
corrections on main. This is a content-identity note for remove_member documentation hygiene,
not a claim that D-034 is closed or that hosted remove_member is deployed.

---

## D-035 — hosted remove_member fresh-auth AMR allowlist (Decision #198) · RULING

**Found by:** Lead7, 2026-07-29/30, hosted remove_member design and candidate gates
**Owner:** Onyx (executor) · **Severity:** P1 authn correctness for a destructive workspace command
**Authority:** Decision #198 (supersedes any local mention of Decision #183 for this allowlist)

Hosted `remove_member` must require a **fresh interactive authentication** measured from
verified JWT claims produced by `auth.getClaims()` for the presented session. The newest
allowed AMR method timestamp is the only clock. JWT `iat` and global sign-in timestamps
are not used.

**Exact interactive AMR method strings (literals, not aliases):**

- `oauth`
- `password`
- `otp`
- `totp`
- `sso/saml`
- `magiclink`
- `email/signup`

Slash-bearing values are **literal** method strings as emitted by Supabase GoTrue. Undocumented
aliases such as bare `sso`, `saml`, `email`, or `signup` fail closed.

**Explicitly excluded (fail closed):** `token_refresh`, `recovery`, `invite`, `email_change`,
`anonymous`, missing, malformed, future (timestamp after server now), and any method not in
the allowlist.

**Window:** 300 seconds (`FRESH_INTERACTIVE_AUTH_SECONDS`) upper age on **new**
idempotency misses. **Idempotency replay precedes the fresh-auth gate** and returns the stored
result without rechecking freshness. A stale first attempt is audit-only and unledgered; the
CLI preserves that command id for the explicit post-login retry.

**Clock-skew policy (supersedes zero-tolerance prose):** accept
`ageSeconds >= -FRESH_INTERACTIVE_AUTH_CLOCK_SKEW_SECONDS` (5) and
`ageSeconds <= FRESH_INTERACTIVE_AUTH_SECONDS` (300). The five-second negative floor covers
auth-service (GoTrue AMR timestamps) versus database `statement_timestamp()` skew so a
just-signed-in user cannot loop forever on `fresh_auth_required`. The 300-second upper bound
is unchanged. Larger future timestamps still fail closed.

**AMR shape disposition (Gemini string-array proposal rejected):** Supabase JWT Claims
Reference defines `amr` as `Array<{ method: string; timestamp: number }>` with object entries
(https://supabase.com/docs/guides/auth/jwt-fields). Timestamp-less RFC method strings cannot
prove freshness and fail closed. Hosted real-token AMR shape remains an **unestablished
deploy-time observation**.

**Label note:** pure tests cite `D-035 / Decision 198` on this candidate; a reviewer claim that
the test still said Decision 183 was a stale artifact, not the exact tip under review.


**Landing authority and workspace-scoped revocation** rulings are unchanged: removal never
transfers repository landing authority; `MemberRemoved` projection updates exactly one live
membership in the routed workspace using the event timestamp.

**Evidence:** `docs/evidence/2026-07-29-hosted-remove-member.md`, pure observers in
`tests/remove-member-mutation.test.ts`, `tests/fresh-auth.test.ts`, and browser observers in
`site/src/components/app/member-admin.observer.test.ts`.

~~Any prose that cites "Decision #183" as the remove_member AMR allowlist authority is
superseded; use Decision #198 / D-035.~~


## D-036 — Grok credit exhaustion; the two-arm review gate is re-based, not relaxed · RULING

**Found by:** ClaudeCswarm (relief lead), 2026-08-02, during v0.1.5 release planning
**Owner:** ClaudeCswarm · **Severity:** P1 process correctness — blocks every acceptance in the
0.1.5 critical path
**Authority:** operator ruling 2026-08-02 (supersedes the 2026-07-29 gate paragraph in `AGENTS.md`)

**The defect is documentary, not behavioural.** Committed doctrine — the `AGENTS.md`
model-inversion paragraph and D-033 — named **Grok** as a mandatory review arm and stated that
"Grok alone, Gemini alone, and Codex review are each insufficient." Grok has been
credit-exhausted since approximately 2026-07-31. The substitution the fleet has actually been
operating under existed **only in gitignored `scratchpad/` files**: `grep -rniE
"credit.exhaust|grok.substitut" docs/` returned zero matches at the time of this ruling.

Consequence if left unrecorded: every acceptance in Stages 1–7 of the 0.1.5 plan would be
executed against a committed gate it demonstrably does not satisfy, and any later reader
applying the repo's own doctrine — including a release reviewer — would be obliged to reject
the release. `V015-RELEASE-CHECKLIST.md` correction 6 already ordered this recording
("Record the operator-authorized Grok substitution durably. Never silently claim Grok ran")
and no lane had performed it.

**The ruling.** The two-arm requirement is **unchanged and remains binding**. What changes is
only which families may fill the arms:

| Arm | Permitted | Notes |
|---|---|---|
| Exact review | Codex, or Claude | Reads the frozen contract against the exact SHA |
| Independent inversion | Google Gemini via `agy`, or Kimi K3 via Pi | Must be a *different* family from the exact-review arm |

- **Grok is not a usable arm** until its credit is restored. Never claim a Grok verdict.
- **One arm is never sufficient**, in any family combination. This is the part of the original
  ruling that must not erode, and re-basing the families is not permission to relax it.
- Each arm must return substantive findings or reasoning. **An empty PASS is not a review.**
- If either arm changes the SHA, **both** rerun on the replacement SHA.
- Builders may not self-approve; the reviewing arms must not be the authoring context.

**Scope and expiry.** This ruling covers the v0.1.5 release and any lane running while Grok is
credit-exhausted. When Grok credit is restored, D-036 does not automatically revert — a fresh
operator ruling is required, because the measured condition that produced it will have changed
and the decision set must be reviewed as a set, not item by item.

**What this ruling does not establish:** it does not certify that any particular arm was
actually run on any particular SHA, and it does not retroactively bless acceptances performed
before it landed. It records the gate; each lane must still record its own two arms.

~~Any prose that names Grok as a required review arm, or that reads "BOTH Grok and Google
Gemini via `agy`" as the current gate, is superseded; use D-036.~~

## D-037 — the connect prompt's credential wording stops compliant agents unnecessarily · OPEN

> **CORRECTED 2026-08-03, and the correction is the finding.** This entry originally read *"a host
> that cannot pipe stdin cannot onboard an agent, and the site says otherwise"*. **That framing was
> wrong and is dead.** It rested on my misreading of the connect prompt, which I then propagated into
> the evidence file, this register, and the laptop worker's brief.
>
> The prompt says: *"Do not use echo, printf, or a heredoc **to construct a command containing
> it**."* The qualifier is load-bearing — it forbids putting the credential **into argv**. It does
> **not** forbid `printf '%s' "$VAR" | cswarm --link-stdin`, where the secret travels through the
> pipe and never appears in a command. `README.md:133-135` documents precisely that pattern, with
> the comment *"Keep the invite capability out of argv/history."* `printf` is a shell builtin, so
> nothing enters argv, the process list, or disk. **It satisfies the exact property the CLI
> enforces.**
>
> Measured on the laptop by Wren, using the product's own documented method with a non-secret
> sentinel: **Claude Code 2.1.220 CAN** write to a running process's separate stdin, and **Codex CLI
> 0.145.0 CAN** (verified by running Codex itself, not inferred). The parser advanced through empty →
> base64url decode → JSON parse → schema validation, which proves stdin delivery works and only a
> real link was missing. **There is no host-capability boundary.**

**Found by:** the operator, 2026-08-03, on a second physical machine with a real Codex CLI
**Owner:** operator decision required · **Severity:** P1 product gap (not a code defect)
**Measured on:** production v0.1.4; the v0.1.5 delta does not touch this path

A teammate opened a valid invite and let a **Codex-hosted** agent run the generated connect prompt.
The installer worked (`cswarm 0.1.2` → `0.1.4`). Then:

```
cswarm working-on "…" --agent-token-stdin        (PTY)
  -> --agent-token-stdin requires a piped secret; it is never accepted as a command-line argument

cswarm working-on "…" --agent-token-stdin        (non-PTY retry)
  -> agent credential must be swm_agt_ followed by 32 base64url-encoded random bytes
```

The agent then **stopped and reported**, rather than improvising.

**Nothing malfunctioned.** `src/cli.ts:558-562` deliberately refuses a TTY so a credential can never
be reached from argv, and `site/src/components/connect/agent-prompt.ts:87-88` instructs the agent in
advance: *"If your host cannot write to a running process's stdin separately, stop instead of
improvising."* Codex obeyed exactly. The credential never touched argv, a file, or a log. **The
safety design worked.**

**The actual defect is a documentation conflict.** An agent that reads the connect prompt strictly
stops; an agent that follows `README.md` succeeds. The Codex agent that failed did exactly what the
prompt appeared to say — and so did I, when I wrote this entry. Two documents describe the same
security property and only one of them is followable.

**The dashboard sentence is probably fine as written.** If the README is authoritative, the supported
set is *every host with a shell*, and no scoping is needed. Do not narrow that copy until this is
settled — narrowing it on the strength of the original misreading would have been a self-inflicted
product regression.

**This is the D-023 shape.** That incident was availability copy in git asserting a deployment state
reality did not deliver, and it cost real damage before anyone caught it. The lesson recorded then —
*"availability copy asserts deployment state and lives in git, so nothing fails when the deployment
moves"* — applies here with "deployment state" replaced by "supported host set".

**Not established, and each matters to the disposition:**

- whether **Grok CLI** or **Claude Code** succeed on the identical path. Only Codex was tried, and
  the v0.1.4 measured path was Grok — so this may be a known-narrow supported set rather than a
  regression. **One hour on the second machine converts a guess into a supported-hosts list.**
- whether the non-PTY failure was EOF or a mismatch between the prompt's instructions and Codex's
  process model. The error text is consistent with an empty read; the cause was not isolated.
- whether any part of the undeployed v0.1.5 changes it. `git log origin/main..HEAD --
  site/src/components/connect/agent-prompt.ts` is **empty**; the onboarding path is byte-unchanged by
  this release.

**Ruling required before the v0.1.5 freeze.** The options, with the recommendation stated:

1. **Fix the connect prompt's wording** so it forbids what it means — a credential in argv, a URL,
   shell history, source, or a log — and explicitly *permits* the README's builtin-`printf`-into-pipe
   pattern. Recommended: it is a copy change that unblocks every host with a shell.
2. Reconcile the prompt and `README.md` so one is authoritative, and say which.
3. **Do NOT add a new credential channel under freeze pressure.** An env var or file path is a new
   secret-handling surface designed in a hurry, and it would reopen the credential-escape review
   (Runtime A2) that has just closed. A real design — for example a short-lived pairing code
   exchanged over HTTPS, sidestepping stdin entirely — belongs in 0.1.6.

Full measurement trail: `docs/evidence/2026-08-02-v015-execution/stage-q-authenticated-qa.md`,
section QA-011.

## D-038 — the product emits a link its own CLI cannot parse, and blames the payload · OPEN

**Found by:** Wren (laptop seat), 2026-08-03, during the invite burn test
**Owner:** operator decision on severity · **Severity:** P1 first-run path for every new collaborator
**Verified independently by the Lead against the release branch**

### The mismatch

| Side | Form |
|---|---|
| What the product generates | `https://commonswarm.com/invite#invite=<payload>` (`site/src/lib/member-invite.ts:176`) |
| What the CLI accepts | `cswarm://accept/<payload>` or a bare `swm_inv_` capability (`src/cloud/invite-link.ts:191-202`) |
| `cswarm://` forms anywhere in the site | **none** — grep over `site/src/` returns zero |

The web form is correct *for a browser* — `/invite` consumes it, and that path works (a real second
human joined through it this session). The gap is that **the product never emits the form its own CLI
accepts**, so there is no path from "the link you were sent" to "the command the README documents".

### The error is wrong about the cause

`decodeInviteLink` (`src/cloud/invite-link.ts:181-183`) strips `cswarm://accept/` **if present** and
otherwise passes **the whole string** to the strict base64url check. A full https URL therefore fails
on its own colons, slashes and hash, and the user is told:

```
invite link payload must be strict unpadded base64url
```

That blames the payload encoding. The payload was fine; the **wrapper** was wrong. The message points
at nothing actionable, offers no hint to convert the form, and no hint to open it in a browser
instead.

### Why this is more than a papercut

The dashboard promises *"Send one link. They connect their agent."* The link the product hands out
cannot be given to an agent. **The Lead reproduced the user reflex without noticing**: asked to mint
an invite for the laptop, I copied the web link from the dashboard and sent it — exactly what any
human would do. Wren then hit the misleading error and had to hand-convert the form to
`cswarm://accept/<payload>` before `0.1.4` parsed it immediately.

This plausibly contributes to D-037 (the Codex agent that stopped during onboarding): an agent handed
the web link and told to `cswarm accept` gets a false explanation about encoding.

### Second order — the scheme was renamed too

`0.0.1` accepts only `coswarm://accept/`; `0.1.4` accepts only `cswarm://accept/`. **Each rejects the
other's form with the same misleading base64url error.** A saved link, an old runbook, or shell
history can hold a link that one installed client parses happily and the other calls corrupt.

### Suggested order, per Wren and endorsed

1. **The error message first.** It is on every new collaborator's first run and actively misleads.
   Detect an `http(s)://…/invite#invite=` wrapper and say so — "this is the web link; open it in a
   browser, or use the `cswarm://accept/` form" — rather than accusing the payload.
2. Then decide whether the product should also emit a CLI-form link, or whether `/invite` should show
   one for the agent path.
3. The stale-client scheme skew is real but needs both an old installed binary *and* an old-form
   link; lower.

### Not established

Whether a **completed** `0.0.1` acceptance consumes the invite or registers a device wrongly. The
burn test reached the GitHub OAuth stage on both clients and **stopped there** — Wren declined to
authenticate as the disposable address, correctly. The capability was **not** spent by that touch,
because redemption happens post-auth. **The residual risk lives entirely in the post-auth step and is
unmeasured. Do not record this as cleared.**

Minor, same test: both clients print "Signing you in with GitHub, opening your browser" even with
`--no-browser`. The flag works — the URL is printed as documented — only the narration contradicts it.

---

## D-039 — the inversion arm must differ from the AUTHOR's family, not merely from Claude · RULING

**Operator ruling, 2026-08-03:** *"If it was written by Codex have a Claude Op. 5 agent review it,
not Gemini."*

### What changes

D-036 named the permitted pairing as one exact-review arm (Codex or Claude) plus one inversion arm
from *"a different family (Google Gemini via `agy`, or Kimi K3 via Pi)"*. Read literally, that fixed
the inversion arm to a short list of vendors regardless of who wrote the code.

**The governing property is independence from the AUTHOR, not membership of a particular vendor
list.** Most of v0.1.5 was written by Codex workers. For Codex-authored code, a **Claude Opus 5 arm
is a genuine cross-family inversion** and is now the required one. Gemini is not to be used as the
inversion arm for Codex-authored code.

The two-arm rule itself is unchanged and still must not erode. This narrows *which* arm is
acceptable; it does not permit reviewing with one.

### Why the literal reading was actively worse, measured on this release

Gemini ran as the inversion arm at full delta scope and returned a substantive ~40 KB review. Every
one of its three most serious findings was traced to source and refuted (see
`docs/evidence/2026-08-02-v015-execution/stage7b-two-arm-delta-review.md`).

**Its file:line citations were fabricated.** It cited `src/cloud/delivery.ts:125-188` for a method
that is type declarations at that range, and `src/listener/delivery-journal.ts:790-835` for a function
that is lease/ACK code there. The prose described real code shapes; the coordinates pointed elsewhere.

That failure mode is worse than a weak review in both directions at once: a reviewer who *trusts* the
coordinates edits working code, and a reviewer who *spot-checks only* the coordinates discards a
review that was partly legitimate. A gate whose output must itself be re-verified line by line is
doing a fraction of the work it appears to do.

### Second, independent reason the ruling is right

The arm nearly could not run at all. Measured 2026-08-03: Kimi via Pi has **no API key configured**;
Grok remains credit-exhausted per D-036; and `agy` **refused two successive security-framed prompts**
before accepting a correctness framing, then failed again on headless tool permissions. Of the two
arms D-036 permits, one was unusable and the other was one refusal away from producing a false
"release blocked".

A gate that depends on a single external vendor's willingness to perform the task is a gate with a
single point of failure that is **outside our control and gives no warning**. Claude Opus 5 as the
inversion arm for Codex-authored code removes that dependency for the common case.

### Standing method note this produced

`agy` answered a neutral control prompt with `ARM ALIVE` while refusing the review. **That probe is
the only thing that distinguished a declining arm from a dead command** — both produce an empty
result, and the honest-looking conclusion from silence alone ("the arm is down, we are blocked") was
the wrong one. Any arm returning nothing must be probed with a trivial prompt before its silence is
interpreted.

### Not established

Whether Gemini's remaining lower-severity findings contain anything real; they were read and
triaged in severity order, and only the top three were traced to source in full. Whether a Claude arm
carries its own systematic blind spots on Codex-authored code — that is the obvious risk of this
ruling and it is **not** measured. The ruling trades a known, measured failure mode for an unmeasured
one, which is a reasonable trade only while the two-arm rule stands.

---

## D-040 — a stop during processing permanently bricks the listener after the lease expires · SHIP-BLOCKER

**Found 2026-08-03 by the independent Claude Opus 5 inversion arm mandated by D-039, on the frozen
release SHA `175f894`, during Stage 7b. Severity CRITICAL. v0.1.5 must not ship with this.**

Gemini, the arm D-036 named, reviewed the same delta at the same scope and **did not find it**. D-039
was ruled hours earlier for unrelated reasons; it paid for itself immediately.

### The failure

Stop a listener while it is working a signal, then restart more than 15 minutes later (the lease TTL).
`listen start` reports success and then dies, permanently, on every subsequent start.

### The chain — eleven links, each verified by the Lead against the frozen tree

1. The `leased` phase spans the **entire model turn**, so a listener stopped during ordinary work is
   very likely to be in it. This is not an edge case.
2. The cancel path sets `stop = { reason: "cancelled" }` (`runtime.ts:1032`, `:1036`) and **never
   calls `clearActive`**. Decisive check: the last `clearActive` in the file is line **997**; the
   cancel handlers begin at **1028** and the `finally` at **1145** only cancels and closes the model.
3. The journal restores `active` verbatim on restart, **including the stored instance id**
   (`delivery-journal.ts:1028-1034`).
4. The runtime therefore replays the **stored** `claimCommandId` (`delivery-journal.ts:842`).
5. Idempotency does its job: the server returns the **stored ledger row** for that command id
   (`command/index.ts:5545-5578`, `durable-delivery.ts:423`) — carrying the original, now-past
   `leased_until`.
6. The client parses that response and calls `checkedLiveLease(leasedUntil, now)` unconditionally
   (`delivery.ts:400`), which **rejects the client's own replay** and raises `DeliveryProtocolError`.
7. `DeliveryProtocolError` is **not retryable** — `isRetryableDeliveryError` admits only
   `DeliveryTransportError` and `DeliveryHttpError` 429/5xx (`runtime.ts:204-208`).
8. It is **not credential loss** either — that predicate admits only `DeliveryHttpError` 401/403
   (`runtime.ts:200-202`).
9. So it falls to `stop = { reason: "fatal" }` (`runtime.ts:1038`).
10. **Repair logic for exactly this state exists and is unreachable.** The block that clears a stale
    `leased` recovery is gated `if (deliveryMode === "cursor_fallback" && recovery !== null)`
    (`runtime.ts:766`). In `durable_claim` mode it can never run.
11. **v0.1.5 is always in `durable_claim`**: `return deliveryClaim && deliveryAck ? "durable_claim" :
    "cursor_fallback"` (`runtime.ts:367`), and the same function *throws* if the configuration is
    absent — so a v0.1.5 server, which advertises both, always yields `durable_claim`.

`ready` fires before this block, which is why `listen start` **reports success and then dies** — the
worst shape for an operator, because the CLI says it worked.

### Why every gate we have missed it

Root suite 376/376, p1-cli 143/143, p1-local 4/4, p1-server 69/69, all green on this SHA. The bug
needs a **stop during the leased phase plus a >15-minute wall-clock gap plus a restart**. Nothing in
the suites composes those three, and the Stage 7 causal-control register's stale-lease control
exercises the *server's* requeue, not the *client's* refusal to accept its own replay.

**This is the strongest available argument that a green suite is not a substitute for an independent
reader.** Twenty-two causal controls and five green gates did not see it; one arm reading the code did.

### The fix, and what it costs

Small in code: make the existing repair block reachable from `durable_claim`. **Not** small in
process — it changes the release SHA, so per D-036/D-039 the full Stage 7 gate and **both** review
arms rerun on the replacement SHA. There is no version of this that ships `175f894`.

### An unplanned control that worked

The push to `main` was refused by the `swarm-1human-main` ruleset (`required_linear_history`, zero
bypass actors) roughly an hour before this finding landed. That rule exists to keep a swarm of agents
from pushing to `main` unattended; it was created for a different reason and it stopped a bricking
defect from reaching `main`. Recorded because it is the clearest evidence in this repo that the
one-human control earns its friction.

### Not established

The Opus arm's second self-verified finding — that the OpenCode worker child runs its whole life with
a deleted cwd (`opencode-model.ts:450/465/511`, `finally` at `:536-538`) — is **MAJOR and not yet
verified by the Lead**. Four further MAJORs and several MINORs in that review came from delegated
sub-audits and are **second-hand**; the arm flagged them as needing confirmation and they have not
been confirmed. None of them are cleared.
