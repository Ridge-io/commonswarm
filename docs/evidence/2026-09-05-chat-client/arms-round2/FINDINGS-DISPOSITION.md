# Round 2 arms on SHA 5ad4bd8 — both FAIL, one finding each

| Arm | Finding | Verified? | Disposition |
|---|---|---|---|
| grok | `channelSelectorProblem` substituted the SHAPE rule for every miss, so `cswarm channel archive all-signals` was told a name uses lowercase letters, digits and hyphens and is 1 to 32 characters — which `all-signals` already is. The rule it broke is that the name is RESERVED, and `channel create` says so while rename and archive did not. Untested, because the reserved spawn covered `create` only | YES | Fixed. A new `channelNameProblem` classifier returns the reason as a value; `channelSlugProblem` is derived from it and stays byte-identical to the edge's; `channelSelectorProblem` answers with the rule that actually broke. Reserved-selector cases added for archive and rename. |
| gemini | The test parsed the subcommand names back out of the refusal sentence, which is a typed assumption about English punctuation: a legitimate rewording would fail it | YES for the first half. The second half ("could erroneously pass on `create, ls, or, archive`") is WRONG: `"or".replace(/^or\s+/,"")` leaves `"or"`, which is length 2 and survives the filter, so the set comparison fails | Fixed anyway, and better than asked: `CHANNEL_SUBCOMMAND_NAMES` is exported from the dispatch table and the test compares that set with the help lines. No prose is parsed. |

Also taken from grok's refutations, though it raised neither as a finding:

- The "chat keys" test compared the edge's list with a TYPED array, which is not
  a claim about the client. It now drives `sendSignal` with every option set and
  diffs the emitted keys against the installed body, so both sides are measured.

Both arms independently confirmed the two round-1 rejections (the em-dash is a
context line already on `main`; the `channel_archived` dead-code finding does
not exist).
