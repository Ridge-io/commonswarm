# L1 round 2 — `lane/notify-full-body` @ daebc48d: lead verification, and the arm that is still owed

**Asked:** run the Codex `gpt-5.6-sol` D-036 arm on daebc48d (ask `921dea51`).
**Ran:** nothing. **The Codex arm is NOT done and the lane still owes it.**

```
$ codex exec --model gpt-5.6-sol  ... (L2 run, cut off mid-review)
ERROR: You've hit your usage limit. ... or try again at 6:35 PM.
$ codex exec --model gpt-6-astra -c model_reasoning_effort=low --sandbox read-only "Reply with exactly: PROBE-OK"
ERROR: You've hit your usage limit. ... or try again at 6:35 PM.
```

Measured 2026-09-06 14:31 CDT on `yulanbots-mac-mini`. The account is out of Codex credits until
18:35 CDT, on `gpt-5.6-sol` **and** on the `gpt-6-astra` fallback, so no Codex-family arm can run on
this host before then. A run that ends without a `VERDICT` line is not a review; nothing here should
be counted as one.

## What the lead did establish, first-hand

The fix is the right one for the blocker this seat upheld on 727f4c44, and it is measured, not read.

**The old command could not work; the new one is at parity with the shipped convention.** Controls on
this host, cswarm 0.1.60 `dist/cli.js`, workspace `292be0f9`:

```
$ node dist/cli.js inbox                                    # what the OLD phrase named
cswarm: could not refresh your session. ... If you are an agent, pass --agent-token-file <path ...>
$ node dist/cli.js inbox --agent-token-file ~/.config/cswarm/agent-token.json
cswarm: agent credentials never inherit a human's saved Cloud target; pass --url and --anon-key ...
```

The old phrase was a dead end twice over: it omitted the workspace, so even a reader who added its
credential hit a *second*, different refusal. The new phrase names `cswarm inbox --workspace-id <ws>`,
built at run time from the notification (`arrivalFullTextCommand`, `src/cloud/arrival-watch.ts:361-374`).
Its flag set now equals the sibling reply command's, pinned by a test that compares the two
(`tests/support/arrival-watch.test.ts:296-313`) rather than by typed copy.

**Parity is exact, and it is parity with something that also needs a credential flag:**

```
$ node dist/cli.js inbox --workspace-id 292be0f9-...     # the NEW phrase, as printed
cswarm: could not refresh your session. ... pass --agent-token-file <path ...>
$ node dist/cli.js reply 19bcfcd4-... "probe" --workspace-id 292be0f9-...   # the SHIPPED convention
cswarm: could not refresh your session. ... pass --agent-token-file <path ...>
```

Identical. The printed command is therefore exactly as runnable as the `cswarm reply` line that has
shipped and been dogfooded on this surface, and its one remaining gap names its own remedy in the
error. Positive control that the route is real once the reader supplies what that error asks for:

```
$ SWARM_CLOUD_URL=https://api.commonswarm.com SWARM_CLOUD_ANON_KEY=... \
  node dist/cli.js inbox --agent-token-file ~/.config/cswarm/agent-token.json --workspace-id 292be0f9-...
Inbox:
- [note] agent CSwarmStrategist ... (full bodies, not clipped)
```

**Verdict on the fix, as the lead and not as an arm: the 727f4c44 blocker is closed.** Whether the
reply/full-text convention should print the credential flag at all is a repo-wide question about
`arrivalReplyCommand`, not this lane's.

**The owed CLI control is real and reaches its path.** My 727f4c44 review said deleting `body` in
`src/cli.ts:4056` would leave every gate green. Mutation on the round-2 tree:

| tree | `tests/p1-cli/arrival-notify.test.ts` |
|---|---|
| daebc48d as written | pass 2, fail 0 |
| `JSON.stringify({ ...notification, body: undefined })` at `src/cli.ts:4056` | **pass 1, fail 1** |
| mutation reverted, same anchor | pass 2, fail 0, `git diff --stat` empty |

The new test spawns the real `inbox --notify --json` against a loopback read service, so it fails for
the reason it claims. Gap closed.

**Gates re-run by the lead on daebc48d, clean worktree, `node_modules` symlinked:**

- `npm test` — **898/898**, 0 fail.
- `npm run test:p1-cli` — **490/490**, 0 fail.

**On the lane's unexplained failures.** The lane reported one run with 2 failures, names not captured.
My first `npm test` invocation on this SHA also failed one assertion, and I did not capture its name
either — four later full runs were 898/898 and six consecutive runs of
`tests/p1-cli/arrival-notify.test.ts` alone were 2/2. So: 4 of 5 full runs clean here, one
uncaptured failure, on a host also running other agents' work. **Not explained, and not called
transient.** Whoever sees it next must save the run output; a timeout with no assertion text on a
loaded host is the contention signature `AGENTS.md` describes, but I did not establish that this was
one.

## Not established

- The Codex arm on daebc48d. It is owed, and cannot be run on this host before 18:35 CDT.
- No live `cswarm inbox --notify --json` against production; the CLI control uses a loopback service.
- The identity of the one failing assertion in my first full run.
