# `swarm spawn` hang — root cause, verified

**Date:** 2026-07-25. **Method:** 14-agent adversarial workflow (21 candidates raised, 15 unbounded,
6 survived refutation), then every load-bearing claim re-derived by the Lead. **Status:** confirmed.

## The cause, in one sentence

**`resolveCmux()` shells out to `which` with no timeout, and under the uxtest PATH that `which` is a
shim that execs itself forever.**

## The two halves, each verified independently

**1. The unbounded call.** `swarm/src/transport.ts:20`

```ts
cachedCmuxPath = execFileSync('which', ['cmux']).toString().trim();
```

**No options object at all**, so Node's `timeout` defaults to 0 — wait forever. Verified: `grep -n
timeout src/transport.ts` returns exactly one hit and **it is a comment** (`:249`). `spawn --terminal
cmux` reaches this at `index.ts:2008` → `transport.ts:378`, the **first** cmux resolution on the path.

**2. The self-exec loop.** `uxtest/scripts/spawn-observed.sh:49` prepends `${UXTEST_HOME_ROOT}/bin`
to PATH immediately above the spawn call at `:53`. So `which` resolves to `/Users/tom/uxtest/bin/which`
— a shim that reads its real target from `product/REAL_which` and ends with `exec "$real_path" "$@"`.

```
REAL_which contents: [which
]                      6 bytes
```

**`REAL_which` holds the bare relative string `which` — and it is the ONLY relative entry among all
19 `REAL_*` files.** Every other one is absolute (`REAL_head → /usr/bin/head`, `REAL_node → …/node`).
A relative `exec` re-runs a PATH lookup, finds the shim again because it is first on PATH, and execs
itself. One process, no fork accumulation, zero bytes of output, forever.

## Why it explains all three attempts

The isolation log is the fingerprint. `logs/r1/isolation-events.jsonl` — 17,550 lines, **17,530 of
them `tool: "which"`**, every one tagged `role: human2, round: 1`, which is exactly
`spawn-observed.sh`'s signature. Histogrammed by minute, it is **three bursts and nothing else**:

| Burst | Window | Events | Shape |
|---|---|---|---|
| 1 | 07-24 22:25→22:26 | 1,553 | ~90s, **stops mid-stride** |
| 2 | 07-25 10:38→10:48 | 13,792 | **~600s unbroken**, ~1,350/min |
| 3 | 07-25 10:53→10:54 | 2,175 | ~95s |

Three attempts, three bursts. Burst 2 is the 600-second tool timeout, visible as a continuous spin
(~23 iterations/sec — one bash start plus one node start each, which is why it grinds rather than
hot-spins).

★ **ATTEMPT 1 WAS AN OPERATOR INTERRUPTING A HANG, NOT AN INTERRUPT CAUSING A FAILURE.** Burst 1 runs
90 seconds and stops mid-stride — the fingerprint of a human hitting Ctrl-C on something already
spinning. **The original diagnosis characterised the interrupt rather than the thing interrupted.**

It also explains *no tab created*: the hang is upstream of `cmux new-surface` at `transport.ts:380`,
so no terminal, no shell, no `claude` process. And the total silence: nothing prints before
`index.ts:2008`, and a synchronous `execFileSync` never yields the tick on which Node would flush
deferred warnings. **Zero bytes is what the claim predicts, not evidence against it.**

## ★ A correction to the control that framed this all day

*"`swarm members` returns in 84ms while spawn hangs"* was read as isolating the **spawn path**. It
does not. **It isolates the PATH.**

`swarm members` *does* reach `resolveCmux` (`registry.ts:597` → `cleanupStale` → `:651`
`isCompetent()` → `transport.ts:505`). Under the **normal** PATH, `/usr/bin/which cmux` exits 1 in
~0ms, and a bare `catch {}` swallows it — that is the 84ms. Under the **uxtest** PATH, `swarm members`
**also hangs**, blocking inside `cleanupStale` before printing anything.

**So the honest predicate is: any subcommand that resolves cmux, run under the uxtest shim PATH,
hangs. Not "spawn".** The control was run without the PATH prefix, and that one difference explains
it entirely. (`swarm --help` still returns under the shim PATH, because it never resolves cmux.)

## The fix — loudness first

**Primary, `transport.ts:20`** — bound the probe, and do **not** let the timeout fall into the
existing silent `catch {}`:

```ts
try {
  cachedCmuxPath = execFileSync('which', ['cmux'], { timeout: 5000 }).toString().trim();
  return cachedCmuxPath;
} catch (err: any) {
  if (err?.killed || err?.code === 'ETIMEDOUT' || err?.signal === 'SIGTERM') {
    throw new Error(
      `Timed out resolving cmux: 'which cmux' did not return within 5s. ` +
      `A shimmed or looping 'which' on PATH is the usual cause. PATH=${process.env.PATH}`);
  }
}
```

★ The explicit ETIMEDOUT branch is load-bearing: without it the bare `catch {}` swallows the timeout
and falls through to the bundled `/Applications/cmux.app/…` path, which would **"work" and hide the
broken environment** — worse than the hang. And `PATH=` in the message turns a mystery into a
one-look diagnosis.

**Secondary, `transport.ts:50`** — add `timeout: 30_000` to `STDIO_OPTS`, bounding `new-surface`
(`:380`) and `send`/`send-key` (`:281/:287/:291/:298`). This did not fire here, but it is the same
class — **and it is the leading candidate for the two-hour headless-reviewer hang recorded in
SUCCESSION §1.**

**Defence in depth:** wrap `spawn-observed.sh:53` in `timeout 120`. Every other exit path in that
script writes a state file; the spawn call is the only unbounded step. Bounding it turns *no artifact
at all* into *an artifact that says it timed out*.

**Explicitly not the fix on its own:** patching `REAL_which` to `/usr/bin/which`. That unblocks the
lane and leaves the CLI able to hang forever the next time anything on PATH misbehaves. Fix the shim
if you want the lane today; **ship the timeout regardless.**

## What the hang was actually doing for us

★ The spawn hang **prevented an invalid round.** §7.2.2 isolation was never in force
(see the companion finding), so any round that had succeeded would have been worthless *and would
have looked clean*. We spent a day fighting the obstacle that was also the only safeguard.

That is an argument **for** the timeout, not against it: **an intermittent fault that silently
protects you is not a safeguard, it is luck with good timing.** Protection must come from a check
that knows it is a check.
