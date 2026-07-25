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
