# Review arms — standing-grant follow-up

Two sets of files. They review DIFFERENT SHAs and only the first set is the D-036 record.

## D-036 arms on `2d9fbba` — the SHA that shipped

`lane/standing-default-followup`, four commits on `e433fd9`. Two families, neither the
author's (the author is Claude). Both prompts were passed BY FILE PATH, never inline argv —
an 80 KB argv shows in `ps` and breaks `cswarm resume` for everyone on a shared host.

| file | family | verdict |
|---|---|---|
| `PROMPT-d036-2d9fbba.md` | — | the prompt both arms were given |
| `VERDICT-grok-2d9fbba.txt` | Grok (`grok -p`) | **PASS** |
| `VERDICT-gemini-3.1-pro-high-2d9fbba.txt` | Gemini (`agy`, gemini-3.1-pro-high) | **PASS** |

Both PASS, both substantive, each with a citation per question.

**Grok passed and still listed three defects.** They are not blockers and are recorded because
a PASS with findings is not a clean bill:

1. `tests/p1-cli/citation-drift.test.ts` pins a parallel hand-typed table, so a citation
   OMITTED from that table never fails, and a comment retargeted inside a wide range that
   still contains the token never fails. It is a tripwire for the listed pointers, not a
   generated enumeration of the comments. Today every listed pointer resolves.
2. The timeboxed HTTP `horizon_expires_at` and the grant row are two additions of the same
   `now`. They match; they are not one expression. (See the WITHDRAWN section of
   `../NOT-FIXED-HERE.md` — an earlier claim that these were two different CLOCKS was FALSE
   and was traced to ground before being withdrawn.)
3. `site/src/lib/agent-connect.ts:277` cites `index.ts:1970-1978` for "an older command
   function rejects `renewal_kind`". Resolved against the shipped tree those lines ACCEPT it,
   because `optionalKeys` admits the key at `index.ts:1943`. The claim is true of an older
   build; the pointer, resolved today, shows the opposite.

Defect 3 was verified against the code by the author rather than taken on the arm's word, and
the correction is prepared at `../READY-citation-precision.patch`. The lead took option 1:
ship `2d9fbba` as reviewed, and carry that patch into the next lane touching
`agent-connect.ts`, with that lane's own arms.

## Spec critics on `e3df06b` — a superseded lane, kept for one reason

These attacked the ORIGINAL spec on `lane/standing-default-app` (branch deleted, was
`4dc50c1`) before any code existed. That lane was not merged; `e433fd9` superseded it.

| file | family | verdict |
|---|---|---|
| `PROMPT-spec-critics-e3df06b.md` | — | the prompt |
| `spec-critic-grok-e3df06b.txt` | Grok | FAIL |
| `spec-critic-gemini-e3df06b.txt` | Gemini | FAIL |

**Why keep a review of code that never shipped: the two arms contradicted each other on the
load-bearing question, and one was wrong.** Claim C4 asked whether an agent added in the web
app can still RENEW, given the grant binds to the browser's device row while the agent renews
from another machine.

- Gemini said **REFUTED** — "the CLI provides its own distinct device ID (`index.ts:2843`)
  ... The agent WILL expire." Listed as its top defect.
- Grok said **UPHELD** — "renewal from the agent machine PASSES ... Those two values are the
  same by construction."

Grok was right. `renew_agent_token` accepts exactly one key, `kind`
(`exactKeys(cmd, ["kind"])`), so a CLI cannot present a device id at all; the device reaching
the fence is the RUN's device, written at mint from the browser's id. Bound equals presented
by construction.

The lesson is the one AGENTS.md already states and this session re-learned twice: an arm's
finding is a lead, not a measurement. Two arms disagreeing is the cheap case — you notice.
The expensive case is a single confident arm, which is how the false "two different clocks"
claim reached a written artifact before being traced and withdrawn.
