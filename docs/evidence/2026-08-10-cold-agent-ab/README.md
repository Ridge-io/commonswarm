# Two-cold-agent test against 0.1.12 — A/B on the onboarding prompt

**What this measures:** CHARTER §6 item 1, *"install and authenticate without being walked
through"*, against a cold agent. Wren relayed the operator's report that two cold Claude agents
were given the onboarding prompt and **one stopped without authenticating**, asking the human to
type the command — which is the definition of being walked through.

## Design, and why there is a control

Three cold agents, spawned in parallel, each given ONLY the onboarding prompt plus a neutral
framing, each told to follow it literally **including any instruction to stop**, each barred from
reading the repo or searching for docs. Separate working directories, separate credentials,
separate principals, one dedicated workspace.

| arm | prompt |
|---|---|
| **A**, **B** | the deployed 0.1.12 prompt, with the sanctioned form |
| **CTRL** | byte-identical EXCEPT step 3, reverted to the exact pre-fix wording |

**The control is the whole point.** Wren's original observation was a 1-of-2 split on identical
prompts, so a single agent connecting proves less than it appears to. If CTRL also connects, the
instrument cannot discriminate between the two wordings and nothing A and B do means anything.

Both arms were rendered by the real `dashboardAgentPrompt` with real production values and a real
minted credential. Verified before the run: `sanctioned form` present 1 / absent 0 across the
arms, `stop instead of improvising` absent 0 / present 1.

## CTRL — STOPPED, and quoted the sentence

```
OUTCOME: STOPPED
IF STOPPED, WHY: "If your host cannot write to a running process's stdin separately,
                  stop instead of improvising."
```

It verified node v26.5.0 and `cswarm 0.1.12`, confirmed no install was needed, and stopped at step
3 without running `working-on`, `feed`, `listen start` or `inbox`. Its reasoning, unprompted, is
the same as the original agent's:

> "Every route left to me — echo/printf/heredoc into a pipe, or staging the credential in a file
> first and redirecting — is either explicitly forbidden or is improvising around the constraint."

**The instrument discriminates.** The pre-fix wording reproduces the original failure on demand,
against the CURRENT binary. That rules out the alternative explanation that 0.1.11 or the host was
at fault: same host, same binary, same credential shape, only the sentence differs.

## A defect in MY instrument, found by the control agent

It reported that `Agent name:` rendered the literal string `undefined`. That is **my harness, not
the product**: `agent-prompt.ts:70` reads `credential.principalName`, the site supplies it at
`agent-connect.ts:476` (`principalName: identity.name`), and the type is `name: string` —
non-optional, so a real user cannot see it. My render call omitted the field and I bypassed the
type with `as never`.

Recorded because it is the correct kind of finding to get from a control: it audited the
instrument rather than the product, and it was right to flag something that looked like a
rendering bug.
