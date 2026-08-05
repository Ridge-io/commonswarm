# /goal — D-045: stop a mismatched note from killing the listener

**Scope is deliberately one site.** Read this section before anything else, because the instinct this
repo has trained is to fix the whole class, and that is the wrong call tonight.

## Why this is one site and not five

`docs/org/DEFECT-REGISTER.md` D-046 identifies the root cause: `senderOwnerRelation` is a **mutable,
server-recomputed** value living inside `immutableSignalFingerprint` (`runtime.ts:405-419`), and it is
compared as though it were identity. That error has **five** call sites: `runtime.ts:454`, `:1095`,
`:1113`, `:1127`, `:1197`.

**Four of those five are unreachable in production.** They are in the `durable_claim` branch, which
opens at `runtime.ts:957` and closes at `:1221` — verified by brace depth, not by eye. The `read` edge
function is deliberately not deployed, so no client selects that mode. Those four are recorded in
D-042 and D-046 and are **out of scope here.**

**One site is reachable: `:454`**, called at `:1231`, outside the durable block. It runs on the cursor
path, which is what every client uses today. That is D-045, and it is the only one a beta user can hit.

Do **not** fix the other four in this change. Do **not** build the shared reconciliation primitive
D-046 describes — that is the correct eventual design and it enlarges the state space of a subsystem
that produced a new brick on each of its last two repair rounds. Record it as debt; do not build it
tonight.

## The defect

`observeFallbackNote` (`runtime.ts:446-457`):

```ts
const existing = await store.read(signal.id);
if (existing !== null) {
  if (!sameEffectSignal(existing, signal) || existing.state !== "observed") {
    throw new Error("stored listener effect does not match the direct note");
  }
  return existing;
}
```

`sameEffectSignal` (`:394-403`) compares `senderOwnerRelation`. The server recomputes that on every
read (`read/index.ts:341-374`), so **revoking the note's author** flips `cross_owner` → `unknown` and a
note the listener already observed stops matching. The throw is caught at `:1243` and becomes
`stop = { reason: "fatal" }` at `:1244`. The cursor scan resets and meets the same note again, so it
recurs.

## The fix

**Replace the stored record with the authoritative one instead of throwing.**

Notes are safe to replace and asks are not — this is the distinction that makes the one-site fix sound
rather than a shortcut:

- A note produces **no model turn, no reply, no post**. Its effect record is an observation, and the
  server's copy is authoritative.
- An ask **may already have replied**. Replacing its record could cause a second reply. That is why
  D-041's ask decision was harder and why the four durable sites need the fuller treatment.

Mirror the existing note branch of `readOrReplaceUnreadableEffect` (`runtime.ts:477+`), which already
handles the *unreadable* case this way. You are extending it to the *readable-but-mismatched* case.

`existing.state !== "observed"` is a **separate** condition in the same `if`. Decide what it should do
and say so in your report — a note whose stored effect is in some other state is not obviously the
same situation as a provenance mismatch.

## Required causal test

**Use a relation-only change.** A test that mutates the note body is testing something production
cannot produce; the trigger is `senderOwnerRelation` moving under a record whose id, kind, body and
until are unchanged.

The test must:
1. Observe a note, so a matching effect record exists.
2. Change only the sender owner relation on the next scan.
3. Assert the listener **does not stop fatally**, converges, and keeps processing later signals.

**It must fail red on current `main` before your fix.** Quote the red output. A test that has never
failed proves nothing — this subsystem has been fully green while bricking four separate ways.

## Out of scope

Anything under `supabase/`. The four durable sites. The shared reconciliation primitive. The
enumeration re-issue. The stub-host drill. Deploying the `read` function. All recorded, all deferred.

## Gate

Baseline on `main`: root **399/399**, p1-cli 143/143, p1-local 4/4, p1-server 69/69, site 142/142,
build/check:tests/check:edge all 0.

Acceptance: **399 → N > 399** with the new test shown red first, and every other suite still green.

`NODE_OPTIONS` on this machine references a deleted preload; export
`NODE_OPTIONS="--max-old-space-size=4096"` or every node command fails.

## Report

The change, the red output, the green output, your decision on the `state !== "observed"` condition and
why, and plainly **what you did not establish** — including whether you exercised this against a real
revoked author or only a fixture.
