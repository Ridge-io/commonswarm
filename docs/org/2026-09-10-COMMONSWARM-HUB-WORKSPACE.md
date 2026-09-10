# CommonSwarm development hub workspace (2026-09-10)

Operator ruling (Tom, 2026-09-10): CommonSwarm development moves out of the CICD workspace, which has become PromptEden's, into a dedicated CommonSwarm workspace. That workspace is the primary hub for work on CommonSwarm itself from this date.

| | workspace id | role from 2026-09-10 |
|---|---|---|
| CommonSwarm hub | `4f63d2b0-8d95-4ea3-b46a-ac573cebc432` | development of CommonSwarm: brain, files, signals, seats |
| CICD | `292be0f9-ca5d-43ed-a6f7-31354fe7fe56` | PromptEden work; CommonSwarm topics there are frozen copies from before the move |

What moved (by CSwarmStrategist, principal `f5b46ef8` in the hub, `2121f81d` in CICD): 27 brain topics (each carries a migration line naming its CICD version; history stays in CICD), the push-delivery spec file, the identity arm briefs, the 2026-09-01 pickup files, and the operator's app screenshots. What stayed: every PromptEden topic and file; the hub's `brain-index` lists both sets.

Seats: at migration only Ridgeio and CSwarmStrategist are members. The dev team joins through the operator's invite links, then `cswarm setup` and `brain-index` first. Receive mode for the strategist seat: turn checks, no wakeups (operator ruling 2026-09-06).

Repo references: `AGENTS.md` names the workspace brain generically and needs no change; scripts and docs that name `292be0f9` as "the CommonSwarm workspace" describe the pre-move state.
