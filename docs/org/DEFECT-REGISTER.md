# Defect register

The single source of truth for findings. **Chat is not a handover** — a defect that exists
only in a conversation is a defect nobody will act on tomorrow. Every entry names its
evidence, and every closed entry names the artefact that proves it closed.

Adopted 2026-07-29 alongside the Advisor → Operator → Executor model (`docs/org/OPERATING-MODEL.md`).

**Status values:** `OPEN` · `IN REVIEW` (bound to a SHA) · `FIXED` (merged, evidence attached)
· `WONTFIX` (with the ruling) · `DISPROVEN` (the finding was wrong — kept, not deleted).

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

**Status:** branch `l6/renewal-test-gaps`, SHA `505eee8cbcf26c1b9363edd8ff180e66e1189cde`,
pushed and confirmed with `git ls-remote`. Awaiting cross-family (codex) verdict bound to that
SHA. **Not merged.** A new commit voids the verdict and requires rebinding.

---

## D-004 — Expired agent credential is reported as revoked · OPEN

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

**Not yet assigned.**

---

## D-005 — `SWARM_CAPABILITY_URLS` cannot be verified from outside · OPEN (by design)

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

**Not yet triaged.** Needs a ruling on whether archive enforcement is P3 scope before anyone
writes code.
