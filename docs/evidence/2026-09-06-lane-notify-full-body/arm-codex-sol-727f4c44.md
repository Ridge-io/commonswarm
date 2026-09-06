# D-036 Codex arm — lane/notify-full-body @ 727f4c44

**Arm:** Codex, `gpt-5.6-sol`, `model_reasoning_effort=xhigh`, `--sandbox read-only`, OpenAI Codex v0.153.4.
**Run by:** CSwarmStrategist seat on `yulanbots-mac-mini`, 2026-09-06, at the request of CSLaptopLead
(ask `f7442c59-7eb3-4b44-966c-151e29cfbf17`).
**SHA reviewed:** `727f4c4450fa0564132391b8fa6c69e034d8e534` (code). Final branch SHA `86636cef` adds
`docs/evidence/` only. Merge-base `4ab44caccd771d126069364198018ef5b30ec38b`.
**Spec:** `docs/design/2026-09-06-NO-TRUNCATION.md` at `spec/app-backlog` `7d98f1ed`, change **C1**, lane **L1**.
**Worktree:** detached at `727f4c44`; the arm read the tree, ran the four new tests and `tsc --noEmit`.
**Prior arms:** Grok exact PASS, Gemini (agy) inversion PASS — both filed in this directory.

## VERDICT: FAIL

## Lead's ruling on the split (2 PASS / 1 FAIL)

The FAIL is **upheld**, on one point, verified on this host rather than taken from the arm.

**Blocker.** The generated phrase ends `full text: cswarm inbox`. That command, as typed, cannot show
the body to the reader the line addresses. Live control, cswarm 0.1.60 `dist/cli.js`, on
`yulanbots-mac-mini`:

```
$ node dist/cli.js inbox
cswarm: could not refresh your session. If you are a person, run cswarm login to sign in again.
If you are an agent, pass --agent-token-file <path ...> (or --agent-token-stdin).

$ node dist/cli.js inbox --agent-token-file ~/.config/cswarm/agent-token.json
cswarm: agent credentials never inherit a human's saved Cloud target; pass --url and --anon-key
or set SWARM_CLOUD_URL and SWARM_CLOUD_ANON_KEY
```

Positive control on the same invocation family — the form that does work, and does print bodies whole:

```
$ node dist/cli.js inbox --agent-token-file ~/.config/cswarm/agent-token.json \
    --url https://api.commonswarm.com --anon-key "$(cat ~/.config/cswarm/anon-key.txt)" \
    --workspace-id 292be0f9-ca5d-43ed-a6f7-31354fe7fe56
Inbox:
- [note] agent CSwarmStrategist (...) ...
```

Cause, in code: `inbox` resolves an agent identity only from `CREDENTIAL_FLAGS`
(`src/cli.ts:504`, `:877-879`), and an agent credential then **requires** a workspace
(`src/cli.ts:2500-2508`). There is no implicit agent credential.

This is the `AGENTS.md` "an enumeration inside a message must be generated, not typed" family — the
same shape as the `claude login` / `claude auth login` remedy, measured four times in v0.1.48-v0.1.50,
each time after two arms passed. The inconsistency is **inside one line**: the sibling
`reply_command` in the same file already names `--workspace-id`
(`src/cloud/arrival-watch.ts:371-376`), with a comment recording that the omission of `--url` and
`--anon-key` was a dogfooded decision. The new phrase omits even the workspace id.

**Second, non-blocking but owed:** the spec's own acceptance line for C1 is
`cswarm inbox --notify --json` -> a line whose `body` equals the posted body. No test runs that path.
The four new tests call the factory directly (`tests/support/arrival-watch.test.ts:243-313`), and the
CLI-level test exercises readable mode only — `tests/p1-cli/arrival-notify.test.ts` contains no
`--json` assertion. Removing `body` in `src/cli.ts:4054-4057` would leave every gate green.

**Graded down from the arm's list** (real, but not blockers):
- *Unit mismatch* (cut condition uses the collapsed length; `M` is raw `body.length`): the arm's
  worked case prints `180 of 5,000 chars` for a body whose visible text is 300 characters. The
  sentence is misleading, but `M = body.length` is what C1 prose asks for. This is the spec author's
  ruling to make, not the lane's error.
- *Off-by-one in `N`*: `snippet.length` counts the `…`, so 180 names 179 characters of body. C1
  names `snippet.length`. One character. NIT.
- *Whitespace and control characters collapse with no phrase*, and *`slice` can split a surrogate
  pair*: both pre-date this lane (`4ab44ca:src/cloud/arrival-watch.ts:362`). Not introduced here.

**Clean, and independently confirmed:** no second construction site of `ArrivalNotification`; the
edge/protocol bundle is unaffected (`package.json:19` bundles `src/protocol/index.ts` only); the body
reaches no cursor file or lock file (`CURSOR_MAX_BYTES`, `WATCH_LOCK_MAX_BYTES` bound other records);
the only production consumer is `runInboxNotifyCommand` writing stdout; no `error.message` branching
(the EPIPE classifier reads `.code`, `src/cloud/arrival-watch.ts:407-411`); and
`tests/support/arrival-watch.test.ts` is in the literal `npm test` list (`package.json:23`).

**Gate re-run by the lead** on `727f4c44` in a clean detached worktree: `npm test` — **897/897 pass,
0 fail**, duration 15.1s. The lane's gate claim holds.

**Smallest fix that clears the blocker:** build the full-text command the way `arrivalReplyCommand`
builds its own — from the workspace id the notification already carries — so the phrase names a
command the reader can run, and export it as one constant that a test compares against the flag set
`inbox` enforces.

**Not established by this arm:** no live `cswarm inbox --notify --json` process was run against
production, so the `body` field was never observed on the wire; phone/OS clipping of the readable
line was not tested; `npm run test:p1-cli` was not run at this SHA by the lead.

---

## Arm output, verbatim

The notice makes a false promise: `full text: cswarm inbox` does not reliably select the notified agent or signal, so it can omit the body it promises to show (`src/cloud/arrival-watch.ts:365-376`, `src/cli.ts:2487-2533`, `src/cli.ts:3794-3815`).

## Blocking findings

1. **Unit mismatch.** For `149 × "a" + 4,701 spaces + 150 × "b"`, the raw length is 5,000 and the collapsed length is 300. The output says `180 of 5,000 chars`, although the snippet contains 179 units of normalized text plus `…`. The two numbers do not measure the same representation, so the sentence is misleading (`src/cloud/arrival-watch.ts:373-390`). No test covers a raw-long and collapsed-long body; the whitespace test covers only a collapsed body below the cap (`tests/support/arrival-watch.test.ts:301-313`).

2. **Off by one.** `slice(0, 179)` shows at most 179 body code units. The ellipsis makes `snippet.length` equal 180, and the notice calls all 180 “chars” from the body (`src/cloud/arrival-watch.ts:374-383`). The spec does require `snippet.length`, so the implementation follows that instruction, but the resulting sentence overstates the shown body by one. The tests pin this wording (`tests/support/arrival-watch.test.ts:253-266`, `tests/support/arrival-watch.test.ts:292-296`).

3. **Inverse failure.** A body made from 90 `a` characters, two newlines, and 89 `b` characters has raw length 181 but collapsed length 180. Its newlines are lost and no suffix appears (`src/cloud/arrival-watch.ts:359-390`). Leading and trailing whitespace is also removed without a suffix. An 8,000-space body becomes an empty readable snippet with no suffix; such a body passes the length checks because signal sanitizing does not trim spaces (`supabase/functions/_shared/signal-text.ts:13-22`, `supabase/functions/command/index.ts:1825-1828`). An empty body gives the same helper result, but official posting rejects it (`src/cli.ts:2730-2742`). There is no opposite case: when the suffix appears, the same normalized value is longer than the cap and is truncated (`src/cloud/arrival-watch.ts:360-383`). The collapsed-length deviation is therefore unsafe.

   The placement deviation is readable, but it does not meet the stated ending requirement. The suffix is before attachments and the reply command, and the test explicitly pins that order (`src/cloud/arrival-watch.ts:431-434`, `tests/support/arrival-watch.test.ts:269-270`).

4. **Unicode.** `"😀".repeat(90) + "a"` has 181 UTF-16 code units but 91 Unicode code points. `slice(0, 179)` splits the last emoji and creates a lone high surrogate (`src/cloud/arrival-watch.ts:381-383`). A terminal receives a replacement character. `JSON.stringify` emits the malformed snippet as `\ud83d`, while the new `body` field remains intact (`src/cli.ts:4054-4057`). The split existed before this lane in `4ab44ca:src/cloud/arrival-watch.ts:362`. The new phrase makes the code-unit count visible as “chars,” but it did not create the surrogate bug. No new test uses astral characters (`tests/support/arrival-watch.test.ts:243-313`).

5. **Size.** A supported body is limited to 8,000 JavaScript code units at both CLI and edge input (`src/cli.ts:2727-2742`, `supabase/functions/command/index.ts:1825-1828`). The JSON line is written through a normal Node stream and the code waits for its write callback; there is no local line-size buffer (`src/cloud/arrival-watch.ts:443-471`). `CURSOR_MAX_BYTES` applies only to a record containing workspace, principal, timestamp, and signal ID (`src/cloud/arrival-watch.ts:323-355`). `WATCH_LOCK_MAX_BYTES` applies only to the PID lock (`src/cloud/arrival-watch.ts:228-253`). The body reaches neither file; cursor advancement writes only `cursorOf(row)` (`src/cloud/arrival-watch.ts:474-475`, `src/cloud/arrival-watch.ts:663-670`). Limits in an external stdout reader were not established.

6. **Leak and consumers.** The sole production construction and consumption path is `runInboxNotifyCommand`: it creates the object and sends either its JSON or its readable formatting to stdout (`src/cli.ts:4048-4058`). The full body is therefore new only on requested `--json` stdout. The readable line exposes its length, not its full contents (`src/cloud/arrival-watch.ts:373-376`, `src/cloud/arrival-watch.ts:428-434`). Retry information goes separately to stderr, and the post-render report receives signal IDs only (`src/cli.ts:4060-4079`). No body is persisted.

   Repo imports are `src/cli.ts` (`src/cli.ts:223-237`) and tests: support (`tests/support/arrival-watch.test.ts:12-28`), CLI notify (`tests/p1-cli/arrival-notify.test.ts:13-15`), resume (`tests/p1-cli/resume.test.ts:21-24`), and attachments (`tests/p1-cli/signal-attachments.test.ts:9-10`). No hook imports this module (`src/listener/hook.ts:1-39`).

7. **Type and API.** There is no second `ArrivalNotification` object-literal construction in the repo; the factory supplies the required field (`src/cloud/arrival-watch.ts:408-424`). Source and test type-checks passed with `tsc --noEmit`. Exporting `ARRIVAL_SNIPPET_MAX` only widens the API (`src/cloud/arrival-watch.ts:35`). The edge bundle is built only from `src/protocol/index.ts`, so this cloud-client type does not affect it (`package.json:19`). The changed logic does not branch on `error.message`; the nearby error classifier uses `code` (`src/cloud/arrival-watch.ts:437-440`).

8. **Test gate.** `tests/support/arrival-watch.test.ts` is explicitly present in the literal `npm test` command (`package.json:23`). I ran the four new tests directly; all four passed (`tests/support/arrival-watch.test.ts:243-313`). I also ran source and test type-checks successfully. I did not run the complete `npm test` suite.

9. **Mutation weaknesses.**

   - The 8,000-character test serializes the factory result directly. The CLI could remove `body` before writing JSON and this test would still pass because it never runs `runInboxNotifyCommand` (`tests/support/arrival-watch.test.ts:243-254`, `src/cli.ts:4054-4057`). The real CLI test runs readable mode only (`tests/p1-cli/arrival-notify.test.ts:133-151`).
   - The path test checks the text `cswarm inbox` but never runs that command. The current false recovery path therefore passes (`tests/support/arrival-watch.test.ts:257-270`).
   - A cut predicate that collapses whitespace but does not replace C0/C1 controls would pass all four new inputs and fail on control characters (`tests/support/arrival-watch.test.ts:243-313`, `src/cloud/arrival-watch.ts:386-390`).
   - The boundary negative does reach its claimed path: an implementation with no suffix would fail its over-cap positive assertion (`tests/support/arrival-watch.test.ts:277-298`).

Plain `cswarm inbox` is not a valid full-text remedy. Without agent credential flags it uses the human session (`src/cli.ts:2504-2533`), while notify requires an agent credential and explicit workspace (`src/cli.ts:3982-3996`). It also has no signal-ID filter, defaults to 50 rows, excludes stale rows, and reads newest first (`src/cli.ts:3795-3815`, `src/cloud/signals.ts:838-843`, `supabase/functions/read/index.ts:794-827`). Even when the row is present, its readable renderer applies its own 8,000-unit display cap (`src/cloud/signals.ts:1881-1905`).

VERDICT: FAIL
