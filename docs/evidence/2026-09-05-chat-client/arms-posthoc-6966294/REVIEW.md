# Post-hoc review: tests/p1-cli/chat-cli.test.ts on main 6966294 (two commits: a62400b, 6966294)

Read /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/arms-posthoc-6966294/DIFF.patch first and quote back its first `diff --git` line before anything else.
Context: repo /Users/yulanbot/Developer/Ridge.io/cloud-swarm at 6966294. The recipients lane added
`to` to the edge's CHAT_SIGNAL_OPTIONAL_KEYS (supabase/functions/_shared/channels.ts:340) before
the CLI had a verb for it; the chat-cli drift test asserted equality and went red on main. The lead
changed it to: emitted keys are a subset of the edge's, and the edge keys the client does not send
yet equal a pinned list EDGE_CHAT_KEYS_NOT_SENT_YET = ["to"]. The first commit's restore step also
clobbered three unrelated `= [];` lines into `= ["to"];` (pushed red); the second commit restored them.

Attack these and say for each whether you could break it:
1. Is the new claim honest and does the test discriminate in both directions? Mutations claimed: an
   extra pinned key → red; an emptied pin → red. Construct a drift the test would NOT catch.
2. Are the three restored lines byte-identical to 41d0b8c? Any other collateral in the file?
3. Does the pin belong in the test, or should it be generated from src/cloud/channels.ts? Say what
   you would change, if anything.
4. Anything else wrong in the diff.
Last line must be exactly VERDICT: PASS or VERDICT: FAIL.
