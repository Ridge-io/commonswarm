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

**Closed by:** `v0.1.0`, commit `6aec33d`. Verified by installing from the live site and
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

**Closed by:** `v0.1.1`, commit `4f3bd5b`. Message now keys off the stated expiry alone.

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

- **The archive notice is wording** — split out, ruled, and **MERGED to `main` at `08a177e`**
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

**Closed by `eae6acb`, merged to `main` 2026-07-29**, after three review rounds — each of
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

**Closed by D-004's merge (`f547909`) alone.** The citation previously read "by D-004/D-011",
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

**Closed by `eae6acb`, merged to `main` 2026-07-29.** Verified after the merge:
`grep -c assertedCauses` on main → **0**; `grep -c CAUSE_BY_CODE` → **4**. The regex classifier
is gone from the shipped tree, not merely from a branch.

The paragraph below is kept, marked dead, because it was true for several hours and the entry
that recorded it was itself the register's live untruth.

★ **(WAS TRUE UNTIL `eae6acb`) THE DEFECT WAS ON `main`.** Measured 2026-07-29 after this entry was first
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
Final SHA `eae6acb` after two further review rounds — Mica broke the hand-kept mirror by adding
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

## D-019 — No test file in this repo is ever typechecked · FIXED

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

**FIXED, and the heading was stale until 2026-08-10** — the fix landed as
`npm run check:tests` (`tsc -p tsconfig.tests.json`) and nobody came back to the entry. Found
while answering an operator question about launch readiness, which is a bad way to find it: the
entry was being counted as an open defect in a list going to the operator.

**Measured with a positive control on the same invocation**, because a green typecheck proves
nothing on its own: a deliberate `const _typeProbe: number = "not a number"` appended to
`tests/p1-cli/f6-workspace-vocabulary.test.ts` produced exactly **1** `error TS`, and removing it
returned clean. Two different answers, so the instrument discriminates.

This is the **fifth** entry found fixed-while-marked-OPEN. The hygiene note at the end of this
file already warns to check a heading against its body before dispatching anyone; that was not
enough, because a stale heading is invisible to anyone who does not happen to know the fix
landed. **A count of open defects taken from headings is not a measurement.**

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

Mica approved D-011 with a stated precondition: *"origin/main has advanced from `2444435` to
`08e26c4` in DEFECT-REGISTER docs only; a byte-identical base move preserves verdict."*

By the time the merge came round, **that precondition was false** — D-006(b) had landed,
advancing `main` with code (`src/cli.ts`, `src/cloud/workspaces.ts`, and a test file). Cinder
noticed, proved the underlying property held anyway, and **refused to resolve it**: *"that
distinction is yours to rule on rather than mine to quietly resolve in my own favour — I am the
interested party."*

**Verified by the advisor rather than taken:**

```
literal precondition   docs-only advance?      FALSE — three code files moved
the property it stood for:
  git diff 2444435 e66be08   vs   git diff c7a9a81 eae6acb   ->  byte-identical
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

## D-023 — The home page tells every visitor signup is switched off. It is on. · FIXED

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

**FIXED, heading stale until 2026-08-10.** Measured against the DEPLOYED page, not the source,
with both arms on the same invocation:

```
curl -s https://commonswarm.com | grep -icE 'invite-only|not open|waiting list|waitlist'   -> 0
curl -s https://commonswarm.com | grep -icE 'start|sign up|create'                          -> 6
curl -s -o /dev/null -w '%{http_code}' https://commonswarm.com/start                        -> 200
```

The must-be-absent grep returns 0 and the must-be-present control returns 6, so the zero is a
result rather than a broken probe. Same discovery route as D-019 above — found while counting
open defects for an operator question.

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

**Found by:** Cinder (codex) · **Verified by:** Lead6, source read at `ace6da5` · **Severity:** P2
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
three documents (merged `d18df4b`) and from DonePanel (Juniper's L2). Member-removal copy is in
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

**Superseded integration-history statement — DEAD after browser lane `c1f3e36b`:**
~~Browser create-workspace, CLI login, accept-link, and workspace-list reads remain separate
defects and are not fixed or claimed here.~~

**Current integrated truth:** the separate landed browser lane at
`e7537289a5a0f6d4b034764dbdf2caa13480610b` bounds browser create-workspace, signup membership,
and dashboard feed reads. Those browser outcomes are not evidence claimed by this signals lane.
CLI login, accept-link, and workspace-list reads remain open and outside the signals-only scope.

**D-034 content reconciliation (measured 2026-07-30, Onyx hosted-remove-member-final):** orphan
browser candidate `4be37fc` and primary-clone `main` carry byte-identical
`site/src/lib/commonswarm.ts` and `tests/p1-cli/browser-fetch-deadline.test.ts` relative to the
landed browser runtime path; the browser lane landed via `c1f3e36` with later evidence
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

## D-038 — the product emits a link its own CLI cannot parse, and blames the payload · FIXED

> ### ⚠ FIXED, AND THIS ENTRY CARRIED IT AS OPEN
>
> Measured 2026-08-09 against shipped `0.1.9`. The CLI now parses the **web** form the site
> emits, identically to the `cswarm://` form:
>
> ```
> https://commonswarm.com/invite#invite=<payload>   -> "You're accepting an invitation to …"
> cswarm://accept/<payload>            (control)    -> identical output
> https://commonswarm.com/invite#invite=NOTVALID    -> "invite link payload is not valid JSON"
> ```
>
> The third line is the control: the parser still refuses a bad payload, so the first two are not
> passing because parsing was abandoned. `cswarm --help` documents both forms.
>
> **The mismatch this entry describes no longer exists**, so the gap between "the link you were
> sent" and "the command the README documents" is closed.
>
> **This is the fourth entry found stale in one day** — after D-050, D-062 and D-063. See the note
> at the end of this file.

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
release SHA `6b9117b`, during Stage 7b. Severity CRITICAL. v0.1.5 must not ship with this.**

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
arms rerun on the replacement SHA. There is no version of this that ships `6b9117b`.

### An unplanned control that worked

The push to `main` was refused by the `swarm-1human-main` ruleset (`required_linear_history`, zero
bypass actors) roughly an hour before this finding landed. That rule exists to keep a swarm of agents
from pushing to `main` unattended; it was created for a different reason and it stopped a bricking
defect from reaching `main`. Recorded because it is the clearest evidence in this repo that the
one-human control earns its friction.

### Companion defects — ALL FOUR NOW VERIFIED BY THE LEAD (2026-08-03)

~~"Four further MAJORs came from delegated sub-audits and are second-hand… none of them are
cleared."~~ **Superseded — every one was traced to source and confirmed:**

- **MAJOR-1 — the OpenCode worker child runs its entire life with an unlinked cwd. CONFIRMED.**
  `opencode-model.ts:450` mkdtemps `canaryCwd`; `:465` opens the session with `cwd: canaryCwd`, which
  `host/opencode.ts` passes to `spawn` as the **OS process cwd**; `:511` calls `openWorkCwd`, but
  `host/session.ts:296-303` only assigns `this.cwd` and re-issues `newSession()` — **no respawn, no
  chdir**; and the `finally` at `:536-538` `rm -rf`s the directory **on the success path**. The
  child's cwd is unlinked for its whole life. The defect is verified; the downstream consequence
  (relative paths resolving at `/`) is inferred POSIX behaviour.

- **MAJOR-3 — an unclassifiable failure code is a second, easier route into D-040's brick.
  CONFIRMED, and more severe than reported.** `runtime.ts:283` throws
  `"listener terminal effect has an unknown failure classification"` when `failureCode` matches
  neither `/prompt|acp|child|host|session/i` nor `/post|http_|transport|reply_body/i` nor the three
  literals. `engine.ts:179-183` derives that code as `error.name.toLowerCase()`, so **any plain
  `Error` yields `"error"`** and a `TypeError` yields `"typeerror"` — neither matches. The throw is a
  plain `Error`, so it is neither retryable nor credential loss and lands on `reason: "fatal"` with
  the journal still at `leased`. **This reaches the identical permanent-brick state without requiring
  a stop or a 15-minute wait** — one unclassified error is enough. It is arguably the more likely
  trigger of the two.

- **MAJOR-4 — mid-run lease expiry is reported as credential loss. CONFIRMED.** The `staleUnavailable`
  escape (`runtime.ts:608-613`) requires `startupAckPending && active.ack.commandId ===
  startupAckCommandId` — the ACK must have been pending **at process start**. The identical condition
  arising mid-run misses it and falls to `isDeliveryCredentialLoss` (`:198-201`), which is true for
  **any** 403. The runtime stops with `reason: "credential"` and the operator is told to
  re-authenticate a credential that is perfectly valid.

- **MAJOR-2 — OpenCode cross-owner isolation rests on one mechanism where Grok uses three. CONFIRMED.**
  `host/grok.ts:187-200` sets `GROK_MEMORY=0`, `GROK_SUBAGENTS=0`, `GROK_LSP_TOOLS=0`,
  `GROK_WRITE_FILE=0`, `GROK_WEB_FETCH=0` plus `GROK_SANDBOX`. `buildOpenCodeChildEnv`
  (`host/opencode.ts:479`) sets **no equivalent**, so cross-owner isolation depends solely on the ACP
  forced-ask path. A defence-in-depth regression, not a demonstrated leak — the forced-ask map does
  enumerate every tool plus `*` and fails closed.

### Still not established

The delegated MINORs beyond m-1/m-2/m-3 were not individually traced. m-1 (`durable-delivery.ts:424`
returns the caller's `sender_owner_relation` and discards the computed one) is **latent, not live**:
`owner_user_id` is never updated anywhere, so no ownership transfer exists to exploit it. It becomes a
real cross-owner hole the day such a feature ships.

---

## D-041 — the D-040 fix introduces a new brick and leaves D-040's shape in a sibling state · SHIP-BLOCKER

**Found 2026-08-04 by a fresh Claude Opus 5 arm on `9591466`, verified by the Lead. The candidate must
not merge.** This is the **third** consecutive round in which the durable-delivery runtime hid a
permanent-brick defect from a fully green gate (390/390 here).

### D-041a — the rescue code can itself brick the listener · MAJOR

`runtime.ts:820` `await options.store.read(recovery.signalId)` sits **one line outside** the `try`
that opens at `:826`, and **no `catch` exists anywhere between `:686` and `:1226`** — verified by
enumerating catch sites across that span and finding none.

In the frozen build this read was gated to `cursor_fallback` and therefore **never executed in
production**. The D-040 fix promoted it to run on **every restart with a `leased` journal**. A
malformed or unreadable effect file now throws uncaught, killing the runtime **before** the stale-lease
clear at `:855-863` can run.

**The code written to rescue the listener from a permanent brick can permanently brick the listener.**

### D-041b — `ack_pending` keeps the exact dead-mode gate that WAS D-040 · MAJOR

The fix made `leased` recoverable and left `ack_pending` untouched. At `:788`:

```
if (recovery?.phase === "ack_pending") {
  if (page.capabilities.deliveryAck) { … continue; }   // always taken
  … clearActive escape at :802-813 …                    // dead in the shipped mode
```

`classifyDeliveryMode` (`:382`) returns `durable_claim` **only when `deliveryAck` is advertised**, so
the guard is always true and the only journal-clearing escape is **dead code in the only mode we
ship** — bit for bit the defect D-040 described. A fatal from `sendPreparedAck` leaves the journal at
`ack_pending` permanently; `supervisor.ts:283-296` does not auto-retry.

Reachability is lower than D-040's: the arm could not construct the 409 `delivery_ack_conflict`
(`:678`), and the verify-throw at `:634` needs loss of an effect file that never prunes. **Lower
reachability is not absence, and D-040 was also "hard to hit" right up until it was described.**

### What the arm cleared, which matters for scoping the next round

- **No way to ACK the wrong signal and no double-ACK.** The `signalFingerprint` binding works.
- **The relaxed journal parser is tight** — four crafted malformed-record probes were all rejected.
- **The MAJOR-4 fix does not swallow genuine auth failures** — verified end to end.
- **C-1 recovery itself is sound.**
- **The downgrade brick is confirmed by measurement** and is worse than reasoned: it fails inside
  `openListenerDeliveryJournal`, so a downgraded frozen build **cannot start** to clear the journal it
  cannot parse. Any rollback plan must account for this.

### The pattern, which is now the more important finding

Three rounds, three permanent-brick defects, **all three invisible to a fully green gate** — 376/376,
then 390/390. Each was found by a human-directed independent reader and none by any instrument we own.
The second round's defect was *created by the fix for the first*.

**A green suite on this subsystem carries close to zero information.** The next round must not be
"fix and re-run the suite". At minimum it needs the completed live-fire drill (real process, real
`kill -9`, real expired lease) and an enumeration-based argument — *every* persisted phase, *every*
fatal site, reachable-from-restart or not — rather than a reaction to whatever the last reviewer
happened to name.

---

## D-042 — a mismatched effect bricks the listener; fourth consecutive round, identical shape · SHIP-BLOCKER

**Found 2026-08-04 by a fresh Claude Opus 5 inversion arm on `810a005`, verified by the Lead.
`810a005` must not merge.** Gate at that SHA: **395/395**, p1-cli 143/143, p1-local 4/4, p1-server
69/69, site 113/113, build/check:tests/check:edge all 0, bundle undirtied. **All green, and it bricks.**

### The defect

`runtime.ts:1082-1084`:

```ts
if (existing !== null && !sameEffectSignal(existing, signal)) {
  throw new Error("stored listener effect does not match the authoritative delivery");
}
```

A bare throw, caught only at `:1165` and turned fatal at `:1173`.

**The D-041 repair cannot help**, because it fires only from a `catch` on the read
(`runtime.ts:473-478`): `try { return await store.read(signal.id); } catch { … }`. A read that
**succeeds** returns the record verbatim, so a *readable but mismatched* effect never reaches the
repair. The repair addresses unreadable effects; this is the readable case.

**And the graceful handler already exists.** `engine.ts:267-274` handles the identical condition
properly — `signal_integrity_mismatch` → terminal, ACKable, recoverable — **and is unreachable in
`durable_claim`, the only mode v0.1.5 ships.**

Cycle: claim → effect stored with relation R₁ → crash → the relation changes (every server `CASE`
joins `AND author.revoked_at IS NULL`, so **revoking an author agent** flips `cross_owner` → `unknown`)
→ restart → the stale-lease clear **succeeds** → server requeues → `:1082` throws → fatal → repeats
every ~15.5 minutes, emitting `ready` each time.

**The claimed exit fires correctly and the requeue re-arms the trap.** A recovery that works is not
the same as a recovery that converges.

### The shape, four times running

| Round | Defect | Green gate at the time |
|---|---|---|
| 1 | D-040 — stale lease unrecoverable; repair gated to `cursor_fallback` | 376/376 |
| 2 | D-041a — the D-040 repair's own read could throw uncaught | 390/390 |
| 2 | D-041b — `ack_pending` kept D-040's dead-mode gate | 390/390 |
| 3 | **D-042 — mismatched effect; graceful handler lives in `engine.ts`, unreachable in `durable_claim`** | **395/395** |

**The same defect three of four times: a correct repair exists but is unreachable in the only mode we
ship.** This is not four unlucky bugs. It is one architectural fact — `durable_claim` was built as a
parallel path beside `cursor_fallback` and did not inherit its recovery semantics — surfacing wherever
someone happens to look.

### What the arm confirmed sound, so round 5 is scoped rather than restarted

Both D-041 repairs are correct: all three repair call sites are inside `try`, and `:828-830` computes
the horizon before the `deliveryAck` guard. `Date.parse` cannot yield NaN (parser `:494-499`). MAJOR-3
is fixed at `:284`. Out-of-set relations are closed by `checkedRelation`. **26 of the enumeration's 27
fatal-site verdicts were independently agreed**, every line number verified, and the phase union
independently confirmed closed. The single disagreement is row `:1173`, whose justification was scoped
to a still-*unreadable* effect and does not cover the *readable-but-mismatched* case.

**The enumeration was right about almost everything and still missed this**, because its own framing
inherited the repair's assumption.

### The consequence for shipping

`supabase/functions/read/index.ts:64-65` advertises `delivery_claim: 1, delivery_ack: 1`, and
`runtime.ts` selects `durable_claim` only when both are advertised. **Withholding the `read`
function deploy leaves every 0.1.5 client in `cursor_fallback`** — the mode production has run for its
entire life, whose `engine.ts` path handles this defect class gracefully. All four bricks become
unreachable with no code change and no new SHA.

Rollback to 0.1.4 also remains available: 0.1.4 has **no** `delivery-journal.ts`, so it cannot fail to
parse a journal. The measured no-rollback constraint applies only between frozen and fixed builds.

---

## D-043 — an expired refresh token dead-ends every command with no remediation · FIXED in v0.1.8

> **RESTORED 2026-08-07 after being destroyed by a branch prune.** This entry existed only on a
> branch deleted during repo cleanup; main's register had a hole at D-043 between D-042 and
> D-044, and the entry survived solely in an unreachable commit that the next `gc` would have
> removed. Recovered from `59a8ab6`. The prune was audited at commit level and at content level
> for `docs/` paths, and this still slipped: the branch's register file was a MODIFIED path, not
> an added one, so a "files on the branch that main lacks" check could not see it. **A
> content-level path check is not a content-level diff.**
>
> **FIXED in v0.1.8**, which is why the original heading below reads OPEN: `cswarm logout` now
> clears a positively-recognised dead credential instead of throwing, `cswarm logout --local`
> clears the device without contacting the server, and the CLI names the next step rather than
> forwarding the provider's wording. See `docs/release/0.1.8.md` and
> `docs/evidence/2026-08-05-logout-wedge/BLOCKED.md`.

### Original entry, as filed 2026-08-04

Found 2026-08-04 against **production v0.1.5**, on a machine whose saved session had expired.

Every authenticated command returns:

```
cswarm: session refresh failed: Invalid Refresh Token: Refresh Token Not Found
```

and nothing else. It does not say the session expired in plain terms, does not name `cswarm login`,
and offers no next step. Reproduced on `feed` and on `new`; it is the shared auth path, so it affects
every authenticated command.

**The state is recoverable** — `cswarm login` works and prints its authorize URL — so this is a
signposting defect, not a lockout. But a user cannot be expected to infer the fix from *"Invalid
Refresh Token: Refresh Token Not Found"*, which is the upstream Supabase string passed through
verbatim.

**This is the same family as QA-010**, the MAJOR fixed in this release: a dead session that the UI
would not admit to. That fix taught the *web* client to say so. The CLI still passes the raw provider
error through.

Against `AGENTS.md` § *Writing for users* — *"CLI output tells the user what just happened, what is now
true, and what happens next, so they never have to check whether it worked"* — this line satisfies
none of the three.

Suggested wording, not yet implemented:

```
cswarm: your session expired. Run `cswarm login` to sign in again.
```

**Not established:** whether the same passthrough occurs for other Supabase auth failures (revoked
token, deleted user, rotated project keys), and whether the listener's long-running path surfaces it
any better. Only the expired-refresh-token case was reproduced.

---

## D-044 — cross-owner local sandboxing is retired; our lane is the CommonSwarm authority model · RULING

**Operator ruling, 2026-08-04:**

> "Relax it completely — the only thing we should control is who can write what in the CommonSwarm
> system. Users' agents can do whatever they want on their own local devices. We can deliver the
> messages or payloads with warnings attached perhaps, so that we can try to steer agents to know where
> these messages come from and not to do anything destructive without the operator's explicit
> confirmation. But I think we should generally stay in our lane, at least initially."

### The line this draws

| Layer | Who controls it |
|---|---|
| **Who may read and write what in CommonSwarm** — workspaces, membership, directed-signal visibility, agent principals, `sender_owner_relation` | **Us. Enforced server-side. Unchanged.** |
| **What an agent does on its operator's own machine** | **The operator.** Not our business. |

The server-side boundary is **not** relaxed by this ruling and must not be. It was proven on production
the same day: a cross-owner agent credential got `HTTP 403 forbidden` on write and an empty read
against another owner's workspace, while the human behind that agent — a member there — saw all 12
signals. An agent credential does not inherit its operator's membership, and that stays true.

What is retired is the **local execution sandbox**: the isolated temporary home, strict sandbox, empty
cwd, and the fifteen-plus `*_ENABLED=0` kill-switches applied to cross-owner turns
(`src/host/grok.ts:168-195`, `src/listener/grok-model.ts:152` `promptIsolated`).

### What replaces it

Provenance carried on the delivery: the receiving agent is told **who sent this, under which owner
relation**, and is steered to seek operator confirmation before destructive action.

### The caveat, recorded once and not relitigated

**A warning in a payload is advisory, not a control.** It is text arriving in the same channel as the
untrusted message, so a sufficiently adversarial sender can address it directly. The sandbox was an
enforcement boundary; provenance is a hint. This ruling trades an enforced local boundary for a
cooperative one.

That trade is defensible on its own terms — the operator's machine is the operator's, and a
coordination service that quietly disables its users' tooling is doing something they did not ask for
— and the *decision* is the operator's. It is written down so that if a confused-deputy incident ever
occurs, the record shows the boundary was removed deliberately, with the mechanism understood, rather
than eroded by accident. That is the whole reason this entry exists.

### Also fixed by this ruling — the case that was never cross-owner

`disableCmuxHooks: true` is passed on **both** paths (`grok-model.ts:134` and `:163`), so cmux
integration hooks were disabled even for **same-owner** work — an operator's own agent doing their own
task, with their config altered for our convenience. Rationale recorded at `cli.ts:2601`: *"Same-owner
Grok workers may load ambient user hooks outside CommonSwarm's ACP permission boundary."* Under this
ruling that is out of our lane too.

### Consequence: the Claude Code adapter is unblocked

`docs/design/2026-08-04-LISTENER-PROVIDER-GAP.md` named one load-bearing unknown before adopting
`@agentclientprotocol/claude-agent-acp`: whether cross-owner tool restriction could be enforced through
the bridge. **That question is now moot** — we are not restricting tools. The adapter becomes a
straightforward spawn-and-speak-ACP job, and D-041's MAJOR-2 (OpenCode lacking Grok's kill-switch
surface) stops being a defence-in-depth regression, because there is no longer a defence to regress
from.

### The sequencing argument, which is the reason this is right now

Operator, same ruling: *"We can always restrict things more once we even get a working 'open' version
of this."*

That is the part that makes the trade sound rather than merely permissible. The asymmetry:

- **Restrictions can be added later.** Tightening a boundary breaks capability that people had, which
  is unpleasant but tractable, and every restriction we might add is still available to us.
- **A product nobody can connect an agent to cannot be tightened into usefulness.** Measured the same
  day on a second machine: **no installed host qualified** — grok below its pin and out of credit,
  opencode below its pin, Claude Code current, funded, and refused. The connect path was unreachable.

Sandboxing that nothing can run through is not a security property; it is zero adoption with a
security-shaped explanation. **We do not yet have a working open version, so we are not in a position
to be trading capability for enforcement.** Get agents connecting across owners, learn what the real
abuse looks like, then restrict against what is actually observed rather than what was imagined.

This is a **starting point with a known direction of travel**, not an endpoint. Anyone reading this
later should treat re-tightening as expected — the entry exists so that when it happens, it is a
deliberate second decision informed by evidence, not a rediscovery of a boundary nobody knew had been
removed.

### Not established

Whether ACP's own permission-request path (`session/request_permission`) should still force-ask on
cross-owner turns. It is a *host*-mediated prompt to the operator rather than a capability we strip,
so it may sit on the correct side of the line — but the ruling did not address it and it has not been
decided. Do not remove it as part of implementing this without a separate decision.

---

## D-045 — the mismatch brick reaches the CURSOR path, so it is live in production today · SHIP-BLOCKER

**Found 2026-08-04 by the Fable planning review; chain verified by the Lead. This corrects a claim I
made repeatedly and acted on.**

### The correction

~~"Withholding the `read` function leaves every client in `cursor_fallback`, whose `engine.ts` path
handles this defect class gracefully. All four bricks become unreachable with no code change."~~
**Dead.** That is true for **asks**. It is **false for notes**.

I checked that the durable path had a graceful counterpart and did not check whether notes had one at
all. The hedge is real and still worth having — it does close D-040, D-041a, D-041b and D-042's
durable sites — but it does **not** make the mismatch class unreachable, and I said that it did.

### The chain, measured on `main` at `891c158`

1. `observeFallbackNote` (`runtime.ts:446`) throws when a stored effect is readable but does not match:
   `!sameEffectSignal(existing, signal) || existing.state !== "observed"` → `throw new Error("stored
   listener effect does not match the direct note")` (`:453-455`).
2. It is called at **`:1231`**, inside `if (signal.kind === "note")`.
3. **That call site is on the cursor path.** Brace-depth computed, not eyeballed: the
   `if (deliveryMode === "durable_claim")` block opens at **957** and closes at **1221**. Line 1231 is
   **outside** it and therefore runs in the mode production ships.
4. The throw is caught at `:1243` and becomes `stop = { reason: "fatal" }` (`:1244`).
5. **Notes have no graceful path in either mode.** `engine.ts` contains `integrityMatches` and
   `signal_integrity_mismatch` for asks and **zero** occurrences of `"note"` — so the rescue that saves
   an ask does not exist for a note.

### The trigger, which is ordinary

`sameEffectSignal` (`:394-403`) compares `senderOwnerRelation` along with id, kind, body and until. So
a note a listener already observed becomes a mismatch **when the sender's owner relation changes** —
for example when the author agent is revoked, which flips `cross_owner` to `unknown`.

Fallback rescans from `after = null` each cycle, so the listener meets the same note again and dies
again. This is not a one-shot.

### Severity, stated honestly

Reachable in production **today**, on v0.1.5, without enabling anything. It requires a listener that
has already observed a note, a subsequent owner-relation change for that note's sender, and the note
still inside the read window. That is a conjunction, not a certainty — but every element is ordinary
operation, and revoking an agent is a routine administrative act.

**Exposure is limited by fleet composition, not by design.** Whoever is running a v0.1.5 listener is
exposed; today that is us.

### What this says about the method

The hedge was chosen because `cursor_fallback` is *"the mode production has used for its entire life"*
and was assumed safe by longevity. **Longevity is not a proof.** The graceful ask handler was verified;
the note path was never asked about. A fifth defect of the same family — an effect disagreement treated
as an exception rather than as data — was sitting in the path chosen precisely to avoid that family.

**This is the fifth. Four of five share one shape.** The class framing is now harder to dismiss as a
narrative fitted after the fact, which is exactly the question put to the cross-family arm.

### Not established

The read-window duration that bounds how long a poisoned note keeps recurring. Whether the same
conjunction can arise from a relation change other than revocation. Whether any listener outside this
project is running v0.1.5.


---

## D-046 — root cause of the mismatch class: a mutable value is treated as immutable identity · RULING

Two review arms were run on D-042: a Fable planning arm and a **cross-family Codex inversion arm**.
They **disagreed on the fix**, and the disagreement was the point of running both.

### What the Codex arm refuted, verified by the Lead

My framing — *"a correct repair exists and is merely unreachable in the shipped mode"* — was the basis
for the proposed fix: delete the durable pre-checks and let `engine.process` handle the mismatch, since
it already produces a terminal, ACKable `signal_integrity_mismatch`. Fable's plan recommended exactly
that.

**It would not work, and the code says so plainly.** `engine.ts:342-348` writes
`{ ...record, state: "failed", failureCode: "signal_integrity_mismatch" }` — it **spreads the old
record**, preserving the stale `askBody`, `askUntil` and `senderOwnerRelation`. The durable runtime
then rereads at `runtime.ts:1195-1197`, calls `sameEffectSignal` again, and throws *"terminal listener
effect does not match the delivery"*, which becomes fatal at `:1212-1214`.

**The proposed fix moves the fatal stop from `:1185` to `:1213`.** It does not remove it. Verified
directly, not taken from the report.

### The actual root cause, which is better than the framing it replaces

`immutableSignalFingerprint` (`runtime.ts:405-419`) is named for immutability and carries the comment
*"Bind recovered effects to the immutable fields from the authoritative lease."* Its inputs are
`signalId`, `signalKind`, `body`, `until` — and **`senderOwnerRelation`**.

`senderOwnerRelation` is **not immutable**. It is recomputed from current author, principal and
membership rows on every fresh claim (`command/durable-delivery.ts:256-291`) and on every read
(`read/index.ts:341-374`). Revoking an author drops the join and the relation falls to `unknown`.

**We put a mutable, server-derived value inside something named and documented as immutable identity,
and then compared against it to decide whether a stored record is still valid.** That is the defect.
It is not four instances of one unreachable repair; it is one category error with several call sites.

### The class framing, corrected

- **D-040 and D-041b** genuinely do share the *"exit exists behind a condition the shipped mode makes
  false"* shape.
- **D-041a does not** — it was an I/O call outside its protecting `try`. Missing exception containment.
- **D-042 and D-045 do not either** — they are the mutable-provenance category error above.

~~"Three of four are the same defect."~~ ~~"Four of five share one shape."~~ **Both superseded.** The
honest statement is that **parallel durable and cursor paths duplicated recovery semantics**, and the
duplication is why one policy error surfaced at five call sites. That is a real architectural finding
and a weaker claim than the one I made twice.

### The fix this implies

A single shared reconciliation primitive, called from both paths, distinguishing four cases:
**immutable identity** (id, kind, body, until) · **mutable derived provenance**
(`senderOwnerRelation`) · **unreadable storage** · **readable but mismatched storage**.

Applied at **five** sites, not the three I named: `runtime.ts:454`, `:1095`, `:1113`, `:1127`, `:1197`.
**The last two are how a three-line patch appears to work and still bricks a branch later.**

Do **not** merge or redesign the two delivery loops in this release. This subsystem produced a new
brick on each of its last two repair rounds, and a control-flow refactor enlarges the state space
before any live-fire treatment arm has passed.

### Two further corrections from the same arm

**The brick is bounded, not infinite.** I described it as recurring every ~15 minutes forever. The
server terminalizes a delivery after ten claims (`durable-delivery.ts:175-198`, causal test at
`tests/p1-server/command.test.ts:6705-6760`). The real outcome is **bounded non-convergence plus
eventual data loss** — the listener stops, the supervisor does not restart it
(`supervisor.ts:270-312`), and the signal is eventually dropped as `delivery_attempts_exhausted`.
Severe, and not what I said.

**The enumeration counts fatal *assignments*, not fatal *causes*.** 27 operational
`reason: "fatal"` constructions, 27 table rows — so no construction is missing. But one catch can
represent several distinct failure states, and **an uncaught rejected `await` would contain no
`reason: "fatal"` at all** — precisely the search-shape blind spot D-041a exposed. Two verdicts fail
outright (`state-space-enumeration.md:103` and `:104`) and one is too broad (`:105`). The next
inventory must enumerate every explicit throw, every awaited operation that can reject, and every
returned fatal, then map each to its persisted phase.

### A test that must be inverted

`tests/listener-runtime.test.ts:1764-1822` currently **asserts the fatal outcome** — it locks in the
defect. It has to be inverted as part of the fix, not deleted.

### Method note

The Fable arm and I are both Claude. It caught what I missed (D-045, the cursor-path exposure) but
endorsed my fix framing. **Only the cross-family arm refuted the framing itself.** That is the
argument for D-039's pairing rule, restated from the other direction: a same-family reviewer found the
missing fact; a different-family reviewer found the wrong idea.


---

## D-047 — the `read` deploy is a coupled landmine; D-045's trigger is not live · RULING + FREEZE

Found by the Fable planning arm, verified by the Lead against the **downloaded production function**,
not the repo.

### Correction 1 — I said `read` was "not deployed". It is.

`read` **v6 is deployed and serving**, from 2026-07-31. What I withheld was the *newer* build. The
distinction matters because the safety property does not come from absence — it comes from **version
skew**. v6 predates `06b7c1a`, the commit that added `delivery_claim`/`delivery_ack`, so it advertises
neither and every client selects `cursor_fallback`.

`cursor_fallback` holds because an **old version is running**, not because nothing is.

### Correction 2 — D-045's trigger is NOT live in production

D-045 says revoking an author flips `sender_owner_relation` to `unknown`, so a previously-observed note
stops matching and bricks the listener. **That chain requires the repo's `read`, which is not
deployed.**

Measured on the downloaded production function:

```
deployed v6 :223   "…Do NOT filter author.revoked_at: a revoked…"   ← comment, and the code agrees
deployed v6        `AND author.revoked_at IS NULL`  → 0 occurrences
repo        :371   `AND author.revoked_at IS NULL`  → present
```

So under v6 the relation is **stable** across revocation, and the ordinary trigger does not fire.
D-045 was measured against **repo server code while reasoning about production**, which is the
"measure the artifact, not its name" rule broken in a way I did not notice: I verified the *client*
against production and the *server* against the checkout.

**D-045 is not withdrawn.** The client-side defect is real, the code is wrong, and rarer triggers
remain (principal-row deletion, owner mutation, readable local corruption). Its **severity drops from
"live in production today" to "latent until the next `read` deploy."**

### The finding that replaces it — the coupled deploy

**One `read` deploy does two independent things at once:**

1. **Advertises `delivery_claim` + `delivery_ack`**, flipping every live 0.1.5 listener from
   `cursor_fallback` into `durable_claim` — where D-040, D-041a, D-041b and D-042 all live.
2. **Changes relation semantics**, so every stored effect whose author has since been revoked or whose
   membership lapsed **mass-mismatches at once** — notes brick via `runtime.ts:454`, asks fail via
   `engine.ts:346`.

Not a sequence. Simultaneous, on one command, with no per-workspace lever.

### FREEZE — the control that actually holds

**No `read` function deploy until all of the following are true:**

1. The D-046 reconciliation fix has landed through the two-arm gate (D-036/D-039).
2. The state-space enumeration is re-issued to count fatal *causes* rather than *assignments*.
3. The live-fire drill's **treatment arm has passed** — it never has, on any build.
4. A per-workspace enablement lever exists, so the flip is not all-or-nothing.

**This freeze, not tonight's code fix, is what keeps the durable defects unreachable.** A one-site
patch to the cursor path does not make the durable path safe and must never be described as though it
does. Scope any claim to *"the cursor path cannot brick"*.

### Also corrected

My cited catch/fatal lines for the note path were **two off**: the catch is `runtime.ts:1239` and the
fatal assignment `:1240`, not `:1243`/`:1244`. The chain is otherwise as recorded — durable block
957-1221, note call `:1231`, throw `:454`.

### Not established

Whether the deployed `command` v16 matches the repo. Why the `capability` function POSTs 404 while
listed ACTIVE. The note read-window bound. None were checked.

---

## D-048 — an `ANTHROPIC_API_KEY` user gets an auth-less Claude child · OPEN

Measured 2026-08-05 against the real exported `sanitizeChildEnv` (`src/host/env.ts:44`):

```
ANTHROPIC_API_KEY survives: false
HOME survives:              true
```

`DENY_NAME_RE` (`:37-38`) matches `API_KEY`, so the key is stripped from every ACP child. That rule is
correct — it is what stops credentials leaking into spawned hosts — and it has a side effect nobody
priced.

**Keychain/OAuth users are fine**: `HOME` survives and carries their credential, which is why the
adapter spike passed. **A user authenticated by `ANTHROPIC_API_KEY` alone gets a child with no
credential at all.**

**Not established:** what that child actually does. It may fail at `initialize`, at `session/new`, or
mid-prompt, and the message may be the bridge's rather than ours. Until measured, we do not know
whether this presents as a legible "you are not signed in" or as an opaque crash several steps in.

That is the whole risk: the failure is guaranteed for that population and its *shape* is unknown.
`--provider claude` is now advertised in a shipped release, so this is reachable today.

**Fix direction, not yet decided:** detect the case before spawning and say so plainly, rather than
letting the child fail. Do **not** widen the sanitizer to pass the key through — that would break the
property the deny rule exists to protect.

---

## D-049 — ACP session mode is never set, so the permission canary rests on a default we do not control · SHIP-BLOCKER (shipped)

Found 2026-08-05 by **Sable** while spiking `@agentclientprotocol/codex-acp`, and it applies to the
**already-shipped** Claude provider in v0.1.6.

### Sable's measurement, on codex-acp 1.1.9

- `initialize` → `protocolVersion 1`; real `sanitizeChildEnv` 79 keys → 12, `HOME` survives; `session/new`
  and a tool-free prompt both succeed. All good.
- **`session/new` returns `currentModeId = "agent"`. In that mode a write canary emitted ZERO
  `session/request_permission` calls and simply created the file.**
- **Positive control on the same session:** `session/set_mode` → `read-only`, repeat the write → **1**
  permission request, and `reject_once` left the file absent.

So the host is capable of asking; the **default mode** decides whether it does. Sable stopped before
implementing, which was correct.

### It applies to the shipped Claude adapter

`grep set_mode src/host/*.ts src/listener/*.ts` → **0**. The adapter shipped in v0.1.6 **never sets a
mode**. It works today only because `claude-agent-acp` happens to default to
`currentModeId: "default"` — *"Manual: standard behavior, prompts"*.

**My spike saw a permission request because of that default, not because we asked for one.** I
verified the mechanism and never asked what governed it.

And `availableModes` includes **`auto` — "use a model classifier to approve/deny permission prompts"**.
A user or future release defaulting to `auto` makes our deny canary vacuous, silently, with the suite
green.

### Why this matters beyond one adapter

`enablePromptsAfterCanary` and the deny canary exist to prove **CommonSwarm controls tool
permissions**. Resting that proof on an unasserted host default means the canary can pass while
proving nothing — the same failure class as a repair that exists but is unreachable, which this
release has now produced five times.

### Fix

**Set the mode explicitly after `session/new`, for every ACP provider, and fail closed if it cannot be
set.** Do not rely on any host's default. Where a host exposes no mode API, that is a finding to
record, not a reason to assume the default is safe.

### Not established

Whether grok and opencode expose modes and what they default to — only claude and codex were measured.
Whether a user's Claude config can change the default mode without the adapter noticing.

---

## D-050 — the Claude adapter swallows a verified teardown failure and multiplies live bridge processes · MAJOR · **FIXED**

> ### ⚠ FIXED IN `9ba92e2`, AND THIS ENTRY CARRIED IT AS OPEN FOR DAYS
>
> Measured 2026-08-09. `src/listener/claude-model.ts` no longer discards the close error:
> `await worker.close().catch(() => undefined)` is now
> `try { await worker.close(); } finally { … }`, so `child_exit_timeout` escapes and no
> replacement worker opens. The Claude analogue test the Fix section asks for **exists**, is
> **named in `npm test`**, and passes:
>
> ```
> ✔ D-050: Claude close timeout is runtime-fatal before replacement opens
> ✔ D-050: Codex close timeout is runtime-fatal before replacement opens
> ```
>
> **Mutation-verified against the original defect**: restoring the exact
> `.catch(() => undefined)` swallow fails the Claude test and **only** that one — Codex keeps
> passing, since it carries its own fix.
>
> **The register and the resume file were both stale on this**, and the cost was not zero: the
> 2026-08-07 resume file lists D-050 under "STILL OWED", and on 2026-08-09 the Lead sent Wren to
> hunt for it on a second machine. Wren walked an `opencode` teardown — **a different code path
> from the one this entry describes** — found no orphan, and reported it as a third data point
> against a defect that had already been fixed in the Claude adapter.
>
> **Nothing here was re-derived from the fix; it was measured from the code and the gate.** The
> original entry is kept below unchanged, because its mechanism is the clearest description of
> what was wrong.

Found 2026-08-05 by **Plumb** (cross-family inversion arm) with a controlled reproduction. Every link
verified by the Lead against `main`. **Live in v0.1.6.**

### The chain

1. `src/host/transport.ts:69-70` converts a stdout end into `AcpChildExitError` **even if the process
   has not exited**.
2. The prompt catch calls `close()`.
3. `src/host/claude.ts:281-285` throws `child_exit_timeout` when SIGTERM **and** SIGKILL still produce
   no exit — a genuine "this process refuses to die" signal.
4. `src/listener/claude-model.ts:86` is `await worker.close().catch(() => undefined);` — **that signal is
   discarded**. Line 87 then clears the only handle to the process.
5. `src/listener/engine.ts:233-238` classifies the original `AcpChildExitError` as **retryable**, so the
   engine opens a replacement worker.

### Plumb's reproduction

Driven through `ClaudeListenerModel` + `ListenerEngine`: `retry_pending`, `retry_pending`, `failed`,
with **opens = 3, closes = 3**. Every close threw `child_exit_timeout`, and the persisted failure code
was `acpchildexiterror`.

**So the listener orphans live bridge processes, opens more, and records an ordinary signal failure.**
The operator sees a routine retry; the machine accumulates processes that survived a SIGKILL.

### Why it got here

I shipped the adapter **without either review arm** — I authored it and was disqualified, and I
released anyway. This is the first thing the review found. The suite was 429/429 throughout.

### Fix

Do not suppress the close error. Make `child_exit_timeout` escape the engine as a **runtime-fatal host
failure** so no replacement worker opens. Add the Claude analogue of
`tests/listener-opencode-model.test.ts:702-754`.

### What Plumb cleared, with positive controls

No `isolatedHome`, `mkdtemp`, `sweepStale` or `canaryCwd` in either Claude file — control found **17**
OpenCode matches, so the search worked. The installed 0.64.2 shim in `/opt/homebrew/bin` resolves to a
single absolute JS realpath, and a full open → `session/new` → close exited 0. Focused 31/31, root
429/429, p1-cli 149/149, `check:tests` 0. **No separate permanent-brick path found.**

### Not established

Behaviour against a real workspace signal (`lastSignalId`), the no-auth and `ANTHROPIC_API_KEY` paths
(D-048), and native Windows.

---

## D-051 — authenticated requests saturate a bounded resource, and our own retry loop feeds it · SHIP-BLOCKER (live)

Diagnosed 2026-08-05 by **Wren**, from the laptop, with a dose-response curve. This supersedes the
schema-skew hypothesis I accepted too quickly.

### The shape

**Failures are fast, not slow.** Twelve authenticated trials on `feed`:

```
successes: 0.554 0.616 0.958 0.583 0.524 0.576   mean ~0.63s
failures:  0.298 0.230 0.274 0.232 0.277         mean ~0.26s
```

Failures return in ~40% of a success's time. **Nothing clusters at 5s, 10s or 30s — there is no
timeout boundary in the data.** The server refuses almost immediately. One HTTP 503 also appeared.

**Failure rate scales with concurrency**, same credential throughout:

| concurrent | failed |
|---|---|
| 2 | 1/6 (17%) |
| 4 | 7/12 (58%) |
| 8 | 17/24 (71%) |

And the discriminator: **eight requests sequentially back-to-back all succeed; eight simultaneously,
7 of 8 fail.** So it is **not rate** — it is **simultaneity**. That rules out simple rate limiting.

**A bounded resource that rejects immediately at its ceiling instead of queueing** — the shape of a
connection pool at capacity. It explains why unauthenticated probes are perfectly stable (12/12, 6/6):
they never take a database connection. Everything authenticated does, which is why reads, writes **and
token mint** are all flaky together.

**A schema mismatch would fail 100%, not 50%. This is a saturation curve, not a correctness bug.**

### CORRECTION, 2026-08-05 — the failures are NOT connection exhaustion

~~"a bounded resource… the shape of a connection pool at capacity"~~ — **the mechanism is wrong,
though the concurrency correlation stands.**

Found by **Plumb** on the exact SHA, verified by the Lead against the **deployed** function:

`read/diagnostics.ts` sets `retryable: isRetryableErrorCode(code)`, and `RETRYABLE_CODES` explicitly
includes **`53300 too_many_connections`**, plus `57P03 cannot_connect_now`, `40001`, `40P01`, `55P03`,
`57014` and the connection codes.

**That classifier is deployed.** `diagnostics.ts` is present in the downloaded v6, with `53300` and
`retryable` in it (control: `workspace` appears 15 times, so the search works).

So **if these 500s were pool exhaustion the server would return `retryable: true`.** Wren measured
`false` on every failure, on both views, across workspaces. **Therefore the failing error is not a
connection code at all** — it is something unclassified that falls through to non-retryable.

**This is my third hypothesis for this bug and the second to be wrong.** Schema skew: refuted — the
migration never redefines the views v6 reads. Pool exhaustion: refuted — the server would have said so.
What survives is Wren's *measurement*: failures are fast, scale with simultaneity rather than rate, and
affect only authenticated paths. The cause is still unknown.

**And it changes the ruling's premise.** D-052 argues the server is "probably wrong" to send
`retryable: false` for a transient condition. That rested on the failure being saturation. If the error
is genuinely unclassified, **the server may be right** and honouring it is correct — which makes
bounded supervision more important, not less, because the receiver still must not die permanently on a
condition nobody has identified.

**The request ids Wren captured remain the only handle on the actual error.** Reading them needs
dashboard access — operator.

### SECOND CORRECTION, 2026-08-05 — the concurrency curve was confounded, and the baseline is the story

**Wren retracted its own headline finding**, including one it had already sent to another agent.

**Retraction 1 — a mechanism built on three rounds.** Wren reported one credential reused failing 92%
against 42% for four distinct, and built a row-contention mechanism on it. Six rounds gives **62% vs
58%**. The split was sampling noise; the mechanism is unsupported and withdrawn. Authentication does
write on every request, but there is no evidence that write is what fails.

**Retraction 2 — methodological, and worse.** The dose-response curve that started all of this ran
concurrency levels in **ascending order over time**, so a backend degrading during the run is
indistinguishable from a concurrency effect. Re-run interleaved, order flipped each round:

```
concurrency 1:  3/6  failed = 50%
concurrency 8: 36/48 failed = 75%
```

The concurrency effect **survives but is far weaker** than the curve implied.

**THE DOMINANT FACT, which the original framing buried:**

> **A single solitary authenticated request fails about 50% of the time.** No concurrency, nothing else
> in flight. Half fail.

Wren's first curve showed 1-of-3 at concurrency 1 and told us to ignore it as noise. With more samples
it is a coin flip, and it is **the baseline everything else sits on top of.** Concurrency pushes 50% to
75%; **it does not create the failure.**

So this is **not saturation and not contention**. It is a per-request coin flip that load makes
somewhat worse. **Distinct credentials make no difference** (88% vs 81% at 8; 58% vs 62% at 4), so a
per-principal cap is ruled out.

### What this does to the "amplification" story

D-051's framing — retries feeding saturation — is **much weaker than stated**. With a 50% baseline at
zero concurrency, retry traffic is not the cause. Honouring `retryable: false` and decaying the backoff
remain correct client behaviour, but **they will not fix production.** Half of all authenticated
requests failing is the defect; our retry loop is a secondary aggravator at most.

### What still stands, all measured

Failures return in ~0.26 s against ~0.63 s for successes — refusal, not timeout, no clustering at any
boundary. **Unauthenticated at concurrency 8: 16/16 clean 401s across both rounds, zero failures** — the
ceiling is strictly post-authentication. Reads, writes and token mint are all affected; token mint can
need eight retries. Bodies are always the generic non-retryable envelope. One 503 seen among the 500s.

### A hypothesis Wren rejected on reasoning that no longer holds

At 1-second spacing Wren observed near-perfect alternation — `200 500 200 500 200 500` — and dismissed
it as sitting at a saturation ceiling. With a 50% single-request baseline and no contention effect,
**a two-way route with one broken target fits the alternation, the coin flip, the fast refusal, and the
unaffected unauthenticated path** (if unauthenticated short-circuits before the routed hop).

Offered with no confidence and **not adopted** — this is the fourth candidate mechanism and the
previous three are dead. Recorded only because Wren's earlier *rejection* of it rested on reasoning
that has since been withdrawn.

### Still not established

No mechanism — two of Wren's are dead by its own hand and it declines to propose a third as an answer.
No SQLSTATE, no server logs. The middle of the concurrency curve is now **unmeasured**, since the
ascending version is discredited and only the endpoints were interleaved. Whether the 50% baseline
varies by hour, workspace or view — the earlier inbox-worse-than-feed sampling predates the time
confound and must be treated as unmeasured.

### Our clients amplify it — the part that matters

`retryable: false` is in **every** error body. The client never reads it: `throwSignalHttp`
(`src/cloud/signals.ts`) takes the whole `Response` and touches only `.status` and the `retry-after`
header — **never `response.body`.** So it discards the diagnostic *and* the server's explicit
do-not-retry instruction in the same line.

Consequently:

- the CLI tells the human *"retry the same signal to resolve its pending outcome"*;
- the follow receiver retries indefinitely — **370 retry frames in 28 minutes** from one process;
- **five** `cswarm inbox --follow` processes are alive on that laptop, each polling and each retrying.

**Concurrency causes failures → failures cause retries → retries add concurrency.** A positive
feedback loop, and every client in the fleet is wired to feed it. The receiver meant to ride out a
transient outage is instead sustaining it. This also explains the unbounded re-observation loop Wren
reported yesterday.

### Measured vs inferred, per Wren

**Measured:** failure rate scales with concurrency; failures are fast; five receivers poll
continuously; the client ignores `retryable: false`. **Inferred, not measured:** that retry traffic
materially contributes to the saturation. The counterfactual needs those five receivers stopped for two
minutes — **operator action**, since they are not Wren's processes.

### Fix, in priority order

1. **Honour `retryable: false`.** Parse the body, stop retrying when the server says not to. This
   breaks the feedback loop and is the highest-value change available.
2. **Surface the body.** An error path that discards the only diagnostic is its own defect.
3. Then investigate the pool ceiling itself with the request ids Wren supplied.

### Method note worth keeping

Wren nearly reported a load-balancer hypothesis from a convincing `200 500 200 500` alternation on six
data points, and said so rather than burying it. The concurrency curve explained it better. Also
flagged: the concurrency-1 point is three requests and disagrees with the trend — treat 2-8 as the
signal.

### Not established

Server-side confirmation — pool exhaustion is the shape the client evidence makes, not something read
from a log. Whether `feed` and `inbox` have different ceilings. **Whether the cap is per-principal or
global — Wren varied concurrency from one credential only, and if it is per-principal the fix changes
entirely. That is the cheap next test.**


---

## D-052 — honouring `retryable: false` kills receivers; the backoff reset is the better lever · RULING

Found by **Verity** immediately after building the D-051 fix, before it shipped. Every link verified by
the Lead.

### What the naive fix does

I specified *"do not retry, surface the error instead."* Traced end to end on `9c12461`:

```
refused 500 -> isRetryableFollowError false -> runtime.ts:806 stop={reason:"fatal"}
            -> supervisor transition("failed") -> run() returns
```

**And nothing brings it back.** No restarter exists anywhere in `src/` — no `.plist`, no `.service`,
and `spawnDetachedListener` spawns once, detached, with no respawn. My own grep for `restart` returned
five hits that were all `closeBeforeStart`: a false positive that would have let me confirm the wrong
answer.

So the first refused 500 **permanently kills each receiver**. At Wren's measured rejection rates, five
receivers plausibly die within minutes and delivery stops until a human intervenes. Pre-fix they were
degraded but alive. **That is a worse user-visible outcome than slow retries, and it would read as "the
fix broke everything."**

### The mechanism behind the 370 frames — and why the obvious middle path is worse

`signals.ts:1577` (and the runtime equivalent) sets `attempt = 0` on **every successful read**. An
intermittently-failing receiver therefore never climbs to the 30 s cap: it rises, succeeds, resets,
rises again. That is 13.2 requests/min against ~2/min for a receiver sitting at capped backoff.

**The reset is the amplifier's engine.**

It also kills the tempting middle option — *don't retry, but let the idle poll continue*.
`SIGNAL_FOLLOW_POLL_MS` is 2000, so that is ~30 requests/min: **more** load than the 13/min being
removed.

### Ruling

Land `9c12461`, with **two companions in the same deploy**:

1. **Fix the backoff reset.** Decay the attempt counter rather than zeroing it, or reset only after N
   consecutive successes.

   ~~"This cuts amplification ~6× without depending on the server's `retryable` field at all… It is the
   most robust part of the change."~~ **Dead — that was my line and it is wrong.** Found by Wren,
   confirmed by Verity in the code: `attempt += 1` sits **inside** the `isRetryableFollowError` branch
   (`signals.ts:1793`), so the D-051 veto makes the decay **unreachable for a refused failure**. The
   veto fires, the read is fatal, and the counter is never touched.

   **The two companions interact, and `9c12461` short-circuits the path `37582dc` governs.** Wren
   verified the premise rather than assuming it: 30 sequential reads gave 500×20, `retryable:false`×20,
   `retryable:true`×0. **There is no retryable failure mode on that path today.**

   So companion 1 is **insurance for a failure mode that is not occurring** — a 429, or a 5xx the
   server classifies retryable. On current production behaviour it is the **least** active part of the
   change, not the most robust. I was about to ship it described as the opposite.
2. **Receiver supervision — restart with a cap.** Exponential, bounded, and it must stop and record why
   after N attempts, so transient saturation recovers while a revoked credential still terminates.

### The server is probably wrong, and that is why the naive fix is dangerous

Honouring `retryable: false` is correct *client* behaviour. But **a pool-exhaustion 500 is transient and
IS retryable with backoff.** The server asserting otherwise is likely a server defect — so the naive
fix faithfully obeys an assertion that is wrong, and kills receivers for a condition that would clear.

Companion 1 protects us regardless of what the server claims. Recorded as a server-side item behind the
**D-047 freeze**.

### Not established

Whether the fix moves the production failure rate — nothing has been measured against production. And
**after this ships, "zero retries" can mean *honoured* or *dead***; the post-deploy measurement must
distinguish them. That distinction is Verity's and it is the thing most likely to be misread.

---

## D-053 — control flow decided by matching untrusted text against `error.message` · CLASS RULING

Three instances found in one session by **Plumb**, the third in a place the Lead had explicitly
cleared. This is one defect class, not three bugs.

### The pattern

**A classifier decides control flow by regex-matching `error.message`, and untrusted text can reach
that field.** Whoever controls the string controls the branch.

| # | Classifier | Untrusted source | Consequence |
|---|---|---|---|
| 1 | `signals.ts:1496` `/aborted/i` | server error body → `describeServerError` → `error.message` | follow **exits silently** as if the operator cancelled |
| 2 | `signals.ts:1425` `/secret is absent/i` | same path | forged **credential failure** — defended by Verity's contract-shape restriction, 10/10 attacks resisted with a 2/2 positive control |
| 3 | `engine.ts:238` `/timeout\|temporar\|transport\|child exit\|connection/i` | **the ACP child's own JSON-RPC error message**, copied verbatim at `transport.ts:311-313` | the **provider decides whether we re-prompt it** |

### Instance 3, and why it is the worst of the three

`transport.ts:311-313` takes `rec.error.message` from the child and puts it straight into
`AcpProtocolError`. `engine.ts:233-238` then matches keywords against it.

Plumb's causal reproduction — **same error type, same `code='rpc_error'`, only the message changed:**

```
"provider rejected this request"            -> failed
"connection permanently denied"             -> retry_pending
"temporary policy violation"                -> retry_pending
"transport authorization rejected"          -> retry_pending
"child exit requested by policy"            -> retry_pending
"request timeout: invalid account"          -> retry_pending
```

Every one of those is a **permanent** refusal phrased so it matches a retry keyword.
`engine.ts:456-465` then schedules another model prompt — bounded by `maxPromptAttempts`, but it
duplicates provider work, cost and load on refusals that will never succeed.

### This is a known ruling that keeps regressing

The A2 credential-escape lane **deliberately removed** message-regex matching from `isAbort`, and the
Lead's own review of that lane recorded *"isAbort is name-only in both engine and runtime; the message
regex is gone."* It was removed from two sites. **Three others survived, and one was introduced since.**

### How the Lead cleared instance 3 incorrectly

Verity reported *"`defaultRetryablePromptError`: CHECKED, does NOT need this — no HTTP response reaches
it, so there is no envelope to read."* That is **true and insufficient.** The Lead accepted "no HTTP
envelope" as meaning "no untrusted input", which is a different claim. Neither asked what **else** could
populate that message. The child does.

### Ruling

**Never infer control flow from prose.** Classify on:

- error **type** (`AcpTimeoutError`, `AcpChildExitError`, `SenderProvenanceUnavailableError`);
- a **stable code** we assign (`AcpHostError.code`), not one the peer supplies;
- the caller's own **`AbortSignal` state**, which is authoritative for cancellation.

Normalise raw stream failures to a typed transport code at the boundary. **A message is for humans.**

Fix all three instances. Sweep for others — the pattern is the finding, not the instance.

### Not established

Whether other classifiers outside `signals.ts` and `engine.ts` match on messages. Whether the bounded
`maxPromptAttempts` limits the cost of instance 3 to an acceptable level in practice.

---

## D-054 — `retryable: false` is the server's DEFAULT for anything unclassified, not a judgement · SHIP-BLOCKER (server, frozen)

Lead found by **Verity**; verified by the Lead **against the deployed v6 source**, not the repo.

```js
const code = record === null ? null : readStringField(record, "code");   // :87
retryable: isRetryableErrorCode(code)                                     // :99

function readStringField(record, key) {
  const value = record[key];
  if (typeof value !== "string") return null;      // :60
  ...
}
function isRetryableErrorCode(code) {
  if (code === null) return false;                 // :70
  ...
}
```

**Any thrown value without a top-level string `code` yields `retryable: false`** — regardless of
whether the condition is transient. The field is not a classification; it is a **default applied to
everything the classifier could not read.**

### Why this matters more than it looks

1. **It explains the contradiction.** We reasoned that `retryable: false` ruled out connection
   exhaustion, because the server marks `53300` and the `08xxx` class retryable. That inference was
   **unsound**: an error that never carries a `code` field is reported non-retryable no matter what it
   is. `retryable: false` tells us **nothing** about the underlying condition.
2. **We just taught the client to obey it faithfully.** D-051 makes `retryable: false` a hard veto.
   Combined with this, **a server-side false negative propagates directly into permanently stopped
   receivers.**
3. **It vindicates the bounded supervision decision.** D-052 added restart-with-cap because a receiver
   must not die permanently on an unidentified condition. That is now the load-bearing safeguard rather
   than a nicety — without it, an unclassified server error kills every listener.

### The fix is one line, and it is frozen

`read/diagnostics.ts` must distinguish **"classified as non-retryable"** from **"could not classify"**.
An unknown error should not assert non-retryability. **This sits behind the D-047 freeze** and needs a
`read` deploy, which is exactly what that freeze forbids without the full gate.

### What answers it immediately

**The operator log line already carries `name` and `code`.** One look at the six request ids Wren
captured shows whether the failing errors carry a `code` at all. If they do not, this is confirmed and
the production 500s are unclassified rather than non-retryable. **Dashboard access — operator.**

### Not established

Whether the production failures actually lack a `code`. Whether adding the distinction changes the
observed failure rate — **it would not**; it changes only what we tell clients about it.

---

## D-055 — `--ndjson` emits its fatal as bare text, breaking the contract the flag exists for · MAJOR

Found by **Wren** during the paired A/B of `59ff363`, because its parser flagged the line UNPARSED.

In `--ndjson` mode the post-fix fatal is emitted as **plain text**, not a frame:

```
cswarm: signal read failed (HTTP 500): internal_error, request_id 5bdd7856-…
```

**The whole point of `--ndjson` is a machine-readable stream**, and the connect prompt directs
non-Grok hosts to use it. A programmatic consumer breaks on that line instead of reading a terminal
condition — so **the stream's last word is unparseable, and a wrapper cannot distinguish "died with a
reason" from "emitted garbage."**

Fix: emit a frame, e.g. `{"type":"error","reason":"server_refused","request_id":…}`. The information is
already there; only the encoding is wrong.

---

## D-056 — a post-fix receiver dies at cold start 25% of the time · MITIGATED, shipped in v0.1.7

> **STATUS 2026-08-07 — the ship-blocker is DISCHARGED, not the defect.** The heading below
> read `SHIP-BLOCKER for the D-051 deploy` until this date; D-051 and its mitigation shipped
> together in **v0.1.7** (`41c69e1`), so that wording is **dead** and kept only for history.
>
> **What shipped:** bounded per-burst refusal tolerance in the follow loop (default 60s,
> `CSWARM_REFUSAL_TOLERANCE_MS`, ceiling 10 min). A refusal is now absorbed for a window,
> each attempt after full backoff, before the stream stops. The D-051 veto is not removed —
> it is **overridden on a bounded budget**, because the server's `retryable:false` is
> measurably wrong for pooler exhaustion (`XX000` is absent from `read`'s `RETRYABLE_CODES`).
> Both D-036 arms cleared it; Plumb's non-author control is in the suite and was
> mutation-verified to discriminate.
>
> **What is NOT fixed, and why this is MITIGATED rather than FIXED:** the 60s window does
> **not** cover the ~420s observed pooler burst, and **nothing consumes exit 75**, so a
> longer spell still ends the session and it stays ended until a person or a supervisor
> restarts it. The underlying cause is a server-side misclassification that a `read` deploy
> would fix at source; that deploy is frozen by D-047 and its vehicle is still unnamed.
>
> Evidence: `docs/release/0.1.7.md`, and the wake round trip measured on the shipped
> artifact in `docs/evidence/2026-08-06-agent-wake-round-trip.md`.

### Original entry, as filed

**8 independent cold starts, post-fix `59ff363`: 6 reached ready, 2 died before ready — 25%.**

Each death carried an error line naming the cause, so these are **genuine refusals**, not the host
reaping processes. Wren reported this number while explicitly *refusing* to report lifetime, because
that evidence is in-band and the other was not.

### Why the bounded restart does not cover it

D-052's companion 2 supervises **`listen start`** — `runListenerSupervisor`. This measurement is
`cswarm inbox --follow`, the **CLI follow loop**, which has no supervisor. So the restart protection
lands on the durable listener and **not** on the receiver the connect prompt tells most hosts to run.

**That gap is the deploy decision.** At a ~50% per-request failure baseline, a receiver that exits on
its first refused read has a coin-flip chance of never starting.

### The A/B that produced it — Verity's prediction, confirmed

Both arms launched in the same 75-second window, same credential, same workspace:

| | requests per failure event |
|---|---|
| pre-fix `0ad5871` | 3,2,3,3,2,2,2,4,2,2,2 → **mean 2.45** |
| post-fix `59ff363` | **exactly 1** |

Verity predicted 1. Measured 1. Its stated falsification condition — retry frames on a confirmed
refusal with a confirmed-new binary — **did not occur**.

**Binaries identified by sha256, not by name:** both report `cswarm 0.1.6`, so the version string is
useless as identity. Wren re-verified the hashes **after transfer**, because a truncated copy would
have been silent. Positive control reproduced: `serverRefusedRetry` pre=0 post=2,
`decayFollowAttempt` pre=0 post=3.

Per Verity's instruction, lifetime and failure-rate are **not** offered as evidence either way.

### Disclosed deviation

Wren copied only `dist` + `package.json` (the full trees are 47 MB of `node_modules` each and transfer
kept timing out) and pointed **both** arms at the laptop's existing `@supabase/supabase-js 2.110.8`.
Dependencies are therefore **held constant across arms**, preserving the client-behaviour comparison,
but this is **not a byte-exact reproduction** of the build environment.

### Not established

Whether the 6 receivers that reached ready then died inside the 12-second window — Wren killed them at
12 s and did not retain the frames, so it has cold-start death rate but **not post-ready survival**.
Nothing about the server-side cause.

---

## D-057 — the restart classifier is default-true, so unrecognised failures restart five times · MAJOR

Found by **Plumb** on exact `b9480da`; verified by the Lead **by execution**, not by reading.

### The question asked, and the better answer returned

I asked whether `b9480da`'s shared predicate changed semantics versus the inline logic it replaced.
**It did not — Plumb confirmed they are semantically identical.** But it found that *both* are
**domain-incomplete**, which is the more useful finding: the refactor did not introduce the defect, it
propagated an existing one to a second caller.

### The mechanism

`isRestartableReadError` (`signals.ts:496-500`) is **default-true**:

```ts
if (isFollowCredentialFailure(error)) return false;
if (isFatalFollowError(error)) return false;
if (isMalformedFollowMessage(error)) return false;
return true;                     // <- everything it has never heard of
```

Its three exclusions recognise **signal-read** types only. `isRestartableListenerStop`
(`runtime.ts:195-199`) delegates **every fatal stop** to it — but the runtime also emits delivery
errors (7 sites) and ACP startup failures (`:839-842`, where `model.start()` throwing becomes a fatal
stop).

**Executed against the real predicate:**

```
DeliveryHttpError 400   restartable = true
DeliveryHttpError 409   restartable = true
AcpVersionError         restartable = true
```

Plumb's fuller matrix adds `delivery_ack_conflict`, `DeliveryProtocolError` on a malformed 2xx,
`AcpPermissionCanaryError`, and `AcpProtocolError malformed_frame` — all `true`.

So the supervisor performs **up to 5 fresh-model restarts** (`supervisor.ts:354-383`) on a 400
`invalid_request`, a version mismatch, or a failed permission canary — **contradicting its own stated
"4xx / malformed / protocol never" boundary**, and repeating persistent delivery commands and provider
starts that cannot succeed.

### Why the tests did not catch it

`listener-control.test.ts:1129+` covers only `SignalHttpError` and `SignalMalformedError` — the two
types the predicate already knows. **It misses every cross-domain fatal type**, which is precisely the
set that fails open.

### Fix

**Closed classification, listener-wide.** A restart decision must not be a default applied to
unrecognised input. Either enumerate the restartable set explicitly and return `false` otherwise, or
require every fatal error reaching the supervisor to carry a code we assign.

This is the structural sibling of **D-053** and **D-054**: D-053 was control flow on untrusted *text*,
D-054 was the server defaulting `retryable:false` for anything it could not classify, and this is our
own classifier defaulting **true** for anything it does not recognise. **Three instances of one
principle — an unrecognised input must not silently acquire a decision.**

### Not established

Whether any other caller of `isRestartableReadError` is exposed to the same fail-open default. Whether
five restarts on a persistent 4xx has caused observable harm in production, as opposed to being a
latent path.


### D-057 REOPENED on `71bafb0` — the closed default has a prose door in front of it

The fix enumerated a restartable set and returned `false` otherwise. **It is bypassed by wording.**

`followHttpDetails` matches any `Error` whose **message** is `/^signal read failed \(HTTP (\d+)\)/`,
and `isTransportFollowMessage` matches exact transport prose. `runtime.ts` delegates unknown fatal
errors to the read predicate. Executed on `71bafb0` with an unrecognised `FutureRuntimeError`:

```
"some ordinary failure"                          -> false
"signal read could not reach the cloud service"  -> TRUE
"signal read failed (HTTP 500)"                  -> TRUE
"signal read failed (HTTP 400)"                  -> false
```

**An unrecognised type still acquires a restart decision from its message** — contradicting the new
code comment, the closed-classification test, and the D-053 ruling simultaneously.

**This is D-053 surviving inside D-057's fix.** Fourth instance of one principle in a day, and this
time the remedy for the third instance reopened the first through a back door. **A closed default is
not closed if any door in front of it opens on prose.**

### Both verifications failed the same way, and one was the Lead's

Verity's `FutureRuntimeError` row supplied only **innocuous** text. The Lead separately executed the
predicate with `"timeout transport connection"`, got `false`, and **reported the closed default as
holding**. Plumb used the **colliding spelling**.

Neither adversarial. **Both tested that the door was shut without trying the key that fits** — and the
Lead's version was published as verification one message before Plumb refuted it.

### Fix, already half-present

HTTP failures are **already identity-tagged**: `plainHttpStatus` is a `WeakMap` (`signals.ts:170`, set
`:434`, read `:448`). **The regex fallback is redundant for HTTP — delete it and read the tag.**
Transport failures need the same treatment: a tag applied at the construction sites, not a prose match.

Controls must include adversarial rows for **both colliding spellings**, plus positive controls from the
real read path proving the tagged route still works once the regex is gone.

### Artifact correction owed

The D-056 evidence states `isRestartableReadError` is the single predicate used by both callers and
that `runtime.ts` imports no underlying classifiers. **`71bafb0` makes both false.** To be marked
superseded in-artifact, not silently edited.

### Plumb's default sweep — negative result, recorded

No third live decision-carrying default of this shape. **D-054 and D-057 are the whole surface.**
Enumerated and cleared: malformed/absent `retryable` falls back to status; malformed `Retry-After` to
bounded local backoff; absent capabilities to `false` with the gate refusing; malformed capability
markers and success bodies throw; unknown ACP stop reasons become protocol errors; unknown requests
`-32601`; unknown notifications ignored without satisfying pending state; permission fallback denies;
unknown prompt/post errors terminal; unknown runtime events logged without ACK.

`sender_owner_relation=unknown` is a **legitimate closed server enum**, not a defect. **One conditional
kept:** the agent-scope denylist returns `false` for novel strings and is safe only because a novel
scope grants nothing *today* — adding a command or scope without updating both gates would change that.

---

## D-058 — the closed classification was bypassable by wording · MAJOR · FIXED

**Entered 2026-08-08, late.** This entry is written after the fact because the defect was found,
fixed, and controlled entirely inside `docs/evidence/d051-retryable-refusal.md`, which **cites
D-058 eight times against a number that had no entry here.** A register that a reader consults to
find out whether a defect is real returned nothing for a defect that was real, fixed, and
controlled. The evidence file is the authority for detail; this is the index it was missing.

Found by **Plumb** on `71bafb0`. **This is D-053 surviving inside the D-057 fix** — the third
regression of "never branch on `error.message`", inside the very change that closed the second.

`followHttpDetails` fell back to matching `/^signal read failed \(HTTP (\d+)\)/` against the
message, and `isTransportFollowMessage` matched exact transport prose. Because
`isRestartableRuntimeError` delegates unrecognised errors to the read predicate, the closed
default was reachable **around** — by spelling:

```
'some ordinary failure'                          -> false
'timeout transport connection'                   -> false
'signal read could not reach the cloud service'  -> TRUE    <- bypass
'signal read failed (HTTP 500)'                  -> TRUE    <- bypass
'signal read failed (HTTP 400)'                  -> false
```

**Fixed by identity, not prose:** the HTTP regex was deleted (every real HTTP failure has been
tagged at construction by `plainHttpStatus` since before this workstream, so the regex was
redundant for real errors and served *only* as the bypass), and transport errors got a
`plainTransportErrors` WeakSet tagged at all three throw sites.

**Why it is the canonical instance of the non-author rule.** The D-057 table's row supplied
innocuous text; an independent probe used retry *words* but not the *colliding spelling*. Both
tested that the door was shut without trying the key that fits. See AGENTS.md, "Adversarial
controls must be written by a non-author" — that section was written from this defect.

## D-059 — NUMBER NOT USED · tombstone

`docs/org/2026-08-07-RESUME-HERE.md` records that D-059 "was allocated and never entered."
**No content for it survives anywhere in the repo** — the only occurrence of the string is that
claim about itself. So there is nothing to enter, and the allocation cannot be reconstructed.

Reserved rather than reused: if the original allocation resurfaces it keeps this number, and new
defects take fresh ones. A silently reused number is worse than a gap.

## D-060 — `cswarm logout` claimed a sign-out the server had refused · MAJOR · FIXED in v0.1.8

**Entered 2026-08-08, late.** D-043 covers the logout *wedge* and is filed. This is a **different
defect fixed in the same release** and it had no entry — searched with a control:
`"all devices"` 0, `"sign-out"` 0, `D-043` 2.

`@supabase/auth-js` deliberately swallows 401/403/404 on sign-out so browser apps can still clear
local state. The CLI inherited that silence and printed **"Signed out on all devices"** about
requests the server had **refused**. For a user reaching for `--all-devices` as containment after
a suspected compromise, that is the difference between believing the request went through and
knowing it.

Fixed by reading the server's actual answer via `admin.signOut(access_token, scope)`: confirmed
sign-outs say so and only then; unconfirmed ones retain the credential — because it is the only
handle left for retrying — and do not guess at the cause.

**Three defects were found while fixing this one, each by a non-author, and they are the reason
the final shape is conservative:**

1. The first fix deleted the credential on *any* refresh failure — Verity blocked it: a transport
   failure means the token may still be live.
2. The second gated on `isAuthRetryableFetchError` — Plumb blocked it: a 429 arrives as
   `AuthApiError`, so it still deleted a live credential. Fixed with a **closed allowlist** of
   four terminal refresh codes.
3. The failure message split causes it could not distinguish — Plumb's 404/500 control showed a
   server that *answered* 500 was reported as "could not reach". Collapsed to one
   observation-only message.

**A copy control enforced an overclaim that two reviewers had cleared:** the test required
`/every session/`, a phrase that was false, so the gate was holding the wrong claim in place.
Access tokens already issued stay valid until expiry; only refresh tokens are revoked.

## D-061 — a directed signal is invisible to its author · MAJOR · OPEN

**Found 2026-08-08 by the Lead, after it had corrupted two of the Lead's own published claims.**

`feed` returns broadcasts plus signals directed **at** you. It does not return signals you
directed at someone else, and no other view does either. **There is no sent view.**

```
feed --limit 100 --include-stale       66 signals
  directed among them                  12
  addressed to me                      12   <- all of them
4bc97287  written 40s earlier, --to Verity   0 occurrences in the author's own feed
f934d219  control, quoted by another member  1   <- the search method resolves
```

`ask` returns a signal id that the author cannot then resolve. **Delivery is establishable only
by the recipient telling you, over some other channel** — which during the 2026-08-07 dogfood
meant the internal `swarm` CLI, i.e. the product could not confirm its own delivery without the
tool it replaces.

Two false claims came directly from this: "XUSER-f934d219 is absent from the feed, so the write
did not land," and the same for two retry asks. Both retracted in
`docs/evidence/2026-08-07-cswarm-dogfood/README.md` §7. Whether those asks landed is **still
unmeasured**.

**Related, same surface:** `--limit 500` returns output the CLI's own `--json` consumer cannot
parse, with no documented cap; and a `--limit 8` read without `--include-stale` produced a
confident wrong count for a second agent in the same hour. Two agents, two flag mistakes, one
read surface whose defaults do not match what callers assume — filed as one product defect
rather than two user errors.

**Not established:** whether the fix is "feed shows your sends" or a separate view. Dogfood
finding 1 was already that users cannot distinguish `inbox` from `feed`; widening `feed` may
deepen that.

## D-062 — a recipient name resolved to a different live principal · MAJOR · FIXED in v0.1.9

> **Both halves shipped.** `cswarm members` makes the roster readable by an agent, and a directed
> send now names the recipient it resolved to. Wren confirmed both from a second machine on the
> published artifact. The heading said OPEN while this body recorded the fixes — corrected
> 2026-08-09, after the same contradiction on D-050 sent an agent hunting a defect that was
> already closed.

**Measured 2026-08-08.** `--to <name>` resolved `Wren` to principal
`23733ab6-cb45-473c-8996-210930dffdf3`. The intended Wren is `wren-crossuser`, principal
`3a37b055-035b-45d4-9597-7f189e397c44`. Signals were **delivered, correctly, to a different
agent** — content intended for one principal was readable by another.

```
--to Zzqx<random>   REFUSED   "signal recipient is not a live member or agent of this project"
--to Wren           accepted  to_agent = 23733ab6...   <- real, live, WRONG
--to Verity         accepted  to_agent = 765542b1...   <- control
--to 3a37b055...    accepted  to_agent = 3a37b055...   <- control
```

**Name validation works** — the refusal proves it. The defect is collision, not absence of
checking, and the two demand opposite fixes.

**There is no roster verb.** `cswarm --help` lists no `members`/`roster`/`agents`, and
`cswarm members` returns *"unknown command"*. So a caller cannot enumerate the names `--to`
accepts, and cannot discover that two principals answer to one name. The only safe addressing is
a UUID obtained out of band, and nothing in the CLI or the connect artifact says so.

**The receipt already carries the evidence.** `to_agent` echoed `23733ab6` on every send. Three
agents debugged this for ~20 hours with the answer in every response object. Not a missing
instrument — an unread field.

### Both open questions are now closed — HYGIENE, not disclosure

**Shadowing is impossible** (Wren, measured): principal names are **unique per workspace** and a
duplicate is refused at creation.

```
create principal 'shadowprobe'        accepted  159d62cb
create principal 'shadowprobe' again  REJECTED  "principal_name_taken"
create principal <fresh unique name>  accepted  4f9283a8   <- control: create still works
--to shadowprobe                      resolves to 159d62cb, the sole holder
```

So `23733ab6` was not shadowing anyone. It held the name `Wren` legitimately, by getting there
first. Resolution order is moot.

**And it was mine.** `/tmp/cswarm-dogfood/Wren.cred.json` and `Wren.out` on the mini record that
**the Lead created principal `Wren` at 2026-08-07T22:12:50** as an onboarding placeholder, in
anticipation of an agent that then created its own (`wren-crossuser`, `3a37b055`) on its own
machine. The placeholder was never withdrawn and kept the name.

**Nothing could have read the misdirected asks, and this is a mechanism rather than an absence
argument.** The only credential ever minted for `23733ab6` was minted by the Lead and carried
`expires_at: 2026-08-08T04:12:49.701Z`. The first misaddressed ask was sent at **13:16:45Z** —
**over nine hours after that credential was already dead.** The content went to a mailbox for
which no live key existed.

**Residual risk, stated rather than dismissed:** the signals persist server-side, so a *newly*
minted credential for `23733ab6` could still read them. Minting requires the workspace owner's
credential. **The principal is therefore revoked** — see below — which is the action that closes
it, not the reasoning above.

**Still not established:** whether any token other than the Lead's was ever minted for
`23733ab6`. Local artifacts cannot show that; only `swarm.agent_tokens` can, and the count was
not run. The argument above rests on the owner-only minting constraint, not on a measured count.

### What D-062 actually is

Not missing validation — validation works. Not ambiguous resolution — duplicates are refused.
**Name addressing is safe but undiscoverable.** A caller can be entirely correct, receive
`accepted`, and be talking to someone else, with no supported way to check first and no prompt to
notice after.

The fix has two parts, and Wren identified both:

1. ~~**A roster verb.** Nothing lists the names `--to` accepts.~~ **FIXED 2026-08-08 — and the
   original wording was wrong.** A roster verb already existed: `cswarm status` lists every
   member and agent with name, UUID, owner and liveness, in human-readable output. **It refused
   `--agent-token-stdin` at its shape gate**, so the one party that needs a roster to address a
   signal was the one party that could not read one. Wren had reported that refusal the same
   morning as a flags-inconsistency annoyance; neither of us connected it to the twenty hours
   we then spent.

   Shipped as **`cswarm members`**, accepting both credential kinds:

   ```
   $ cswarm members --workspace-id <id> --agent-token-stdin
   People:
   - Tom Langridge (919ce195-…)
   - Ridgeio (d37e2ff2-…)

   Agents:
   - wren-crossuser (3a37b055-…) — Tom Langridge
   - jsonshape-probe (3418af28-…) — Tom Langridge
   …
   Address an agent by the id in brackets: cswarm ask "…" --to <id>
   ```

   **Nothing new was built server-side, and that was measured before writing any code.** The
   deployed `read` edge function already answers `resource: "members"` with `{members, agents}`
   for an agent token (HTTP 200 against production), and `signalDirectory()` in `cli.ts` already
   served both credential kinds — the CLI was *already* reading this roster to resolve `--to`
   and simply never showed it. So the change needs **no edge deploy and is clear of the D-047
   freeze**.

   **It is deliberately not `status --agent-token-stdin`,** and a test pins that. `runStatus` is
   built on `humanCredential` throughout — `human.userId`, `human.deviceId`,
   `profileIdentity(human)` — and speaks as "You:". Widening its gate moves the failure deeper.
   That check was run *before* filing, because D-063 was filed on exactly this mistake.

   **One compatibility case came from the type system, not from review:** `owner_user_id` is
   optional on the read contract — *"absent on older compatible deployments"* — so owner
   attribution is omitted rather than guessed when a deployment does not send it.

2. ~~**Surface `to_agent` in human-readable output.**~~ **FIXED 2026-08-08.** The line used to
   read *"Signal shared. It is immutable and visible only to its recipient."* — true, and
   useless: it told the sender what they already assumed and withheld the one fact they lacked.
   Now:

   ```
   Signal shared. It is immutable and visible only to wren-crossuser (3a37b055-…).
   broadcast control -> It is immutable and visible to members of this workspace.
   ```

   Wren argued this half is the higher-value one and that it dissolves most of the need for the
   roster, since the question in every incident was *"this name I am about to address — who is
   it?"* — about one name, not the roster. That argument was not overruled on merit; the roster
   was built first because it was asked for directly.

   **What it does and does not do, because the distinction is the finding.** It surfaces the
   resolved id at the moment of sending, so a mismatch is visible the instant anyone knows the
   id they meant. It does **not** tell you the id is wrong — nothing can, since the send is
   well-formed and the server resolved exactly what was asked. Enumeration is the other half,
   which is why both shipped.

   Extracted as `describeAudience()` and gated on six cases, including: the id shown is the
   **resolved** one rather than the name the sender used; an unknown recipient degrades to the
   bare id rather than a guessed label (**a wrong name here would be worse than no name — that
   is the defect itself**); and `to_agent` wins over `to`, so an agent recipient is never
   reported as its human owner, which would be a true-sounding sentence naming the wrong party.
   Mutation-verified against the plausible "tidier" variant that prints the name without the id:
   it fails 4 of 6 while both controls correctly hold.

   **An existing copy control had pinned the old wording** (`/visible only to its recipient/` in
   `signals.test.ts`) and failed. It was replaced with a **stronger** assertion — the recipient
   must be named *and* its id shown — rather than merely a different one, since editing a
   control to match one's own change is how an overclaim gets in.

## D-063 — an agent idle across its renewal window cannot renew · MAJOR · CLOSED, not fixable

> **Closed by measurement, not by a fix.** Plumb measured renewal firing from a one-shot signal
> verb on the published 0.1.9 — see the entry below. The surviving statement is a **property, not
> a defect**: renewal is lazy, so an agent with nothing executing across its lead window cannot
> renew, and no wiring can change that because there is nothing running to notice. The open
> question is whether the 6-minute lead suits an agent whose cadence is longer, which is a
> question about `RENEWAL_LEAD_FRACTION`, not a bug. Heading corrected 2026-08-09.

> ### ⚠ THIS ENTRY WAS FILED WRONG. The original heading and mechanism are DEAD.
>
> ~~"token renewal is wired into `listen` and not into the commands agents actually run"~~ —
> **refuted by Verity, 2026-08-08, hours after I filed it.** Renewal **is** wired into every
> signal verb. I grepped `src/cloud/signals.ts`, found no renewal call, and concluded the path
> was unwired. **Renewal lives one layer up**, at `src/cli.ts:1918` —
> `bearer: await session.bearer()` inside `commandWorkspaceAndCredential` — and
> `renewal.ts:784-785` shows `bearer()` consults `due()` and renews before returning.
>
> Verified independently rather than accepted, because Verity's own line numbers were off by
> about five and I had already published one wrong version of this entry:
>
> ```
> runPostSignal      2124  -> commandWorkspaceAndCredential 2144    (note, ask, working-on)
> runReply           2255  ->                               2272
> runSignalRead      2316  ->                               2354    (inbox, feed)
> runInboxFollow     2429  ->                               2431
> dispatched at 3731 / 3735 / 3739
> ```
>
> `cli.ts:1911-1914` states it in a comment I never read: *"Renewal is resolved HERE, before the
> first request rather than after a 401."*
>
> **I measured the wrong layer** — the same error as this session's `feed`-vs-`member-read`
> mistake, one level in. Grepping a leaf file for a concern handled by its caller returns a
> confident zero. Had this been implemented as filed it would have added a **second renewal path
> beside a working one**, and that is hard to unpick later.
>
> The retraction of the *TTL* remedy below still stands and is unaffected: 8h is still the
> documented hard max and still the wrong default.

## What actually survives

**2026-08-08. This is dogfood findings 4 and 5 as one defect, and it corrects the fix direction
both of them proposed.**

Canonical spec §2.3 sets **default TTL ≤ 1h** as a hardened security boundary (Kimi #1/#2:
narrowest binding, redaction, revoke-every-command). §796 names the designed mitigation:

> *"agent tokens default to ≤1h TTL. The CLI **silently re-mints** worker tokens using the
> member's refresh credential — zero operator interaction in steady state, and this is the
> designed path, not an implementation accident."*

**So "raise the default TTL" is not a fix — it is a spec violation.** The dogfood recorded
`--ttl-ms 28800000` (8h) as "the fix was a flag already shipped"; that flag reaches the *hard
max*, deliberately traded against the ≤1h default, and using it as the standard onboarding path
converts a documented security boundary into a workaround. **Retracted as the recommendation.**

**Renewal is LAZY: it happens only while a command is running.** Measured in
`renewalDueAt` (`renewal.ts:121-129`):

```
lead = min(RENEWAL_LEAD_CEILING_MS, max(RENEWAL_LEAD_FLOOR_MS, lifetime * 0.1))
     = min(15m, max(5m, 6m)) = 6 MINUTES for a 1h credential
```

So the population splits, and only one half has a defect:

- An agent that **runs any command inside the last 6 minutes** of its credential renews. It is
  fine today, and needs no change.
- An agent **idle across that window cannot be saved by any wiring**, because nothing is
  executing to notice. There is no timer, and a serverless backend has nothing to push to.

That is the real shape of finding 4. Verity's own death is the data point:
`due 04:06:46Z, expired 04:12:46Z, last command 03:20Z` — **idle through the window**, not
missing wiring. Verity supplied the observation that seeded my wrong inference and corrected it
itself.

It composes with dogfood finding 5 exactly as filed there, but for a different reason than I
gave: a polling agent whose poll interval exceeds the lead window is unrenewable, and the wake
path would collapse the interval to seconds. **The fix is latency or lead time, not wiring.**

**Three live copies of the default must move together if it ever moves** (Plumb, verified):
`src/protocol/workspace-commands.ts:17` (used at `:662` root, `:950` successor),
`src/cloud/renewal.ts:61` (`:680` reconstructs a missing `issuedAt` from it),
`site/src/lib/agent-connect.ts:41` (passed by `AgentConnect.astro:537`). Plus:
`_shared/protocol.js` is generated and follows protocol; the seed fixture hardcodes 1h; tests pin
root and successor at 1h; `api.md`, `llms.txt` and §2.3 all state ≤1h.

**Two constants are derived from the 1h cadence and must not be moved mechanically:**
`RENEWAL_MAX_SUCCESSORS_DEFAULT = 800` is derived from a 1h/54m cadence over 30 days and would
need rederiving; `RENEWAL_PENDING_RECOVERY_MS = 1h` is a separate ambiguous-outcome replay window
that merely shares the number.

**Neither the TTL constants nor the signal path should be touched.** The open question is
whether the 6-minute lead is right for an agent whose natural cadence is longer, and that is a
question about the *lead fraction and floor*, not about wiring.

**Not established:** nobody has watched a renewal fire from a signal verb. Verity found
`~/.cswarm/agent-credentials/` at 0700 with two `successor-*.json` records, and confirmed by
positive control that a one-shot `inbox` at 08:54:18 moved the store's mtime to 08:54:18 — so a
read verb does touch the credential store. But the successor files could have come from `listen`.
The closing experiment is cheap and unrun: mint a short-TTL credential, run `inbox` inside the
lead window, watch for a new successor file.

## D-064 — `--json` was refused on the three verbs a script is most likely to call · MAJOR · FIXED

**Found by the Lead by reproduction, characterised by Wren from a second machine, 2026-08-08.**

`--json` was accepted on five verbs and refused on three, and the split fell in the worst place:

```
ACCEPTED   status, feed, inbox, workspaces, listen status
REFUSED    token mint, principal create, invite      "cswarm: unknown option: --json"
```

The three refusals are exactly the verbs that produce a **credential, an identity, or a
capability link** — the ones a caller consumes programmatically. Anyone who has used `--json` on
`feed` reasonably assumes it works on `mint`.

**The failure destroys data and does not look like an error.** `cswarm token mint --json >
cred.json` exits 1 having written nothing to stdout, so the shell's `>` truncation leaves an
**empty file** where a credential used to be.

**The Lead's first diagnosis was wrong and Wren corrected it:** *"it clobbered my credential file
with an error string."* It did not — the error goes to **stderr**, and stdout is **0 bytes**
(measured). The destruction is shell semantics, not the CLI writing garbage. This matters because
"route the error to stderr" is **already correct** and is therefore not the fix.

**And the flag was redundant, not unimplemented** — which made the fix small. These verbs already
emit JSON on stdout; `--json` had nothing left to do. So they now **accept and ignore** it,
one entry per allow-list, rather than growing an output mode.

**A third claim in the same report is refuted, and the cause is worth keeping.** Wren reported
that `token mint` prints prose above the JSON, so `> cred.json` is unparseable even on success.
Measured separately: stdout is **pure JSON**; the prose is **already on stderr**. The
prose-above-JSON that several of us had been stripping with `sed` appears only when the capture
merges the streams with `2>&1` — which is what the Lead's own rig did before writing a regex to
work around a problem it had created. **Three agents built a workaround for their own redirection.**

**Controls** (`tests/p1-cli/d064-json-flag-parity.test.ts`, reached by `test:p1-cli`'s glob):
each verb pairs "does not refuse `--json`" with a same-invocation control asserting a genuinely
unknown flag *is* still refused — because deleting the option validator entirely would satisfy
the first assertion and is a worse defect than the one being fixed. Mutation-verified: reverting
the `invite` fix alone fails the `invite` case and leaves the other two passing.

**The control needed a value, and that is a finding of its own.** A bare `--not-a-real-flag`
fails with *"--not-a-real-flag requires a value"* before the shape gate is reached, because an
unrecognised flag is not in `BOOLEAN_FLAGS` and is parsed as value-taking. So an unknown flag is
reported as a missing value rather than an unknown option — the same parser behaviour that made
`--local` silently unusable in 0.1.8 until it was added to that set.

## D-065 — `invite` needs an email address the product never shows you · MAJOR · OPEN

**Found by Wren, 2026-08-08, and only reachable from the invite-FROM direction** — which is why
running the reverse round was worth it. Every earlier round had the Lead as inviter, and the Lead
happens to know the invitee's address out of band.

`cswarm invite` takes `--email`. **No surface in the product shows anyone else's email.** Both
`status` and the new `members` verb render people as name plus user id:

```
- Tom Langridge (919ce195-…) — member — you
- Ridgeio (d37e2ff2-…) — owner
```

So a collaborator who has worked in two shared workspaces for two days, can see the other party's
user id, and can address their agents by UUID, **must leave the product and ask for an email
address** to add them to a third. Wren demonstrated it live by being blocked mid-round.

**Measured scope, before proposing a fix.** The protocol already models this:
`src/protocol/workspace-commands.ts:34` declares `email: string | null`, and the reducer's
`inviteeAlreadyMember(cmd.email)` takes a nullable. **The wire contract does not:**
`supabase/functions/command/index.ts:92` types the request as
`{ kind: "invite_member"; email: string; ttl_ms?: number }` — non-null and required.

**So every candidate fix needs a `command` edge deploy**, and that is the finding's real cost:

| candidate | needs |
|---|---|
| invite by user id, for someone already visible to you | `command` edge change + deploy |
| link-only invite (`email: null`) | `command` edge change + deploy — **the reducer already supports it** |
| show emails to co-members | a read-path change; `read` is under the D-047 freeze |

The second is the smallest by code and the largest by consequence: an invite with no addressee is
a bearer capability for the workspace, and §8 already treats invitations as a
branded-phishing vector. The first leaks nothing new — it names only what the caller can already
see — and is the one Wren recommends starting from.

**Not established:** whether `command`'s deployed v16 would accept `email: null` today if the
client sent it (the wire type is TypeScript, not necessarily a runtime check); whether
`inviteeAlreadyMember(null)` returns false as the reducer's typing implies; and whether an
invitation row with a null email breaks any later acceptance path. **None of these were probed** —
`command` is the write path for everything, so a deploy is an operator decision and none of this
was tested against production.

## D-066 — the installer told a stranger to echo a live capability to their screen · MINOR · FIXED

**Found by Wren on the shipped installer, 2026-08-08.** `install.sh` printed:

```
read -r LINK    # paste the link, then press Enter
printf %s "$LINK" | cswarm accept --link-stdin
```

directly above the sentence *"The link is piped in rather than passed as an argument, because an
argument would leave a live capability in your shell history and in the process list."*

`read -r` echoes as you type, so the single-use invite link lands on screen and in scrollback.
**The stated reason was correct and the method two lines above it did the thing the reason
forbids.** `README.md:254` already uses `read -rs` for the agent-token path.

Fixed to `read -rs LINK; echo` — the trailing `echo` restores the newline `-s` swallows.
Verified in both shells a user is likely to paste into, with the old form as a control:

```
bash   read -rs LINK; echo  ->  cswarm://accept/TESTLINK
zsh    read -rs LINK; echo  ->  cswarm://accept/TESTLINK
zsh    read -r  LINK        ->  cswarm://accept/TESTLINK   (control: -rs is not silently broken)
sh -n install.sh            ->  parses clean
```

**Nothing in a gate executes this text**, which is how the previous fiction in the same block
(*"paste the link when prompted"*, against a `--link-stdin` that refuses a TTY) survived to
production. Both were found by a second-machine dogfood and neither by a test.

## D-067 — instruction text written for a different reader than the one receiving it · MAJOR · PARTLY FIXED

**Wren's framing, adopted verbatim, and filed as ONE entry at its suggestion rather than three
separate copy defects.** The unifying fault is not wording; it is that each message names a
remedy the reader it reaches cannot perform.

| instance | told the reader to | why that reader cannot |
|---|---|---|
| `install.sh`: *"paste the link when prompted"* | wait for a prompt | `accept --link-stdin` refuses a TTY; there is no prompt. **Fixed.** |
| 3-project cap: *"ask whoever operates this deployment"* | ask the operator | on this deployment the account holder **is** the operator, and there is no CLI or web path. **Open — see finding 10.** |
| no-target error: *"values from the deployment operator who invited you"* | ask their inviter | self-serve signup is **live**; a reader who created their own workspace has no inviter. **Fixed here.** |

**Fixed in this entry:** both no-target messages (`src/cloud/current-target.ts:231`,
`src/cloud/config.ts:14`) now read *"from whoever runs this deployment, or from your own
project's API settings if you created it"* — naming a route for each reader and assuming
neither.

**A copy control was holding the defect in place.** `tests/p1-cli/cli-errors.test.ts` required
the literal `/deployment operator who invited you/`, so the gate actively defended a sentence
that sent self-serve users to nobody. Replaced with what the message must **do** — name both
routes, assume neither — rather than the words it happened to use. **This is the fourth control
in this repo found pinning a claim rather than a behaviour**, after the `logout` overclaim, the
`every session` string, and `visible only to its recipient`.

**Why this family keeps recurring, and it is not carelessness.** Every one of these sentences was
written by someone who knew exactly who they were talking to, and was right at the time. What
changed was the population: `--link-stdin` replaced a prompt, self-serve replaced invite-only,
and the operator became the user. **Availability and audience are deployment state, and this repo
already knows that copy asserting deployment state goes stale silently — that is D-023.** The
new part is that it applies to *who the reader is*, not only to *what is available*.

**Not established:** whether a self-serve user can obtain their URL and anon key from any product
surface at all. The corrected text says "your own project's API settings", which is true of
Supabase but was **not verified as reachable from anything CommonSwarm shows them**. If it is
not, the sentence is honest and still a dead end, and the finding is larger than copy.

## Agent-path statelessness — now gated

Not a defect. An invariant nothing was protecting, recorded because the gate exists because of
it: `tests/p1-cli/agent-path-stateless.test.ts` asserts an agent verb writes **zero files** into
a pristine `HOME`, and that it fails at the network rather than at configuration.

Found by Wren with a better instrument than the one it was asked for. Told to log out for a cold
walk, it declined — its browser automation was down, so it could not establish which identity a
re-login would take, and a wrong one would have destroyed the cross-user rig. It pointed `HOME`
at an empty directory instead: repeatable, risk-free, and strictly more controlled.

Wren named the exact regression: someone shortens the four-flag invocation by requiring a saved
target, which breaks the only path that works from nothing — the property that makes the
verbosity tolerable. Mutation-verified against precisely that change.

**Measured refinement:** files are zero; **two empty directories** are created, identically for a
full artifact, one without `expires_at`, and a bare token. Wren's claim was about files and is
exact; "leaves nothing behind" would have been slightly overstated, so the gate asserts on files.

## D-068 — accepting an invite silently reselects your default workspace · MINOR · FIXED

**Found by Wren, replicated independently by the Lead in the opposite direction.** Both machines,
both invite directions, identical behaviour.

`cswarm accept` always sets the default workspace to the one just joined, and narrated it as:

```
Your default workspace is now "…" (was another workspace).
```

Every later command without an explicit `--workspace-id` now targets somewhere new. The line
tells the reader that happened and **withholds the one fact that lets them undo it**. Wren was
moved off its own prod-dogfood workspace mid-round; the Lead was moved off `CommonSwarm Build`.

Fixed to name it and the remedy:

```
Your default workspace is now "…" (was 4f63d2b0-…; switch back with cswarm use 4f63d2b0-…).
```

**A gate asserted the id was absent, and that was a deliberate pin — so it was checked before
being changed rather than edited to make a diff pass.** `accept-link.test.ts` carried
`assert.doesNotMatch(message, new RegExp(previous))`. What the check found:

- `docs/design/P2-CONNECT-UX-BRIEF.md:141` specifies this exact line as
  *"Your default workspace is now "\<new\>" (was "\<old\>")"* — **the brief wanted the previous
  workspace identified.** The shipped text identifies nothing.
- The likely cause is availability, not policy: `previousDefault` comes from the stored profile,
  which holds an id and no name, and a bare uuid read badly as prose. **The assertion pinned an
  implementation limitation.**
- No security rationale exists. `previous` is the user's own prior default from their own local
  profile — not the forged `hint`, which is a separate test — and a workspace id is not a
  capability; it appears in every `--workspace-id` invocation.

The id is shown rather than the name because resolving the name needs a network call, and
`accept` should not make one to decorate a sentence. `previous_workspace_id` was **already in the
event's `data` payload**, so the fact was present and hidden from the human — the same shape as
D-062, where `to_agent` carried the answer under `--json` for twenty hours.

**This is the fifth control in this repo found pinning wording rather than behaviour**, and the
first that was pinning it *deliberately*. The others were the `logout` overclaim, `every session`,
`visible only to its recipient`, and `deployment operator who invited you`.

**Non-author read completed — Wren, 2026-08-08. Override upheld, with one correction to the
justification and one improvement recorded.**

**The stronger argument, which the Lead did not make.** `accept-link.ts:214`:

```ts
const workspaceName = sanitizeDisplayLabel(payload.workspace_name, "this swarm");
```

The **new** workspace name — already rendered prominently in quotes in this very sentence — comes
from the **link payload**. It is attacker-controlled and merely sanitized. So the shipped message
has always echoed an *untrusted* workspace identifier. If a policy existed against disclosing
workspace identifiers here it would bite the untrusted one far harder than the trusted one, so no
such policy exists. **The change adds local trusted data to a message that already renders remote
untrusted data, and is therefore strictly safer than what shipped before it.** Verified
independently by the Lead at the same line.

**CORRECTION to this entry's own reasoning, and it is Wren's criticism.** The brief specifies
`(was "<old>")` — quoted, in the same form as `"<new>"`, which the code renders as a **name**.
What shipped is a bare uuid. **So the brief authorises the change and not the format, and citing
"the brief specifies this line" as the justification quoted the source for the half that helped.**
The honest statement is: *the brief's format is knowingly not met, because the previous
workspace's name is unavailable without a fetch that does not exist at this point* — the same
implementation-limitation reasoning, applied to the format as well as to the omission. Both halves
or neither.

**Recorded as an improvement rather than a deviation:** `switch back with cswarm use <id>` is
**better than the brief**, which only wanted the user informed. Wren asked that this not be lumped
in with the format deviation, and it should not be.

## Observation — `new` does not create a principal; `accept` does

**Measured 2026-08-08, not filed as a defect because the intent is unclear.** Wren created
workspace `0d499d2d` with `cswarm new` and holds **no agent principal in it**. The Lead accepted
an invitation to the same workspace and got one automatically: `yulanbot@mac.lan-986ece6e`.

```
People:  Tom Langridge (919ce195-…)      <- created the workspace, no agent
         Ridgeio (d37e2ff2-…)
Agents:  yulanbot@mac.lan-986ece6e (ea944bf0-…)   <- created by the accept
```

**Why it may matter.** The auto-created name is `<unix-user>@<hostname>-<device-prefix>` and is
collision-resistant by construction — now confirmed on **two different hosts**, so the D-062
result generalises rather than describing one machine. But a **self-serve user who creates their
own workspace never goes through `accept`**, so they have no principal and must run
`principal create --name` — which after D-062 is *the only remaining route to the name-collision
class*. The solo path pushes users onto the one verb that can still produce the defect.

**Not established:** whether `new` omitting a principal is deliberate, and whether the site's
`/start` flow creates one where the CLI does not. Neither was probed.

## D-069 — an invitation could not be revoked · MAJOR · FIXED

**Found 2026-08-08 while trying to honour a commitment**: Wren and the Lead had each agreed to
revoke the other's invite link after the round. There was no way to do it.

An invitation is a **bearer capability with a TTL of up to seven days**, and it was the only
capability in the product that could not be withdrawn. `principal revoke`, `token revoke` and
`link revoke` all existed. A link that was forwarded, pasted into a chat, or read over a shoulder
had **no remedy at all**.

**The server had supported it the whole time.** Measured with a control:

```
revoke_invitation in the reducer            3
revoke_invitation in the command edge       9
revoke_invitation in src/cli.ts             0
invite_member    in src/cli.ts              1   <- control: the grep works
```

So this is a **client-only** fix — `cswarm invite revoke --invitation-id <uuid>`, no edge deploy,
nothing near the D-047 freeze. Same shape as D-062, where the deployed `read` already answered
`resource: "members"` and no verb called it. **Twice in one day, the server was ahead of the CLI
and the gap read as a missing feature.**

**Verified end to end on production, with the control that makes it evidence:**

```
invite  --email tom+cswarm-revoke-test@ridge.io   -> invitation 0e3b46fb-…
invite revoke --invitation-id 0e3b46fb-…          -> "Invitation revoked. The link no longer works…"
invite revoke --invitation-id 0e3b46fb-…  (again) -> refused: invitation_not_live
```

The replay is what proves the first call changed state rather than merely returning success. Two
further live refusals confirmed the authority checks independently: `role_forbidden` when a
*member* of someone else's workspace attempted it, and `invitation_not_live` for an invitation the
invitee had already accepted.

**A defect was introduced and caught inside the same change.** The first refusal message read
*"The invitation was not revoked: … Anyone holding the link can still use it."* That second
sentence is **false for the commonest refusal**: `invitation_not_live` means the invitation was
already accepted or revoked, so the link is dead — and the message would send an operator to
panic about a spent capability. Removed. **This is D-060's cause-splitting exactly**, reproduced
by the same author who wrote up D-060, which is the argument for the non-author rule rather than
against it. A test now asserts the refusal claims nothing about the link's usability.

**Note for the invite path generally:** a same-user replay of an accepted link short-circuits to
*"You're already a member"* **before the token is consumed**, so that outcome establishes
idempotency for the accepting user and says **nothing** about whether the token is still live for
a *different* identity. That was not tested — it needs a third identity — and it is the reason
revocation matters rather than a substitute for it.

## D-070 — `cswarm members` reported "nobody yet" for a workspace it could not see · MAJOR · FIXED

**Found by Verity, 2026-08-08, reviewing `cswarm members` as a non-author within hours of it
shipping.**

The read edge answers a workspace the credential is **not scoped to** with
`200 {members: [], agents: []}`. That is deliberate and correct: a `403` would be a
workspace-existence oracle. What was wrong was the CLI translating it into

```
People:
- nobody yet

Agents:
- none yet
```

at **exit 0** — an assertion that the project is empty, which the command cannot establish.
Verity's phrase: **"the product manufacturing a zero."**

**This is the confident-zero failure the repo's entire doctrine exists to prevent, produced by
the verb built to stop people manufacturing confident zeros, and caught by a non-author within
hours.** It is the single cleanest argument for the non-author rule this session has produced —
the author had just written a comment about not guessing owners, and shipped a guess about
emptiness in the same function.

Fixed by saying what is true:

```
Nothing is visible here with this credential.

This project may have no members and no agents yet, or this credential may not be
scoped to it. The server answers both the same way — on purpose, so that asking about
a project cannot reveal whether it exists — so this command cannot tell you which.
```

**The boundary is the interesting part, and it is gated.** Ambiguity is total only when **both**
lists are empty. If people are visible the credential is demonstrably scoped to the workspace, so
an empty agent list is a fact and `none yet` stays. Applying the caution everywhere would trade a
false claim for a useless one. Mutation-verified by changing `&&` to `||` — the plausible "be
safe everywhere" edit — which fails only the discriminating test.

A second test asserts the cautious wording **does not resolve the ambiguity in the other
direction**: no "not authorised", "no such project", or "does not exist". Copy that resolved it
would reintroduce the oracle the server is deliberately avoiding, which would be worse than the
defect being fixed.

**Extracted as `renderRoster()`** so the claims are gated as pure values rather than observed
against a live deployment.

### CORRECTION — the first fix replaced a false claim with a different false claim

**Found by Verity, 2026-08-09, hours after the wording shipped in v0.1.10.** The replacement said:

> *"…so this command cannot tell you which."*

**It can tell.** An empty roster means, with certainty, that the credential is **not scoped** to
that project — because the first disjunct is unreachable. **A workspace can never have zero
members, and the protocol enforces that as an INVARIANT rather than a rule.** Verified line by
line rather than taken:

```
workspace-reducer.ts:125    WorkspaceCreated seeds owners_count: 1
workspace-reducer.ts:60     actual < 1  ->  StreamIntegrityError    (a CORRUPT STREAM, not a refusal)
workspace-commands.ts:547   last Owner cannot be removed
workspace-commands.ts:583   last Owner cannot be demoted
workspace-commands.ts       no leave / self-remove command exists   (0 hits; control remove_member = 3)
read/index.ts:309-314       SELECT … FROM swarm_read.member_profiles WHERE workspace_id = …
member_profiles             gated on is_member, then returns EVERY live membership
```

So a scoped reader always sees at least one owner. Both lists empty ⟹ not scoped.

**And saying so leaks nothing — which is what the first attempt got backwards.** Verity's
distinction, and it is the whole finding:

| ambiguity | must it be hidden? |
|---|---|
| **existence** — does this project exist at all | **Yes.** Preserved: the sentence is *identical* whether the project is absent or present-without-you. |
| **scope** — is this credential in it | **No.** It is the caller's own state, and the only actionable half. |

**The first fix protected existence by also hiding scope. Scope never needed hiding.** Now:

> *"This credential is not scoped to that project. That is all this command can tell you: the
> answer is the same whether the project does not exist or exists without you. Asking about a
> project must not reveal whether it is real, so the two are deliberately indistinguishable."*

**This is the second false claim in the same three lines, both caught by the same non-author.**
The first asserted emptiness; the second asserted an ambiguity that does not exist. Being cautious
is not the same as being accurate — a hedge can be exactly as false as an overclaim, and it is
harder to notice because it sounds humble.

## D-071 — the roster is unbounded and unpaginated · MINOR · OPEN

**Found by Verity, same review.** The `members` read takes no `limit` and offers no pagination,
while `inbox` and `feed` cap `--limit` at 1..100 and reject 200. So one read surface is bounded
and its sibling is not.

That is the answer to "what happens with 100+ agents": everything is returned in one response.
Not exploitable by a member — the data is already theirs to see — but it is an unbounded
response on a serverless function, and the inconsistency will surprise anyone who learned the
limit rules from `feed`.

**Not fixed here: it needs a `read` edge change and `read` is under the D-047 freeze.** Recorded
rather than attempted.

## Disclosure: agent names are visible to every member — now said out loud

**Raised by Wren, remedy proposed by Verity, both non-authors.** Any member can list every
agent principal's **name**. Names like `wake-replier` or `uxtest-fixture-r1` disclose what someone
has been working on, and eventually one will be named after a customer or an unreleased feature.

Concealment is not available — addressing depends on names being visible — so the remedy is to
say so at the one moment a person chooses one. `principal create` now ends: *"Its name is visible
to everyone in the project, so avoid naming it after anything private."*

**Deliberately not filed as a defect.** In a shared-workspace product this is intended behaviour;
what was missing was the disclosure, not the concealment.

## CORRECTION to D-069 — the "live unrevoked link" exposure did not exist

**Both parties asserted it. Neither measured it. It was false.**

The Lead wrote: *"your link is currently UNREVOKED and live until its TTL."* Wren wrote: *"my
invite link 4f8269b4 stays LIVE AND UNREVOKED until 0.1.9 ships."* On 0.1.9 Wren's first revoke
attempt returned:

```
cswarm: The invitation was not revoked: invitation_not_live.
```

It had been consumed when the Lead **accepted** it, hours before either claim was written.

**How each of us got there is the same mistake in opposite directions.** The Lead tried to revoke
it and got `role_forbidden` — an authority refusal that fires *before* liveness is evaluated, so
the attempt never reached the question. Wren had no verb at all. **Each inferred exposure from
their own inability to act.**

**And the Lead had already measured the answer.** Hours earlier, revoking the *symmetric*
invitation — its own invite to Wren, likewise already accepted — returned `invitation_not_live`.
The same code, on the same day, for the same reason. **The evidence for the general case was in
hand and the opposite conclusion was published about its mirror image.**

For roughly two hours this register carried a live-capability exposure that did not exist. The
practical cost was nil. The reasoning cost is not: **had the exposure been real, the identical
reasoning would have been just as confident**, and nothing in it depended on the answer.

The verb itself is unaffected and works. Wren exercised **both** paths with controls, creating a
throwaway invitation specifically to reach the success path *because* its real one was already
dead — "otherwise I would only have tested the refusal and called the verb verified":

```
failure  exit 1, stdout EMPTY, stderr "The invitation was not revoked: invitation_not_live."
success  exit 0, stdout "Invitation revoked. The link no longer works, and anyone who already
                         accepted it stays a member — remove them with cswarm member remove."
```

**Residual, low severity (Wren):** `invitation_not_live` collapses **three** states — accepted,
revoked, and expired. For "is my capability safe?" all three are reassuring, so the severity is
low. But only *accepted* means a stranger may now be a member, and the code does not distinguish
it. Separating them needs a `command` edge change; **not attempted**.

## D-063 — CLOSED. Renewal fires from a signal verb, measured on the shipped artifact

**Plumb, 2026-08-09, against the PUBLISHED 0.1.9** (`sha256 fa0ca332…6555a`, installed from the
live installer). This was the last unestablished piece of D-063 and had survived two rounds.

```
mint      --ttl-ms 300000  ->  token_id bddb4ab5…  expires 02:44:00.599Z
before    successor files in a pristine HOME: 0
call 1  02:39:24Z  stderr "predecessor_pending_first_use"; exit 0, 1 signal; files still 0
call 2  02:39:41Z  exit 0, 1 signal; NEW successor-3dbdc39f….json
                   mode 600, generation 1, pending null,
                   token_id 82e80f24…  root_token_id bddb4ab5…
call 3  02:39:59Z  exit 0; mtime unchanged -> adopted without rewrite
cleanup   successor self-revoke accepted; then "signal read failed (HTTP 403): forbidden", exit 1
```

**So a one-shot signal verb does renew**, inside the lead window, writing a successor bound to its
predecessor — and the third call adopts it rather than minting again. The entry's surviving claim
(*"renewal is lazy; an agent idle across its window cannot be saved by any wiring"*) stands, and
the corollary is now measured rather than inferred: **an agent that runs commands more often than
the lead window is fine today**, exactly as the corrected entry said.

Two details worth keeping. `predecessor_pending_first_use` on the first call means the root token
must be *used* once before a successor can be issued — so renewal needs two invocations, not one.
And the post-revoke `403` is the positive control: without it, "no more successor files" would be
indistinguishable from a dead probe.

## D-072 — `member remove` promised that signing in again would let you retry · MAJOR · FIXED

**Found by Wren, 2026-08-09, walking verb paths nobody had exercised on the shipped 0.1.9.**

```
$ cswarm member remove <owner-id> --confirm <owner-id> --workspace-id <ws>
cswarm: Sign in again with cswarm login, then repeat the member remove command.
        No membership change was recorded.
```

Wren was signed in — `cswarm workspaces` listed all six projects seconds later — and is only a
**member** of that workspace, so it could never remove anyone there.

**The diagnosis in the original report is wrong, and the difference decides the fix.** Wren read
this as *"reports an authority failure as an authentication failure"*. It does not. Measured from
the code rather than inferred: `ReauthenticationRequired` is thrown **only** on
`401 && error === "fresh_auth_required"`, and the server's fresh-auth gate sits inside
`handleTransaction` at step 7 — **before** the reducer evaluates authority. So the server
genuinely returned an authentication refusal and had *not yet looked* at the caller's role.
**Reporting `role_forbidden` here would have swapped one false cause for another.**

The real defect is the **implied promise**. The reducer's next gate is *"removing members requires
Owner/Admin"*, so for a non-owner the advice buys a browser OAuth round trip and a second wall
with no new information.

**And the cost is not hypothetical.** It was found on a machine whose browser automation was
broken, where signing out can strand the seat entirely — **the message recommends the exact
action its reader had refused to take the day before, for that reason.**

Fixed by stating both gates:

> *"Removing a member needs a recent sign-in. Run `cswarm login`, then repeat the command. No
> membership change was recorded. This is a separate check from permission — removing a member
> also requires Owner or Admin, and that is only checked once the sign-in is fresh."*

Gated both ways: the message must name the Owner/Admin requirement, **and** must not assert
`role_forbidden` or "you lack permission", which the server has not established. That second test
exists because over-correcting is the same D-060 family — **the fourth instance this session.**

**Wren's control is what made it a finding rather than a guess:** the same account, same
workspace, same authority gap, through `invite revoke`, reports `role_forbidden` correctly. So
the server distinguishes the two perfectly well and one verb's copy did not.

## D-073 — server errors printed twice, rendered then raw · MINOR · FIXED

**Found by Wren, same walk.**

```
$ cswarm use 00000000-0000-4000-8000-000000000000
exit 1, stdout 0 bytes, stderr 255 bytes containing BOTH:
  cswarm: That project is not available to this account. Run cswarm workspaces to see …
  {"code":"project_not_available","message":"That project is not available to this account. …"}
```

No `--json` was requested. The `main().catch` handler's **human** branch ended with a trailing
`process.stderr.write(JSON.stringify(structured))`, after the `--json` branch had already covered
machine output.

**Scope, which is the useful part:** it followed the **error class**, not the verb. Reproduced on
`use`, `status` and `feed`; **client-side** errors printed once (`unknown option: --json`,
`invitation_not_live`, `--confirm must exactly repeat the member selector`). That is why it
survived — it never appeared in the failure modes anyone was testing.

Removed rather than reformatted: nothing pinned it, the originating commit (`6f023a7`) gives no
rationale, and a caller wanting the object has `--json`. The gate pairs "no dump on the human
path" with a control asserting the machine form still exists — otherwise it would also pass on a
handler that had stopped emitting JSON entirely.

**Sixth control found pinning wording rather than behaviour** (`pending-command.test.ts` required
the literal `Sign in again`). Its actual subject is command-id retention across the post-login
retry; the message match was incidental, so it now pins `cswarm login` and the full sentence is
asserted in one place.

## D-074 — `listen stop` returns mid-teardown and offered no way to confirm · MINOR · FIXED

**Found by Wren, 2026-08-09**, walking the listener surface nobody had touched.

```
stop  ->  state "stopping", stoppedAt null, pid 3587
after ->  3587 gone, 3597 gone, 0 opencode acp, 0 supervisors
```

The teardown was clean. The point is the **response**: `listen stop` exits 0 while the child is
still going away.

**Wren's reading was that the response cannot distinguish "stopping and will succeed" from
"stopping and will fail". Measured, it can** — the state word is `stopping`, not `stopped`, and
`renderListenerStatus` prints `Listener stopping for agent …` verbatim. The response is honest.

**What was missing is the third part of this repo's own standard for CLI output** — *what
happened, what is now true, and what happens next.* A verb the user just invoked, exiting 0,
reads as done; nothing told them how to find out. Transitional states now say so:

> *"This is still in progress. Confirm with: `cswarm listen status --workspace-id … --principal-id …`"*

Applied to `stopping` **and** `starting`, since `listen start` has the same shape.

**Not a defect, and worth recording as such:** `listen start --provider claude` refuses with
*"claude-agent-acp is not installed; run npm install -g @agentclientprotocol/claude-agent-acp@0.64.2,
then retry"* and **spawns nothing** — supervisor count zero after, so there is no half-started
state. Exact package, exact version, exact remedy, checked before anything starts. Wren asked for
it to be recorded next to the messages it has complained about.

**Still unexercised, and now the largest untested surface:** the **claude and codex adapters have
never run here.** The version pin is enforced before anything spawns, which is correct and also
means neither path has ever executed. Testing them needs a global `npm install -g` on a
collaborator's machine — **an operator decision, not the Lead's**, and Wren correctly declined to
do it unasked.

## D-075 — workspace archiving is designed, honoured by the cap, and unreachable · MAJOR · MITIGATED, not fixed

> ### CAP RAISED 3 -> 10, DEPLOYED 2026-08-09. Archiving is still unreachable.
>
> Operator decision: *"there's no UI mechanism for deleting a workspace, so either add one or more
> simply increase the limit."* Raising it is the smaller change — it needs no new command kind, no
> reducer case, and no answer to whether an archived workspace stays readable to its members.
>
> `command` **v16 -> v17**. `read` untouched at v6, so the D-047 freeze is intact.
> `SELF_SERVE_CREATE_DAILY_LIMIT` raised 6 -> 20 in the same change, because at 6 it would have
> become **smaller** than the live cap and silently inverted the invariant its own comment states.
>
> **Verified on the real user path**, not from the deploy log: a fourth workspace was created
> (`cac2181e-…`) where the same command failed an hour earlier.
>
> **Three pre-deploy checks, because `command` is the write path for every verb:**
> - the linked ref `ukezjcnxjvkpkeezxaew` matches the **live page's own meta tag**;
> - the generated `_shared/protocol.js` regenerates to an **identical hash**, so it was not stale;
> - `command/index.ts` was **unchanged since the commit v16 shipped from**, against a control
>   showing `src/cli.ts` moved 615+/46− over the same range. So the deploy carried exactly this
>   diff and nothing else.
>
> **This entry stays open in substance.** The cap is no longer a hard ceiling, but `archived_at`
> still has zero writes, and a user who reaches 10 has the same problem one order of magnitude
> later. The right fix is still a way to remove a project.
>
> **Confirmed independently from the second machine** (Wren, 2026-08-09), which is the half the
> Lead could not do: a different account, on a different host, went from **3 owned to 4** against
> the same v17 function — the same command that had failed an hour earlier. So the raise is not
> specific to the deploying account or machine.
>
> **Not established:** that the limit is exactly 10. Two accounts have each proved it is no longer
> 3; proving the boundary would mean creating ten workspaces on production, which is not worth it.

**Measured 2026-08-09, after the 3-project cap blocked a release-verification test.**

`swarm.workspaces.archived_at` exists in the schema. The free-tier cap **reads it and honours
it**, and the server says so in its own comment:

```sql
-- Counted inside the transaction and against created_by, so two concurrent
-- requests cannot both read limit-1. Archived workspaces free their slot.
SELECT count(*)::text AS live
FROM swarm.workspaces
WHERE created_by = ${auth.actor.user}::uuid
  AND archived_at IS NULL
```

A second cap exists **because** archiving was expected to work: `SELF_SERVE_CREATE_DAILY_LIMIT = 6`
is *"deliberately larger than `FREE_TIER_WORKSPACE_LIMIT` — a user who archives a mistake and
starts over must not be locked out for a day."*

**Nothing anywhere sets `archived_at`.** Measured with a control:

```
writes to archived_at   0
writes to revoked_at    3     <- control: the search works
archived_at in schema   2 tables
```

So the column exists, the cap query honours it, two separate limits are tuned around it, the
`workspaces` JSON returns `archived: false` on every row — **and no command kind, no CLI verb, and
no page can ever change it.** The feature is fully designed and half-built.

**It is now blocking work, not just annoying.** Both the Lead and Wren hold three owned
workspaces. Neither can create a fourth. The remaining release-verification test — `invite` →
`accept` exercised on 0.1.9 rather than 0.1.8 — needs a fresh workspace and is therefore
**unreachable by either party**. The cap is stopping a test of the release it shipped with.

This is finding 10 sharpened from *"the CLI cannot archive one yet, so ask whoever operates this
deployment"* to something more specific: **there is nobody to ask.** No operator surface exists
either. The message names a remedy that does not exist anywhere in the product.

**Fix needs a `command` edge change** — a new command kind that sets `archived_at`, plus a CLI
verb. `command` is not under the D-047 freeze, but it is the write path for every verb, so
deploying it is an operator decision. **Not attempted.**

**Not established:** whether an archived workspace remains readable to its members (the `read`
paths filter `archived_at IS NULL` in at least three places, so members may lose access rather
than merely hiding it); and whether `repositories.archived_at`, the second column, behaves the
same way. Neither was probed.

## D-072 — CONFIRMED from the owner's side

Wren, 2026-08-09, holding **owner** on `0d499d2d`:

```
$ cswarm member remove d37e2ff2-… --confirm d37e2ff2-… --workspace-id 0d499d2d-…
exit 1, stdout empty
cswarm: Sign in again with cswarm login, then repeat the member remove command.
```

**Authority was not in question and the fresh-auth gate fired anyway.** That is the mechanism this
entry describes — `handleTransaction` step 7 runs before the reducer looks at role — measured from
the side that has the role. The wording is the pre-fix text because Wren runs shipped 0.1.9 and
`d83ba3e` is on `main` and unreleased; that is consistent, not a regression.

**And the cost named in the original entry stopped being hypothetical.** It now blocks the last
untested destructive path. Fresh sign-in needs an OAuth round trip; Wren's browser automation is
down; and Wren will not re-authenticate while it cannot verify which GitHub identity the browser
holds — it flipped between two identities twice in one day, and the wrong one destroys the
cross-user rig. **Wren declined to gamble an identity to close a test, which is correct.**

Unblock path, **operator's call**: `cswarm login --no-browser` prints the OAuth URL for a human to
open by hand. Wren declined to hand the operator a login prompt unasked.

---

## Register hygiene — four entries were stale on 2026-08-09, and one cost real work

Checked every `OPEN` entry the Lead had not personally handled this session. **Four of them were
already fixed:**

| entry | state on paper | measured |
|---|---|---|
| D-050 | OPEN, and listed under "STILL OWED" in the resume file | fixed in `9ba92e2`, gated, mutation-verified |
| D-062 | `OPEN` heading over a body recording both fixes | fixed in v0.1.9 |
| D-063 | `OPEN` heading over a body recording the correction | closed by measurement |
| D-038 | OPEN | the CLI parses the web form; verified with a refusal control |

**D-050's staleness was not free.** The Lead read the register *and* the resume file, believed
both, and sent Wren to hunt a defect that had been fixed for days. Wren walked an `opencode`
teardown — a different code path from the one the entry describes — and reported a
non-reproduction against a claude-adapter defect. Two agents, one wasted round, because a heading
disagreed with its own body.

**The rule that follows, and it is cheap:**

> **Check the heading against the body before acting on an entry, and re-measure before
> dispatching anyone.** A register is consulted precisely when someone does not already know the
> answer, so a stale entry is at its most dangerous exactly when it is used.

The failure mode is specific: an entry gets a correction appended to its **body** — because that is
where the reasoning goes — and the **heading** is left alone. Everything downstream reads the
heading.

## Testing trap — the version string does not identify the artifact

**Cost one wrong measurement on 2026-08-09, and nearly invalidated a release-verification result.**

```
node dist/cli.js --version   ->  cswarm 0.1.9 (protocol 0.1.0)
released artifact --version  ->  cswarm 0.1.9 (protocol 0.1.0)
```

**Identical, and they are different code.** `dist/cli.js` is built from `main`, which at that
moment carried four fixes the released 0.1.9 did not. The version comes from `package.json`, which
is bumped at release-prep time and then keeps reporting the new number for every later commit.

Compounded the same minute: the dogfood rig at `/tmp/cswarm-dogfood/bin/cswarm` was still
**0.1.8** — nobody had upgraded it after shipping — and it was grepped in the belief it was 0.1.9.
So one check measured local `main` and the next measured the previous release, while both were
being called "0.1.9".

**What resolves it, and nothing cheaper does:**

```
sha256 of the artifact you are actually running, against the published release hash
git merge-base --is-ancestor <fix-commit> <release-commit>     # did the fix ship, or land after?
```

**And a second trap inside the first:** grepping a bundle for a copy string matches **comments**,
because esbuild keeps them. `was another workspace` appeared in the released binary and looked
like unfixed copy; it was the fix's own comment — `was another workspace)" told`. The live
template was there too. **Grep the interpolation, not the prose**, or read the surrounding bytes.

**It fired again during the 0.1.10 verification, one hour after this note was written.** A
must-be-absent control on `ask whoever operates this deployment` returned **1** where it required
0. The hit was line 22162 of the bundle:

```
/* D-067/D-075. This used to end "Archiving a project frees its slot
 * one yet, so ask whoever operates this deployment." Both halves were dead ends.
```

The comment explaining the fix contains the string the fix removed — **which is true of every
well-documented copy change in this repo**, so this will keep happening. Writing the note did not
prevent it; it made the diagnosis fast instead of alarming.

**So a must-be-absent control on a bundle is only trustworthy paired with a must-be-present
control on the live form.** Here: `Projects cannot be removed yet` present in the interpolated
template settled it, and the raw absence count never could have.

**Option not taken:** stripping comments from the release bundle would remove the hazard and
shrink the artifact. Not done mid-release — it would change the bytes of a build already verified
and published.

Related: `AGENTS.md`, *"measure the artifact, not its name"*. This is that rule applied to a
version string, which is the most convincing name an artifact has.

## D-076 — the intermittent read 503 is a postgres.js null-socket crash · MAJOR · OPEN, blocked

**Root cause found by Plumb, 2026-08-09**, by joining the Supabase Management API logs on
`request_id`. This closes the only measured production fault that had survived the dogfood.

```
13:17:01.831Z  Boot           read f4d3de40-…, deployment v6, execution 6a616526-…
13:17:02.564Z  UncaughtException  TypeError: Cannot read properties of null (reading 'write')
                                  at postgres/3.4.9/src/connection.js:255  nextWrite
                                  then Deno timer/event-loop frames
13:17:02.729Z  POST 503 /functions/v1/read   request_id 019fe185-…, 1222ms, x_served_by=base/server
```

**The crash is outside the handler's promise catch**, so the isolate dies and `base/server`
emits a 503 165 ms later. That is why the response carries no `request_id` from the function and
no error body of ours.

**Scale, with controls.** Positive controls on the query envelope: `function_edge_logs` 79,
`function_logs` 103, `supavisor_logs` 186. Over a full day: 25,580 function logs, **8 matching
crashes across 8 request_ids, and 8/8 join to a `POST 503 /read` row.** Not a one-off.

**Upstream is open, so upgrading does not fix it.** `postgres@3.4.9` is pinned in four places
across the edge functions. PR [porsager/postgres#1168](https://github.com/porsager/postgres/pull/1168)
describes this exact race — `nextWrite` scheduled via `setImmediate` firing after `closed()` has
nulled the socket — and adds a null guard. **Verified independently 2026-08-09: the PR is OPEN,
approved, unmerged, with multiple production reports.** There is no released version carrying it.

### Two of the Lead's inferences are DEAD

- ~~"A bare 503 with no `request_id` is the signature of something that never reached the
  function."~~ **Wrong.** It reached the function and the function crashed; the edge-log row's
  function/deployment/execution fields are **blank**, and filtering by function id therefore
  *hid* the 503. The absence of our metadata was caused by the very failure being looked for.
- ~~"Gateway/runtime is the leading class."~~ **Half right and misleading.** `base/server` did emit
  the 503, but the cause is in the function's own database driver. Naming the layer that reported
  the error pointed away from the layer that produced it.

### What is still not established

- **The pooler is not implicated and not exonerated.** Supavisor rows in the window are
  informational only — a client `Terminate` at 13:17:02.112 and `Connection authenticated` at
  13:17:02.474 — with **no** EMAXCONN, no max-client error, **and no request join key**. So the
  earlier retraction stands: no pooler attribution without a join, and the join does not exist.
- **Why the socket closed at all.** The null guard would stop the crash; it would not explain the
  close.

### Fix options, all blocked

`read` is under the **D-047 freeze**, and `main`'s `read` is four commits past deployed v6, so
any of these ships the durable-delivery work with it:

1. Vendor the one-line null guard from PR #1168 until upstream merges.
2. Wrap the driver call so the rejection reaches the handler's catch and returns our own error.
3. Treat a tagged 503 as retryable at the client — the crash is transient by construction, and a
   second attempt hits a fresh isolate.

**No source, config, database or deploy change was made in this investigation.**

## D-077 — the homepage claimed a capability the CLI refuses without an adapter · MAJOR · FIXED

**Found by Wren, 2026-08-09, within hours of the copy going live — and refuted with the product's
own error text rather than with an opinion.**

The shipped hero read:

> *"Hand an agent a credential and it can say what it is about to touch, ask another agent
> directly, and **wake one that is idle** — across accounts and across machines."*

Its structure makes **the credential the sufficient condition for all three**. Nothing on the page
qualified it — no caveat, and no mention of listeners or adapters anywhere.

**Tested on a pristine `HOME` with a credential and nothing else** (reproduced independently by
the Lead):

```
say what it is about to touch  -> "Signal shared. It is immutable and visible to members…"   TRUE
ask another agent directly     -> "Signal shared. It is immutable and visible only to …"     TRUE
wake one that is idle          -> REFUSED
  cswarm: --provider is required; supported providers: grok … opencode … claude … codex …
  You can use working-on, note, ask, and feed now; detached live receipt needs one of these adapters
```

**The CLI draws exactly the line the homepage erased.** Two of the three follow from the
credential; the third needs a pinned third-party adapter at a specific version plus its own
authentication. **The product was more honest than the marketing, and the refutation is a shipped
string rather than a judgement.**

**Two things make it worse than "only with `cswarm listen` running"** (Wren):

1. **`listen` is not available out of the box at all.** It needs grok 0.2.117, opencode 1.18.10, a
   global install of `claude-agent-acp@0.64.2`, or `codex-acp@1.1.9`. A new user has none, and
   **two of those four adapters have never been run anywhere by anyone.**
2. **Even with an adapter, what wakes is not the reader's agent.** Measured: Wren's listener
   reached `ready`, recorded `lastSignalId`, and **never touched its session** — it fed a spawned
   `opencode` subprocess. So the sentence means "wake a worker you provisioned", while a reader
   will understand "your teammate's agent lights up".

**Fixed** by adopting the CLI's own split rather than inventing wording: the hero now says
*"…ask another agent directly, and **read the feed** — across accounts and across machines."*
Every remaining verb works from a credential alone on a clean machine.

**Residual, recorded so nobody cites the rig for more than it showed:** the single cross-account
measurement (2026-08-08) used **two identities belonging to one human**. It is genuinely
cross-account in every sense the product enforces, and it is **not two people**. The h1 says
"your teammates' agents", and no rig has ever tested two humans.

**Why this one matters beyond the sentence.** Marketing copy is where a false claim is cheapest to
make and most expensive to ship, and this claim was written by the person who had personally
measured the wake path — and who therefore knew it needed a listener. **Knowing the caveat is not
the same as remembering it while writing a sentence that sounds true.**


## D-078 — a case-sensitive sweep left a live price contradiction · MINOR · FIXED

**Found by a Fable review of the homepage, 2026-08-09, hours after the Lead swept the same claim
and declared it clean.**

The deployed page said **"Free for up to 10 workspaces"** six times and **"Three workspaces, no
card"** once. Both live, on the same page, at the same moment.

**The cause is a method failure, not a missed file.** The Lead's sweep enumerated two spellings —
`3 workspaces` and `three workspaces` — and found eight places. `ConsumerStory.astro:95` reads
**`Three workspaces`** with a capital T. Every grep in both the sweep and the verification was
case-sensitive, so the same blind spot produced the miss *and* certified it as fixed.

```
grep -rn  'three workspaces'   ->  missed it        (the sweep)
grep -rc  'three workspaces'   ->  0, "clean"       (the verification)
grep -ric 'three workspaces'   ->  1                (the truth)
```

**The control passed and proved the wrong thing.** A positive control on `10 workspaces` returned
21, so the file was demonstrably being read. That establishes the *instrument* worked; it says
nothing about whether the *pattern* was right. **A must-be-present control does not validate a
must-be-absent pattern — it only proves the corpus is non-empty.**

Correct method, and it is one flag: enumerate the actual variants rather than guessing them.

```
grep -rn -io '[0-9a-z]* workspaces' src/ public/ scripts/ | sort | uniq -c | sort -rn
```

That returns every phrase shape present, and the capital-T variant is visible immediately. This is
the repo's own *"enumerate, don't pattern-match"* rule applied one level deeper: the Lead did
enumerate files and did enumerate two spellings, and still pattern-matched on case.

**Filed the same day as D-077**, which was also a homepage claim the Lead wrote and another party
refuted. Two in one afternoon, both in marketing copy, both by review rather than by a gate — and
the site has no gate that compares a copy claim against the server constant it describes.

## D-079 — the CLI demanded a value no command would return · MINOR · FIXED

**Found by Wren, 2026-08-09, onboarding an agent on a second machine.**

Agent credentials never inherit a human's saved target — deliberate, and the refusal says so:

```
cswarm: agent credentials never inherit a human's saved Cloud target; pass --url and
        --anon-key or set SWARM_CLOUD_URL and SWARM_CLOUD_ANON_KEY
```

**No supported command returned the anon key.** `target show --json` gave
`anon_key_fingerprint` and nothing else. To satisfy an error the CLI itself printed, Wren read
`~/.cswarm/credentials.d/current-target.json` **directly** — reaching into the credential store,
which is the outcome fingerprinting was presumably meant to prevent. The alternative is asking a
human to paste a key, which is the habit the design exists to stop.

**There was no secret to withhold.** AGENTS.md: *"The anon key is a public identifier protected by
RLS, not a secret."* The product publishes this exact value in a `commonswarm:anon-key` meta tag
on **every page of commonswarm.com**. The CLI was fingerprinting a value the website prints.

**Fixed with `cswarm target show --reveal-anon-key`**, and the default is unchanged.

**The design decision is the interesting part, and the first attempt was wrong.** Returning the
key unconditionally failed `current-target.test.ts`, which asserts the default output omits it.
That control is worth keeping even though the key is public: a 208-character JWT emitted by
default lands in logs, screenshots and pasted issues, and `supabase projects api-keys` prints the
**service-role** key two rows below the anon key. *"cswarm prints keys"* is a habit worth not
forming. So revealing became an explicit act, the existing control stays true, **and it was not
edited.**

**`reveal-anon-key` had to be added to `BOOLEAN_FLAGS`** — without it the parser treats an
unrecognised flag as value-taking, which is exactly what made `--local` unusable in 0.1.8 (D-064's
control found the same shape). Checked before shipping rather than after.

Gated on three cases including one the other two cannot catch: the fingerprint must not equal the
key in either mode, since a fingerprint that returned the key verbatim would satisfy both the
default-omits and reveal-returns tests.

## D-080 — `listen start` reports terminal failure for a listener that then serves · MAJOR · FIXED

**Found by Wren, 2026-08-09, by filing a blocker on it and then discovering the listener was
healthy.**

```
$ cswarm listen start … --provider opencode --permissions deny
cswarm: the host did not prove that CommonSwarm controls ACP tool permissions;
        no model prompt was delivered
<returns>

+7s   the same pid logs listener_ready
      and it served a cross-user wake round trip minutes later
```

**The command's failure message is not a reliable signal of the listener's fate.** Anyone
following that output concludes it is broken, reports a blocker, and stops — which is exactly what
happened, costing about an hour.

**And the diagnostics are attached the wrong way round.** The attempt that genuinely failed said
*"listener failed (stopped); no ready listener was left running"* — vague. The attempt that
**succeeded** said *"the host did not prove that CommonSwarm controls ACP tool permissions; no
model prompt was delivered"* — specific, actionable, and wrong about the outcome.

**A second observer error compounds it, and is worth recording because it is a property of the
product rather than of the observer.** Wren's confirming `listen status` also reported `failed`,
because it polled at ~23:04:36 and `ready` did not land until 23:04:42. A six-second window in
which the status command returns a transient as though it were an outcome.

**Related and already fixed for `stop`:** D-074 added *"This is still in progress. Confirm with:
cswarm listen status …"* to transitional states. That fix does not help here, because `start`
exits with what reads as a terminal failure rather than a transitional state.

**FIXED 2026-08-09** in `src/listener/supervisor.ts` and `src/cli.ts`. Two changes, because the
defect had two halves and fixing only the first would have left the misleading text in place.

**1. The mechanism — the stale-status fallback did not check the pid.** `waitForListenerReady`
queries the live control socket, and falls back to reading the status FILE when that query fails.
That failure is the NORMAL state for the first moments of a start: the socket is not up yet. The
listener directory is keyed by CONFIG HASH, so an identical retry lands in the same directory and
the fallback reads **the previous run's** terminal status. The live branch already rejected a
mismatched pid (`ListenerAlreadyRunningError`); the fallback checked nothing. It now requires
`stored.pid === options.expectedPid` before treating a stored `failed`/`stopped` as this start's
outcome.

This explains the backwards diagnostics recorded above without needing a second cause: the
specific `permission_canary_failed` belonged to the earlier genuine failure, read out of its file
by the run that then succeeded.

**2. The message on the path that remains — `ready_timeout` told the user to retry.** Nothing
kills the child on a timeout, so retrying spawns a second listener or collides with the first.

~~The first correction read *"…and was not stopped; confirm with cswarm listen status"*.~~
**Dead.** Both review arms refuted it, and Codex's form of the argument is the sharper one: the
wait loop performs **no final liveness check**, so the child can exit between the last poll and
the throw. *"Was not stopped"* is a claim about the listener's state that the code does not
guarantee — and the test I had written **required that string**, so the suite would have defended
it. Same shape as the `/every session/` incident in AGENTS.md, caught this time by a non-author.

It now reads *"the listener did not become ready within two minutes and cswarm did not stop it;
check cswarm listen status before starting another"*. The wording asserts **our action**, not the
process's state. That we did not stop it is guaranteed — this path never kills the child. **Checked and deliberately unchanged:** every other code in
`listenerFailureMessage` follows a listener that reported `failed` and terminated, where "then
retry" is correct. `ready_timeout` was the only one asserting a state the code does not create.

Credit to Wren for the second half: it noticed that `listen stop` already does this well — it says
it is asynchronous, says it is incomplete, and names the command to confirm with — and that the
good pattern was one subcommand away from the bad one.

**3. A pid match alone was not enough, and the first version of this fix shipped in the commit
below with two holes that BOTH review arms found independently** (Gemini as the inversion arm,
Codex as the exact-review arm; Grok is credit-exhausted and Pi has no API key on this machine):

- **PID REUSE.** Pids are recycled. This directory is keyed by config hash, so the one file a
  retry reads is the previous run's — whose pid can come round again. Fixed by a `startedAtFloorMs`
  captured **before** the spawn: a status older than the floor belongs to an earlier run whatever
  pid it carries. The floor precedes the spawn, so this instance's own `startedAt` is always at or
  after it and its genuine failures are still reported. `startedAt` is minted fresh per run at
  `supervisor.ts:131` and never inherited, which is what makes it a sound discriminator.
- **`expectedPid === undefined ||` kept the unsafe behaviour** for any caller that could not
  supply a pid — a latent copy of the defect. Both identifiers are now required to MATCH rather
  than merely be absent. `listen start` is the only caller in `src/` and supplies both.

**Gate:** `tests/p1-cli/d080-stale-start-status.test.ts`, reached by the `test:p1-cli` glob (6
tests, verified present in its output).

**Mutation-tested, and the first round FAILED to justify one of the three mechanisms — recorded
because the finding is the point.** Deleting the pid match left every test green: each case was
also caught by the timestamp floor. An ungated check is one a later reader will simplify away
after running exactly that mutation. The missing case was a **concurrent** second instance — a
status written AFTER the floor under a different pid, which the floor admits and only the pid
rejects. With that test added, all three mutations discriminate:

| mutation | result |
|---|---|
| drop the pid match | fails the concurrent-instance test |
| drop the timestamp floor | fails the pid-reuse test |
| restore `"was not stopped"` | fails the claim test |

**Second review round on the replacement SHA.** Gemini returned a reasoned PASS on all three
questions put to it. Codex returned FAIL on three, and two of the three do not survive contact
with the code:

- *"Parent and child wall clocks can differ."* **Refuted.** They are one process tree on one
  machine; there is one clock. The half that IS real is that a single clock can step backward.
- *"`cswarm did not stop it` is not established — some path may have stopped the child."*
  **Refuted by enumeration.** The only `child.kill()` in the start path is the
  `child.pid === undefined` guard at `cli.ts:3601`, which throws before `waitForListenerReady` is
  ever called, and the wait itself contains no kill, stop, signal, or abort. No path reaching
  `ready_timeout` has stopped the child.
- *"A backward step can swallow this instance's genuine failure."* **Real, and smaller than
  claimed** — now pinned by a test rather than argued away. The supervisor terminates after a
  failed start, so `isProcessAlive` observes the exit and the error is reported as `process_exit`
  within the 500ms grace. The specific code degrades; the failure is not swallowed and there is no
  hang. That is strictly better than the defect being fixed, which reported a specific code that
  was **wrong**.

Over-fix controls: this instance's own failure is still reported, and a caller supplying neither
identifier gets `ready_timeout` rather than a stored code. They exist because "require a pid
match" could equally have been implemented by ignoring the stored status altogether, which would
silence real failures and be a worse defect than this one.

**NOT established:** whether this was the only cause of the observed report. D-081 records that
the opencode canary genuinely is intermittent, so a start CAN fail for real; this fix stops a
previous failure being reported as the current one, and does not make the canary reliable. The
six-second `listen status` window described above is untouched — a status poll can still return a
transient as though it were an outcome.

## D-081 — the opencode permission canary is intermittent · MAJOR · OPEN, MITIGATED

**Measured 2026-08-09**, and it settles an item that sat undiagnosed on two resume files as
*"opencode never reaches ready."*

```
22:00:14   start -> listener_failed   permission_canary_failed   6.8s
23:04:34   start -> listener_ready                               8.2s
```

**Byte-identical config** — same config-hash listener directory, same profile, workspace,
principal, provider, permissions and cwd. Not a regression: `git diff v0.1.8..HEAD --
src/listener/ src/host/` is **empty**, so the canary code is identical across every release
between the runs. The CLI upgrade at 16:06Z was a timing coincidence, and the provider binary
predates both runs.

**Seven mechanisms were proposed for this failure family across one afternoon by five agents, and
all seven were refuted** — machine-wide `pkill`, OOM kill, output/buffer cap, harness timeout,
uniform timer, session-ownership teardown, and no-tool-reply. Wren's ledger, and its own
assessment is the part worth keeping:

> "None killed by argument — every one died to somebody going and looking, usually at their own
> claim."

**What the canary needs, from `src/host/session.ts`:** a probe prompt, the *model* attempting a
tool call, the host rejecting it, and a correlated terminal tool status. It therefore depends on a
**remote model responding**, which is why ruling the provider out by binary mtime was insufficient
— mtime measures the artifact, not the service behind it. The provider was subsequently verified
live (model answered in 7s and did attempt tool calls), which refuted the seventh mechanism too.

**Not established:** the cause. Only that it is intermittent, not a regression, not a missing
capability, and not a hang (6.8s against a 30s timeout).

### MITIGATED 2026-08-10 — one bounded retry. The cause is still NOT established.

`enablePromptsAfterCanary` (`src/host/session.ts`) now makes **two** canary attempts instead of
one. Ships in the next release; the entry stays OPEN because nothing here diagnoses anything.

**Why a retry is justified when a diagnosis is not.** The pass condition depends on a **remote
model choosing to attempt a tool call**, and `runPermissionBoundaryCanary` resets its own
observation state and sends a fresh prompt — so a second call is a genuine second sample, not a
re-read of the first verdict. That was checked before the retry was written; a retry that could
only re-fail would double the cost of a dead host for nothing.

Precedent: **D-076**, shipped in 0.1.11 as a bounded one-shot retry with its root cause open and
documented. Seven mechanisms for D-081 were proposed and refuted in a single afternoon, and the
model-sampling dependency may stay nondeterministic however long anyone stares at it.

**The cost, recorded rather than hidden.** A genuinely dead host now takes up to two canary
timeouts before failing. Measured first-attempt failures on this machine were **24s, 25s and 9s**
against a 30s timeout, so the doubled worst case is a minute-scale wait. That is the price of not
reporting a healthy listener as failed.

**It cannot hide a deterministic failure.** Every attempt is reported through `onAttempt`, and the
thrown error names the count — *"(failed 2 attempts)"* — so **"flaky, retried, ready" and "failed
twice" stay distinguishable in the log** instead of collapsing into one line. Those are different
defects with different owners.

**Gate:** `tests/p1-cli/d081-canary-retry.test.ts`, reached by the `test:p1-cli` glob. Four tests,
three of them controls. Mutation-tested, each verified to land:

| mutation | result |
|---|---|
| `total = 1` (no retry) | fails the recovery test and both bound tests |
| don't return on pass (always run every attempt) | fails the happy-path control |

**The happy-path control is the one worth keeping.** A retry implemented as "always run twice"
would satisfy the recovery test while **doubling the startup cost of every healthy listener** —
worse than the defect for the majority of runs.

**NOT established, and unchanged by this:** the cause; whether a stranger's machine sees the same
rate (the 3-consecutive-failure observation was at machine load 25.15 on a box hosting two agent
fleets); and whether the retry actually raises the ready-rate in the field. That last one is a
measurement nobody has taken and this entry does not claim it.

## D-082 — one flag name, two contracts; and every unknown flag blamed the user · MINOR · FIXED

**Found by Wren, 2026-08-10, out of a disagreement between two agents who were both right.**

Wren reported that `--agent-token-stdin` rejects a bare agent token. I could not reproduce it and
said so. Wren then found why, and the finding is better than either original claim:

```
cswarm members      --agent-token-stdin   <bare swm_agt_>  -> WORKS
cswarm listen start --agent-token-stdin   <bare swm_agt_>  -> refused: "requires the complete
    JSON credential artifact, including expires_at; a bare token cannot identify durable state
    or rotate safely"
```

**The flag NAME is shared and the CONTRACT is not.** I had tested `members`; Wren had hit
`listen start`. `--help` documented the bare form as if it were universal, so **the documentation
was true for whichever subcommand the reader happened to check it against.**

The refusal itself is correct and is unchanged: `listen start` keeps durable state and rotates,
and neither is possible without `expires_at`. What was wrong was the documentation. `--help` now
names the exception, and a gate holds all three claims — the exception, the reason, and the
general case, the last so that deleting the bare form to satisfy the first two fails.

**Wren also nearly filed an inconclusive result, and recorded why it was inconclusive.** Its first
attempt used a FAKE `swm_agt_` string, which was rejected by *format validation* — "must be
`swm_agt_` followed by 32 base64url-encoded random bytes" — before ever reaching the artifact
check. That error looks like an answer and is not one. This is the AGENTS.md rule about a control
that dies early, hit in the field: **only a real token exercises the path.**

### The second half, which is broader than the report that produced it

Wren observed that `--reveal-anon-key` on 0.1.11 fails with *"requires a value"* rather than
*"unknown flag"*, and called it trivial. Measured, it is neither trivial nor specific to that
flag: **every unknown flag reported "requires a value", on both builds**, because the parser
assumes anything outside `BOOLEAN_FLAGS` takes one.

```
0.1.11  cswarm target show --not-a-real-flag  -> cswarm: --not-a-real-flag requires a value
main    cswarm target show --not-a-real-flag  -> cswarm: --not-a-real-flag requires a value
```

So a flag that **does not exist** was reported as a flag **used wrongly**. Wren named the family
exactly: it is D-080's shape — the error blames the reader for something that is not their doing,
here for being on an older version. AGENTS.md already records the other cost, in the list of traps
that manufacture a false negative: a control written with a bare `--not-a-real-flag` died in the
parser before reaching the gate it was meant to exercise, and passed for the wrong reason.

**FIXED, messaging only.** `KNOWN_FLAGS` is consulted **when building the error and never when
accepting one**, so a value-taking flag missing from the list still works exactly as before; the
worst a stale list can do is word an error badly. Making it authoritative for acceptance would
turn an omission into a broken command — a far worse failure than a clumsy sentence.

The list is kept honest by a gate that reads the **usage text** and requires every advertised flag
to appear in it, so adding a documented flag without listing it fails a test rather than reaching
a user as *"unknown option --your-new-flag"*.

**Gate:** `tests/p1-cli/unknown-flag-message.test.ts`, reached by the `test:p1-cli` glob.
Mutation-tested, both verified to land: reporting every failure as unknown fails the
distinguishability control, and removing one documented flag from `KNOWN_FLAGS` fails the coverage
gate.

### The first fix was WRONG, and Wren refuted it within the hour

**There are THREE contracts, not two.** Wren swept the flag across every subcommand whose usage
line carries it, with one real token in one invocation set — so that `members` working is a
positive control for the other two rather than a separate observation:

```
members       -> works
listen start  -> "requires the complete JSON credential artifact, including expires_at"
token revoke  -> "agent credential on stdin has no token_id; pipe the JSON artifact"
```

**The two refusals cite DIFFERENT missing fields.** They are two independent requirements that
happen to be satisfied by the same artifact, not one strict mode with one reason.

~~The first fix wrote *"listen start is the exception"* and **this file claimed the gate held
three claims: the exception, the reason, and the general case.**~~ **Dead.** That shape only holds
if there is one exception. The gate would have stayed green with `token revoke` undocumented — and
the wording was worse than the silence it replaced, because it newly implied the difference had
been enumerated. Wren:

> "The original defect was documentation silent on a difference; the risk in the fix is
> documentation that appears to have enumerated the difference and has not."

**This is a control discriminating toward a false claim** — the AGENTS.md section on exactly that
— written by me hours after quoting it in a commit message. Mutation-testing proved the gate could
fail; it could not tell me it was failing toward the wrong assertion.

**The fix is Wren's framing, as a PROPERTY rather than a list**, because a property survives the
next subcommand and an enumeration does not: *which forms are accepted depends on what the
subcommand does with the credential.* Read-only takes either; persisting or referencing it needs
the field a bare secret does not carry. All three are named with their reasons.

**Two gates now, and the second exists because the first cannot see a subcommand that does not
exist yet.** It derives the takers from the usage text and requires each to appear in the flag's
description, so adding the flag to a fourth subcommand fails a test instead of silently making the
documentation incomplete again.

**My own control had a hole, found by mutating it.** Its first version fell back to matching the
subcommand's first word, so deleting `token revoke`'s entire line left it GREEN — "token" appears
in the description's own prose (*"bare swm_agt_ token"*). **A control matching a word the
surrounding sentence already contains cannot fail.** It now requires the full subcommand. A second
extraction bug surfaced the same way: a fixed two-token slice produced `members [--url`, because
`members` is one word and `token revoke` is two.

**NOT established**, and Wren's scope note is explicit about the boundary:

- Whether any OTHER flag has a per-subcommand contract. Wren swept ONE flag across its
  subcommands; 36 subcommands share `--workspace-id`, `--json`, `--until`, `--about` and none has
  been tested for divergence. The general question stands, narrowed by one flag.
- Whether the ARTIFACT form works everywhere. Only the bare form was swept, because that is where
  the disagreement was. If some subcommand rejects the artifact, nobody has looked.

## D-083 — the bare credential form DELETED a successor stored by the artifact form · MAJOR · FIXED

**Destructive, reachable today, and found inside a REFUTATION.** A verification agent was refuting
a different claim about credential input paths; it reported that the claim "points at the one line
that must not change while missing a real destructive defect three lines away." The defect was the
three lines away.

`AgentCredentialSession.open` compared the stored lineage's `rootTokenId` to the presented
credential's `tokenId` by **strict equality**, and **deleted the record** on mismatch
(`src/cloud/renewal.ts:711`). The bare credential form carries no token id — `tokenId: null` at
`cli.ts:587`, against `cli.ts:644` for the artifact form. So:

```
agent runs `listen start` (REQUIRES the artifact form)  -> successor stored, rootTokenId set
agent runs `members`      (accepts a BARE token)        -> presented.tokenId === null
                                                        -> sameLineage false -> store.delete()
```

**The successor credential is destroyed.** This is not hypothetical: D-082 measured, that same
day, that `listen start` requires the artifact form while `members` accepts a bare token. Merely
alternating subcommands with the same secret is enough.

**A null id cannot mean "someone else's lineage".** The store filename is
`credentialLineageKey(agent.token)` — sha256 of the **presented secret** (`cli.ts:2023`,
`agent-credential.ts:89-91`) — so finding the record at all already proves the caller holds the
same root token. The id is corroboration, not identification.

### The part worth more than the fix

**The comment directly above the check records this exact bug happening once before** — a null read
as "belongs to a different agent", the record deleted, an interrupted renewal made unreplayable —
**and being fixed there, for `principalId` only.** The `principalId` clause is null-tolerant on
both sides. The `rootTokenId` clause, one clause to its left, was not.

**The fix was applied to the case that was found rather than to the class**, and the identical
defect sat beside it, documented, for as long as the comment has existed. That is the failure mode
this register exists to catch, committed by someone who had just written the explanation of it.

**Gate:** `tests/p1-cli/d083-bare-form-deletes-successor.test.ts`, reached by the `test:p1-cli`
glob. Mutation-tested in both directions, each verified to land by grep first:

| mutation | result |
|---|---|
| revert to strict equality | fails the bare-form test only |
| never delete (`if (false)`) | fails the foreign-lineage control only |

The second control exists because "treat null as unknown" is easily mis-implemented as "never
delete", which would leave a foreign record in place and defeat the check entirely. The third test
pins that a matching lineage is still ADOPTED, so a change that deleted nothing and adopted
nothing cannot pass all three.

**`rootTokenId` appeared 0 times in `tests/` before this** — 12 times in `src/`. Nothing pinned it.

**NOT established:** whether any credential was actually lost in the field. The path is reachable
and the code is unambiguous, but no incident is attributed to it. Wren spent a day alternating
bare and artifact forms across subcommands and did not report a lost successor — which does not
clear it, because a deleted successor is silent: the root token still works and renewal simply
starts over.

## Doctrine — A PROCESS MEASUREMENT WITHOUT A HOST IS NOT A RESULT

**2026-08-10. Two agents measured the same question, with correct instruments and correct
controls, got 1 and 0, and BOTH WERE RIGHT.**

Wren reported a live listener — pid 71854, principal `d8a20644`, workspace `7c28b611`, resident
5h53m and still polling production. I measured, found **zero** `__listen-supervisor` processes
against a positive control of 52 node processes, and told Wren its report was *"correct in
principle and stale in fact."*

**My correction was the error.** The listener was on the OPERATOR'S LAPTOP. My zero was correct
for the mini. Wren's one was correct for the laptop. Neither instrument was faulty and neither
control was missing — **the missing term was the host**, and neither of us had stated it.

```
tom's laptop   pid 71854 UP 5h53m     control: 88 node processes
the mini       __listen-supervisor 0  control: 35 node processes
```

**A positive control proves the instrument works. It says nothing about WHERE it was pointed.**
That is the same shape as the two other errors of the same day — reading a transitional state as
an outcome, and matching a process by pattern and assuming ownership. In all three the
measurement was sound and the SCOPE was assumed.

**The rule: state the host in the result, not just the number.** Wren's own framing, and it is
better than "enumerate rather than count" for this class, because enumeration on the wrong machine
is still enumeration.

This matters beyond tidiness on a fleet: a claim like *"the fleet is quiet"* or *"nothing else is
consuming signals"* is a claim about every host, and it cannot be established from one. The
isolation that DID hold here held for a stated reason — the cold-agent A/B ran in workspace
`c2ea0541`, and `7c28b611` is a different workspace — not because the machine was quiet.


## D-084 — the deny default made the worker silently useless, and the doc promised a sandbox that was never built · MAJOR · FIXED (default), OPEN (isolation)

**Two findings from one question.** The operator asked, 2026-08-11: *"why would the agent be on
permissions deny? again we want low friction here by default."* Answering it truthfully required
reading what `deny` and `allow` actually do, and that read found a second, larger thing.

### Finding 1 — the default (FIXED)

A listener started without `--permissions` ran in `deny`. Measured on the two-agent dogfood the
same day: the worker had Bash and Write refused, so it could **answer questions and do nothing
else** — it could not hash, persist, or initiate anything it was asked to do. Every status surface
called it healthy the whole time, and the agent on the other end read it as uncooperative. Nothing
anywhere said why.

This is the *"a true word in a success-shaped response gets skipped"* family, one level worse:
there was no word at all. `listen start` said "Same-owner tool requests are denied by default",
which is true, reads as a routine safety note, and never connects to "so this agent cannot do the
thing you are about to ask it for."

`allow` is not a blanket grant. `allowOnceOrDeny` selects the ACP `allow_once` option **per
request** and falls back to deny when the host offers none — the decision a human makes clicking
through, one tool call at a time. The permission-boundary canary forces deny regardless of the
mode, so the proof that CommonSwarm controls ACP permissions is untouched.

Fixed:
- `src/cli.ts` `listenerPermissionMode(undefined)` → `"allow"`; `deny` unchanged and still
  reachable; an unrecognised value still throws rather than defaulting either way.
- `site/…/connect/agent-prompt.ts` starts listeners with `--permissions allow` and names deny as
  the answer for a listener taking work from outside your account.
- The `listen start` summary had **both** clauses inverted by the flip — "denied **by default**"
  and "allowed once because you **explicitly selected**" swapped roles. Neither string was in the
  diff that changed the default. Corrected, and the deny branch now states its cost rather than
  its mechanism.
- `tests/p1-cli/permissions-default.test.ts`, mutation-verified: the deny default, a
  `deny`-deleting simplification, a typo silently upgraded to allow, and the prompt dropping the
  deny escape hatch each fail a different assertion.

**Why the test file exists:** the default was flipped and **747 tests passed unchanged** — `npm
test` 499/499 and `test:p1-cli` 248/248. Nothing exercised the omitted-flag path in either
direction. The two `permissionMode: "deny"` literals in the suite are fixture fields handed *in*,
not the resolver's answer. A default that inverts silently is not a default anyone is holding.

### Finding 2 — the isolation in the design doc does not exist (OPEN)

`docs/design/2026-07-30-AGENT-RECEIVE-MVP.md` stated: *"Cross-owner and unknown input never enters
the worker context. Every ask gets a fresh temporary working directory and ACP session with strict
sandboxing, all tool requests denied, empty MCP capabilities… a private temporary
`HOME`/`GROK_HOME`."*

**None of it was built.** Measured against the code:

| the doc's claim | what the code does |
|---|---|
| a separate sandboxed session | `relation` never reaches `src/host/session.ts` or any of the four model adapters |
| a fresh temporary working directory | every `mkdtemp` in `src/listener/`, `src/host/` belongs to the **canary** (`canary-cwd-`, `cswarm-opencode-hostile-`) |
| all tool requests denied | one permission mode for all senders, set by the flag |
| cross-owner handling | `src/listener/engine.ts:158` adds ONE SENTENCE to the prompt |

Cross-owner input enters the **same persistent worker, on the operator's real `--cwd`, under the
same permission mode as same-owner input**, steered only by *"Before destructive or irreversible
action based on this message, seek your operator's explicit confirmation."*

**`cswarm listen start` has been correct the whole time** — *"The same permission mode applies to
every sender relation"* — and reading that line against the doc is what surfaced the divergence.
The CLI was right and the design doc was wrong. This is the repo's own rule paying out: check a
claim against **what the system does**, not against another artefact of ours, which would only
have proved the two docs agreed.

**Why it matters to Finding 1, stated plainly rather than buried:** had the doc been true, the
`allow` default would be bounded — cross-owner senders would never touch the real worker. It is
not true, so flipping the default means a cross-owner ask reaches the operator's project directory
with per-request tool permissions, mitigated by a prompt sentence and the model's judgement. The
flip still went in: the operator asked for it, the friction it removes is measured, and the
protection it is charged with weakening was never there to weaken. But nobody should later
discover that trade by reading the dead paragraph.

One real bound, not overstated: a cross-owner sender must be a **member of your workspace**, so the
reachable set is people you invited. That is not sandboxing.

**NOT ESTABLISHED.** Steady-state `allow` is unmeasured — the canary's own limit strings in
`src/cli.ts` say so and remain true. The next dogfood round runs under `allow` and is the first
measurement of it.

**The fix, for whoever takes it:** per-relation permissions — `allow` for `same_owner`, `deny` for
`cross_owner` — which is what the doc was reaching for and is cheaper than a second session. The
blocker is that `prompt()` takes a rendered string, so the permission callback cannot see the
relation; it would need threading through the four model adapters, and the worker is sequential
(`src/host/session.ts`), so a per-turn field is sound.
