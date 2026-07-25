# §7.2.2 persona isolation has never been in force — and as built it cannot be

**Date:** 2026-07-25. **Found by:** Ferry (the vacuous gate), Atlas (confirmed it by construction,
and named the consequence), Lead6 (the three PATH measurements). **Status:** measured, not inferred.

> This is not a bug in a check. **It is the discovery that a property R1 claims to enforce was never
> being enforced, and that the gate which would have revealed that cannot fail.**

## The claim

§7.2.2 asserts persona isolation: a persona that inspects the repo from inside its own workspace
voids the round. The instrumentation is a PATH shim — `uxtest/bin/` — containing wrappers such as
`readlink` that decide a violation from `$PWD`:

```
case "$PWD" in
  "$root"/human1/workspace) role="human1" ;;
  "$root"/human2/workspace) role="human2" ;;
  *) role="${UXTEST_ROLE:-unknown}" ;;
esac
```

For that to observe anything, **the persona's session must have `uxtest/bin` on its PATH.**

## The four measurements

Each by execution, by three different agents, on the machines that matter:

1. **A spawned cmux tab does NOT inherit the requesting process's PATH.** (Lead6) Spawned with a
   marker directory prepended: `PATH="/tmp/l6mark:$PATH" swarm spawn …` → the resulting session's
   own environment contained **no marker**. The tab takes *cmux's* environment, not the requester's.
   Marker in, marker not out.
2. **The shim is in no shell profile on the laptop.** (Lead6) `.zshrc`, `.zprofile`, `.bash_profile`,
   `.profile` — no `uxtest/bin` export in any of them.
3. **No live process on the laptop carries `uxtest/bin` in PATH** — launcher tabs included. (Lead6)
4. **The preflight assertion that would have caught this CANNOT FAIL.** (Ferry; Atlas confirmed by
   construction.) `preflight.sh:126`:
   ```
   mini_resolved="$(PATH="$UXTEST_MINI_HOME_ROOT/bin:$PATH" command -v coswarm)"
   [ "$mini_resolved" = "$mini_bin" ] || die
   ```
   Atlas built a throwaway directory containing a **fake** `coswarm` and ran the identical
   construction against it: **it passed.** The gate prepends a directory to PATH and then confirms
   that `command -v` honours PATH precedence — **a property of the shell, not of the harness.** It
   would pass on a machine with no persona, no round, and a shell script that prints "fake".
   ★ Atlas's sharpening: *it cannot observe any PATH it did not itself write.* The neighbouring
   checks (`:124` executable, `:125` not-a-symlink, `:129-131` not-inside-the-repo) are real checks
   on a real file and **do** discriminate. Only the *resolution* assertion is empty — and it is the
   one carrying §7.2.2's name. Same for the laptop arm at `:138-139`.

## The consequence

**(1)** The shim never reaches the persona, so the isolation signal was never being collected.
**(2)** The gate that asserts the shim is in force cannot fail, so nothing ever reported (1).

Those compound: **an unenforced property, and a green light that is green by construction.** Either
alone is a defect; together they are a claim with nothing behind it, that reports itself as verified.

★ **So any round that asserts §7.2.2 isolation is asserting something unverified** — not
*violated*, which nobody has evidence of, but *unobserved*. R1 has never completed a round, so no
false report has shipped. **That is timing, not design.**

## What this does NOT say

- It does **not** say a persona inspected the repo. Nobody has evidence of a violation.
- It does **not** invalidate the other preflight checks; three of the four adjacent ones discriminate.
- It does **not** block the PATH fix for the spawn hang. That fix removes the shim from *the spawn
  step*, which measurement 1 shows was never reaching the persona anyway — **zero isolation cost**,
  because there was no isolation coverage there to lose.

## ★ AND CLEANLINESS WAS BEING VERIFIED AT THE WRONG LAYER TOO — MEASURED, AND DIRTY

Added after the fact, because it is the same defect one layer over and it was found the same day.

Every "the machine is clean" check this program has run reads the **swarm registry**: zero agents in
`uxtest-r1` on both machines, personas' cwds untouched, reset cold. Those checks were **true**.

**They were also the wrong object.** A cmux *surface* is a separate object from the agent that ran in
it, and it survives that agent's exit — `swarm leave` does not close a tab, and `kill <pid>` does not
either. Dana enumerated the surface layer directly (`cmux list-pane-surfaces`) and found **five**: its
own, plus **four orphaned spawn-created tabs** — DiagB, Beacon, DiagC, DiagD. Their agents had left
the swarm. The surfaces and their processes had not.

**So the registry said `uxtest-r1` is empty, and that was true, and the machine was not clean.**

### The requirement this adds
**A round's pre-flight must sweep SURFACES, not agents.** Enumerate them, and treat any
spawn-created surface in or near a persona area as contamination. A registry-only cleanliness
assertion is a check on the wrong noun — and, like `preflight.sh:126`, it will pass while the thing
it names is false.

### ★ And the uncomfortable part, recorded because it is luck rather than method
**THE INSTRUMENT WAS THE DEBRIS.** Those four orphaned tabs were the only true samples of a
spawn-created persona environment that has ever existed — and they are the reason the human2 arm of
the leak could be measured *without running a spawn at all*. The contamination risk became the
measuring device.

That cuts both ways and both readings are correct: **probe residue is contamination for the round and
evidence for the diagnosis, and which one it is depends on what you are about to do next.** A blanket
"always clean up immediately" would have destroyed the only instrument available. A blanket "leave it"
silently pollutes the next round. Neither rule is safe on its own; **the sweep belongs in the round's
pre-flight, not in the prober's reflex.**

## What has to happen before a round claims isolation

1. **Decide whether §7.2.2 is enforced or dropped.** An unenforceable claim in a measurement harness
   is worse than an absent one, because reports inherit it.
2. **If enforced:** the shim must reach the persona by a route that a spawned tab actually inherits
   — a shell profile in the persona's home, or cmux-level session config. Requester-PATH inheritance
   is refuted and must not be relied on again.
3. **Replace the vacuous assertion** with one that reads the *persona's* PATH rather than one the
   check constructs. RED for it: a persona session without the shim must make it fail.
4. **Until 1–3, no report may claim isolation was verified.** §7.5 already carries a standing rule of
   this shape for workspace creation; this needs the same.

## The pattern, for the record

This is the vacuous-gate class — *a gate that cannot fail is worse than no gate* — found for the
**second** time in this harness, and this instance is worse than the first: the earlier one merely
failed to catch a defect. **This one asserts a property that was never in force, in the document
whose entire purpose is to make a measurement trustworthy.**

It was found because three agents pointed different instruments at the same area and one of them
built a fake `coswarm` rather than reading the code. **Reading the check would never have shown it;
the code is correct about what it does, and what it does is not what its name says.**
