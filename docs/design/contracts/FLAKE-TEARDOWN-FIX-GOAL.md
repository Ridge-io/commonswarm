# /goal — make the release gate deterministic: wait for exit before deleting

Worker: **Newel** (Codex). Lane: the identified teardown race.
Clone: `/Users/yulanbot/Developer/Ridge.io/cloud-swarm` · Branch: `lead7/mvp-release-0.1.5`
**Frozen base: supplied by the launcher as `$FROZEN_BASE`, asserted in preflight.**
Owned: `tests/listener-cli-process.test.ts` only.
**The Lead will not commit to this branch while you hold it.**

## The defect — identified, not suspected

`tests/listener-cli-process.test.ts:584`, *"detached CLI cursor fallback still receives and replies"*,
intermittently fails with `ENOTEMPTY` during teardown.

Observed three times across this release: once by the Lead (unnamed at the time, unreproducible in
~82 subsequent runs), and twice by a later lane — a full run and an immediate isolated rerun.

**Mechanism, at `:701-713`:**

```ts
} finally {
  await runCli(["listen","stop", …]).catch(() => undefined);   // REQUESTS a stop
  await new Promise(r => server.close(() => r()));
  await rm(root,      { recursive: true, force: true });        // deletes immediately
  await rm(workerCwd, { recursive: true, force: true });
}
```

`listen stop` **requests** the detached listener to stop. Nothing waits for the child to **exit**. The
removal can therefore race a listener still writing into that directory. `force: true` suppresses
*not found*; it does **not** suppress `ENOTEMPTY` from a live writer.

This is the "pushed ≠ landed" shape one layer out: **stop requested is not exited.**

## The fix

Wait for the detached process to actually exit before removing its directory. Prefer a real signal
over a sleep:

- poll until the listener's pid is gone (the detach/state file records it), or
- wait on whatever handle `listen stop` gives back, or
- poll until the directory's lock/socket artefacts are released.

**Do not fix this with a fixed `sleep`.** A sleep converts a race into a slower race and hides it
again — which is exactly how it survived this long.

**Bound the wait** and fail loudly if it expires. A teardown that hangs forever is worse than one that
races; if the child does not exit within a sensible bound, the test should say so with the pid and the
directory, not stall.

Apply the same treatment to the sibling `finally` blocks in this file that remove a directory after a
detached listener (`:569-580`, `:816-817`, `:907-917`) **if** they share the pattern. Check each —
do not blanket-edit. If one does not need it, say which and why.

## Acceptance — the hard part

A race that reproduces roughly once in eighty runs cannot be proven fixed by one green run.

- Run the affected test **in isolation at least 30 times** and report the exact pass count. State
  plainly that this **reduces** confidence in the race, and does not prove absence.
- If you can make the race reproduce **deliberately** — e.g. by delaying the child's exit — do that
  first, show it red, then show the fix green. That is far stronger than repetition, and it is the
  difference between "we did not see it again" and "we established the mechanism".
- If you cannot force it, say so plainly rather than presenting 30 green runs as proof.
- Root `npm test` still 376/376.

## Deliverable

Commit once, push, record the new SHA. Write
`docs/evidence/2026-08-02-v015-execution/teardown-race-fix.md` — **committed, not scratchpad** — with
the diff, the repetition count, whether you could force the race, and which sibling blocks you
changed or deliberately left.

## Non-goals

No product code — this is test teardown; if the fix appears to need a product change, **stop and
report**, because that would mean the listener does not expose a usable exit signal, which is a
different and more interesting finding. Nothing outside this file. No version bump, deploy, tag, or
release. Do not join the swarm or set swarm status. No broadcast, no `AdvisorClaude2`.

## Stop conditions

Preflight fails · the fix needs product changes (report it) · you find yourself reaching for a fixed
sleep · root tests regress.

State what you did **not** establish.
