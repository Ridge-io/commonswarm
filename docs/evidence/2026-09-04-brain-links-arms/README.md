# Review arms for `lane/brain-links` — brain topic mentions become controls in the feed

Six rounds on one lane, 2026-09-04. Every round's raw arm output is here, under the SHA it reviewed;
`ARM-EVIDENCE.md` is the PM's own round-by-round log (403 lines) with the mutation tables and the
launch table for the arms that stalled on the provider.

| round | SHA | verdicts | what the FAIL found, verified by the lead on the branch |
|---|---|---|---|
| 1 | `2808ae7` | Grok FAIL, Gemini FAIL | a nearby "brain" word as a linking cue matched inside `brain-how-to`; a URL query string split into a run; an AGENTS.md "same sentence" claim the code enforced as 48 chars |
| 2 | `5f0a3fb`/`b42e3d3` | Gemini PASS; Grok stalled ×6, then (lead, detached) FAIL | the topic list was a workspace-open snapshot no feed path refreshed, so a deleted topic still rendered a control whose click failed; "no dead link" claimed in the design doc and the new AGENTS.md paragraph |
| 3 | `2785510` | Gemini FAIL (lead) refuted; Gemini FAIL (lane) | the refutation: `canonicalBrainTopic` lowercases and rejects, so no stored topic carries uppercase. The lane's own arm: a click during an in-flight refresh decided against the stale snapshot — `brainLinkClickOutcome` returned `open` regardless of `listIsFresh` |
| 4–5 | `8395dd2`/`56a9496` | Grok FAIL, Gemini FAIL (both lane) | a workspace switch mid-read resolved without updating the list and the reader still set `fresh = true`; `RUN_RE` lacked `;` and `,` so a slug inside a URL got a control; the panel gate rebuilt Files/Brain exactly when the reader was on them, under a comment promising the opposite |
| 6 | `d3436cb` | Gemini PASS (lead), Grok FAIL (lead) | `openBrainTopic` awaited a forced re-read with no `requestVersion`/`activeWorkspaceId` capture while every sibling continuation had one; a click on A then a switch to B opened B's same-named topic. The switch test held `switching` true for every read and never reached the path |
| 7 | `e65af99` | Grok PASS, Gemini PASS | landed. Open, non-blocking, routed to a follow-up: `BrainLinkOutcome` may omit `abandoned`; the observer does not pin `listIsFresh` as the third argument; a topic named like `1.5` is slug-shaped and links in prose (a valid name, so an intended link) |

Green gates never caught any of these; every one was a false published claim or a reachable
sequence, found by an arm and verified at the cited lines before it was acted on. Two lane
mutation probes did not reach the code (a shell-escaped anchor; a `git checkout` on an uncommitted
test) and were redone — a mutation whose anchor misses is not a control.

Arm mechanics that mattered: prompt by absolute file path (an 80 KB argv shows up in `ps` and breaks
`cswarm resume` host-wide); `nohup … & disown` (a real review outlives the 10-minute tool cap);
identify an arm by its cwd and recorded pid, never by prompt text; require a quote-back of the
diff's first line; and a 0-byte `agy` file means "not finished", not "failed" — it buffers until exit.
