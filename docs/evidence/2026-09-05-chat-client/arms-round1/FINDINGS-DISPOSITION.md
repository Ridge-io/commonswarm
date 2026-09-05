# Round 1 arms on SHA 47c034d — both FAIL, and what happened to each finding

Grok and Gemini both returned `VERDICT: FAIL`. Every finding was read at the
cited lines before it was acted on.

| Arm | Finding | Verified? | Disposition |
|---|---|---|---|
| grok | `channel archive` and `channel rename` resolve the SELECTOR after `fileContext`, so a selector that cannot be a channel name is told the credential is unreadable instead | YES | Fixed. `channelSelectorKind` classifies the selector purely, before the credential. |
| grok | A mistyped id (36 characters, so over the name bound) is told the NAME rule alone, which is the wrong remedy for someone who meant an id | YES | Fixed. `channelSelectorProblem` names both rules, both generated. |
| grok | The spawn test never covered `channel archive <bad>` or `channel rename <bad-selector> …`, so the suite stayed green while the defect above was true | YES | Fixed. Both cases added, plus `inbox`, `working-on` and `ask`. |
| grok | `inbox --follow --channel "Not A Slug"` is told to fix the name; fixing it leaves a combination that is still refused | YES | Fixed. `channelOption` now runs after the combination checks. |
| grok | `--broadcast-to-channel` success copy came from the FLAG. A thread reply is filed in its root's channel, so an unfiled root stores `broadcast_to_channel: true` with `channel_id` null, and the sentence was false | YES | Fixed. `threadReplyMessage` reads the returned row and has three states, absent included. |
| grok | `SignalRecord.channel_id`'s comment said readers normalize absence to null; `parseSignalRecord` does the opposite | YES | Fixed. The comment now states the absent/null distinction the code makes. |
| grok | The subcommand check went one way only (advertised is a subset of the refusal), so a dispatch entry with no help line would pass | YES | Fixed. The two sets are compared. |
| BOTH | The reserved-name loop is vacuous when `RESERVED_CHANNEL_SLUGS` is empty | YES | Fixed with a subject guard. Mutation M27 empties the list in BOTH modules so the drift test stays green, and the guard is what turns it red. |
| gemini | Em-dash in `src/cli.ts:628` ("deployment's operators — agents are encouraged…") | YES, and it is a CONTEXT line | NOT this lane. It is on `main` already; the diff shows it with a leading space, not a `+`. Prose belongs to lane L8 `chat-copy`. |
| gemini | Dead code at `src/cli.ts:887-897`: `runChannelArchive` catches a `channel_archived` error that the edge never returns | NO. Those lines are `agentCredential`, and `grep -rn channel_archived src/` returns nothing | Does not exist. No change. |
