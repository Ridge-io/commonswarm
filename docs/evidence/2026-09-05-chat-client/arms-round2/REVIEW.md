# D-036 review brief — lane `chat-client`, SHA 5ad4bd8

Repo: CommonSwarm (`cswarm` CLI + Supabase edge functions + Astro site).
Review the PATCH at the absolute path given to you, not the working tree. You
may read UNCHANGED files in the repo for context; they are named below.

Before any finding, quote back the FIRST `diff --git` line of the patch verbatim.
If you cannot read the patch, say so and stop.

Repo root: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-chat-client`

## What this lane claims

The `cswarm` CLI learns channels and threads against a chat wire that is ALREADY
LIVE in production (edge merge 8adf55a). This lane changes NO migration and NO
edge function. Specifically:

1. `cswarm channel create <name> [--purpose <text>]`, `cswarm channel ls
   [--include-archived]`, `cswarm channel rename <name|channel-id> <new-name>`,
   `cswarm channel archive <name|channel-id>`.
2. `--channel <name>` on `working-on`, `note`, `ask`, `feed`, `inbox`.
3. `cswarm reply <signal-id> "<text>" --thread [--broadcast-to-channel]` posts a
   thread reply rooted on that signal. Plain `cswarm reply` is unchanged.
4. Every user-facing enumeration or bound is generated from the constant the
   enforcement reads, never typed.
5. Refusals render the server's own `message` when present, and never branch on
   its prose (D-053).

## The wire, as the live edge defines it (UNCHANGED files; read them)

- `supabase/functions/_shared/channels.ts` — the constants, the generated
  sentences, `chatSignalKeys` / `chatReadKeys`, `chatSignalShapeProblem`.
- `supabase/functions/command/index.ts` — the `channel_create` /
  `channel_rename` / `channel_archive` validators (search
  `cmd.kind === "channel_create"`), the `post_signal` chat keys, and the refusal
  envelope (search `"payload_too_large"` to find where `message` is attached).
- `supabase/functions/read/index.ts` — the `channel` filter and the complete set
  of resources the read edge answers.
- `tests/p1-server/chat-signals.test.ts` — the exact bodies a real command
  function accepts, including its `installedPost()` helper.

## Checks to attack, in order. Try to REFUTE each claim.

1. **`exactKeys` compatibility.** `ThinCommandClient.sendSignal` REBUILDS the
   command object before sending. Does any path put `channel`,
   `thread_root_id` or `broadcast_to_channel` on the wire as an explicit `null`,
   or add a key the caller did not set? The command edge's `exactKeys` refuses
   any key it was not expecting, so ONE unconditional key would return 400 on
   every post from this client. Reason about `JSON.stringify` as well as the
   spreads. Construct the exact body a plain `cswarm note "hi"` sends and
   compare it key for key with `installedPost()` in the p1-server test.

2. **A typed enumeration inside a sentence.** `src/cloud/channels.ts` is a
   deliberate COPY of the edge module because `tsconfig.json` pins
   `rootDir: "src"`. Find any user-facing string in the patch that lists things
   the code enforces — accepted subcommands, valid names, reserved names, the
   read edge's resources, the chat keys — where the list is typed rather than
   built from the constant the enforcement reads. Then check whether the drift
   test in `tests/p1-cli/chat-cli.test.ts` actually covers each one. The header
   of that test states a bound: is the bound true, and is it complete?

3. **D-053.** Find any place that branches on `error.message`, on server prose,
   or on a message this client wrote, rather than on a status, a named class, or
   a stable server code. Look hard at `channelCommandError` and at
   `unknownChannelReadMessage` in `src/cli.ts`.

4. **Thread replies.** `--thread` sets `thread_root_id` and forces `in_reply_to`
   to null. Is that correct against `chatSignalShapeProblem`? Can a caller reach
   a body the edge refuses, or one the edge ACCEPTS with a meaning different
   from what the CLI printed? Check the `replyRefusalHint` suppression under
   `--thread`: is the suppressed hint ever the correct explanation for a thread
   reply's 403?

5. **The read paths.** `humanSignals` asks PostgREST for three extra columns
   ONLY when a channel filter is set, and `agentSignalPage` sends `channel` in
   its own key. Can either change break a read that names no channel?
   `parseSignalRecord` now OMITS the chat fields when the row does not carry
   them, rather than normalizing to null — attack that: does anything downstream
   read `record.channel_id` and treat `undefined` as a value? Does
   `normalizedSignalQuery` carry the new query fields through?

6. **`channel ls` for an agent credential.** The lane claims the `read` edge has
   NO channels resource and that `swarm_read.channels` is gated on `auth.uid()`,
   so an agent token cannot list channels. ENUMERATE the resources in
   `supabase/functions/read/index.ts` and say whether the claim is true. If
   there is a route the lane missed, that is a finding. The refusal sentence
   deliberately does NOT list what the read service does answer; say whether
   that is the right call and whether the sentence is still actionable.

7. **Refusal ordering.** In each channel subcommand: positional check,
   `assertShape`, then the name rule, then the purpose bound, then the network.
   Is any check ordered so a caller is sent to fix the wrong thing? Compare with
   the edge's own ordering in `chatSignalShapeProblem` and in the
   `channel_rename` validator. Is any purely local refusal paid for with a
   network call?

8. **Tests that pass for the wrong reason.** In
   `tests/p1-cli/chat-cli.test.ts`, does each probe reach the code path it
   claims to test? The spawn tests use `--agent-token-file /nonexistent/nope.json`
   as a positive-control marker, and one test deliberately reads only the
   refusal LINE because a `UsageError` prints the whole usage block after it.
   Could a test pass while the feature is broken? Could the drift comparison
   pass vacuously (empty loop, `undefined === undefined`, a `deepEqual` of two
   missing exports)? Is any assertion pinning a CLAIM the underlying system does
   not make? `docs/evidence/2026-09-05-chat-client/mutations.txt` records one
   mutation per test; check whether any mutation is weaker than the claim.

9. **Anything else that is wrong.** A wrong remedy inside a message; a claim
   that does not hold for BOTH the hosted workspace and a local listener; an
   em-dash in user-facing CLI output (code comments are exempt); a sentence that
   promises something the code does not do; dead code; a message that says
   "nothing changed" where something did.

## Output

Findings first, each with the file and the line as it appears in the patch, and
the reason it is wrong. Then the refutations you attempted and could not make
stick. The LAST line of your reply must be exactly one of:

VERDICT: PASS

or

VERDICT: FAIL

## Round 2 note — what changed since the last review, and what to attack hardest

Both arms returned FAIL on the previous SHA. Seven findings were verified at
their cited lines and fixed; the fixes are in this patch. Attack the FIXES, not
only the original code:

- `channelSelectorKind` / `channelSelectorProblem` — is the selector now
  classified before ANY credential or network work in BOTH `channel rename` and
  `channel archive`? Is there still a path where a purely local refusal is paid
  for with a credential read or a workspace validation?
- `threadReplyMessage` — three states (a channel, no channel, absent). Is any of
  the three sentences false for a body the edge can actually produce? Does the
  `--json` branch print the same sentence as the text branch?
- `runSignalRead` ordering — the `--follow` / `--channel` refusal now precedes
  the name rule. Did moving `channelOption` break `inbox --notify`, which does
  not accept `--channel` at all, or any wait/ndjson path?
- The subcommand set comparison in the test parses the refusal sentence. Can it
  pass on a malformed sentence? Is the parse itself a typed assumption?
- The reserved-name subject guard: does it now FAIL for a legitimate product
  change (emptying the reserved list), and is that the right behaviour?

Two findings from the last round were rejected, with the reasons recorded in
`docs/evidence/2026-09-05-chat-client/arms-round1/FINDINGS-DISPOSITION.md`,
which is in this patch. Read it. If you think either rejection is wrong, say so
and show the evidence — that is a finding.
