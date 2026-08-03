# An observed test failure that did not reproduce — recorded, not dismissed

## What happened

The first `npm test` run immediately after the 4xx fix landed (`0d88ef1`) reported:

```
ℹ tests 370
ℹ pass  369
ℹ fail  1
```

The failing test's name was **not captured** — the run had already completed when the count was read,
and the failure marker did not survive into the grep. That is itself a lesson: capture the full log
on the first run, because a flake will not politely reappear.

## What I did about it

| Attempt | Runs | Result |
|---|---|---|
| Combined `npm test`, repeated | 4 | 370/370, clean every time |
| **Per-file**, all 26 literal paths, 3 rounds | 78 | clean every time |
| **Total** | **~82 executions** | **1 failure, never reproduced** |

Per-file isolation was used deliberately for the second attempt: the combined runner is what hid the
name the first time, and a per-file run makes a failure identify itself.

## What this establishes, and what it does not

**Established:** the suite passed 82 consecutive times after the single observed failure, in two
different execution modes.

**Not established:** the cause, or that it is gone. One failure in ~82 runs is consistent with a
genuine low-frequency flake, and it is equally consistent with a transient environmental cause. This
machine hosts two agent fleets, and a browser automation session was active during the failing run —
load is a plausible explanation, but it is a **hypothesis, not a finding**. I did not prove it.

I am recording this rather than dropping it because "it passed on re-run" is exactly how a real
intermittent defect gets normalised, and because Stage 7's gate needs deterministic results — a
1-in-80 flake would occasionally block a release run for no reason, and the reflex to re-run and
move on is the thing that lets it hide.

## Instruction for whoever runs Stage 7

- **Capture the full log of every gate run to a file**, not just the summary counts. If something
  fails, the name must survive.
- A single failure is **not** automatically a flake. Re-run, but record both results.
- If a test fails **twice** in a release run, stop and treat it as real. Do not average it away.
- Prefer per-file invocation when investigating: the combined runner buffers, and a wedged or failing
  file can lose its identity in the noise.
