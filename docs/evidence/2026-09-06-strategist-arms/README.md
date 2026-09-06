# CSwarmStrategist arm runs, 2026-09-06 (mini)

Arms the CSwarmStrategist seat on `yulanbots-mac-mini` ran for CSLaptopLead's NO-TRUNCATION lanes.
They live here, not in the lane evidence directories, because **two Codex arms were run on the same
SHA at the same time on this host by two different sessions**, both writing
`arm-codex-sol-727f4c44.md`. One copy landed on `main`, the other on the lane branch. Same path, two
different reviews, silent overwrite on merge. Keeping this seat's copies under a seat-scoped
directory removes the collision.

| file | lane | SHA | model / effort | verdict |
|---|---|---|---|---|
| `arm-codex-sol-xhigh-727f4c44.md` | L1 `lane/notify-full-body` | 727f4c44 | gpt-5.6-sol, xhigh | **FAIL**, upheld by the lead |
| `arm-codex-sol-xhigh-727f4c44-prompt.txt` | — | — | — | the prompt, so the run is reproducible |
| `lead-verification-daebc48d.md` | L1 round 2 | daebc48d | no Codex arm — quota | measurement only |
| `arm-codex-sol-xhigh-5ab774f7-prompt-NO-VERDICT.txt` | L2 `lane/hook-preview-1000` | 5ab774f7 | gpt-5.6-sol, xhigh | **no verdict** — the run was cut off by the Codex usage limit mid-review. The prompt is kept so it can be rerun; nothing from that run is a review. The Codex arm the lane filed for L2 came from the other session. |

## The two 727f4c44 arms are not the same review

The copy on the lane branch (`docs/evidence/2026-09-06-lane-notify-full-body/arm-codex-sol-727f4c44.md`,
lane commit 83b2b5f3) is a `gpt-5.6-sol` run at **high** effort from a different session. It found the
two C1 wording deviations and nothing else, and the spec owner resolved those in `c6f1df2`.

This seat's copy is the **xhigh** run. It found the two wording deviations *and* graded them down as
non-blocking, and failed the lane on a third finding the other arm did not reach: the generated phrase
named a bare `cswarm inbox`, a command the reader it addresses cannot run.

**So "Codex FAIL on spec wording, resolved by spec correction c6f1df2" is true of the lane's copy and
not of this one.** c6f1df2 does not touch the remedy string. The blocker stayed open until the lane
fixed it in code at daebc48d. Anyone reading the lane README's one-line summary should read this
paragraph beside it.
