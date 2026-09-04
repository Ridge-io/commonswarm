You are an ADVERSARIAL reviewer for CommonSwarm. Find what is WRONG. An empty PASS is not a review.
The patch is ./DIFF.patch in this directory; read it with your file tools. The repo is
/Users/yulanbot/Developer/Ridge.io/cloud-swarm; read any file on the branch with
`git show lane/brain-links:<path>`. Do not edit anything.

## What the patch claims (lane/brain-links @ b42e3d3, 6 files, +887)
When a signal body names a brain topic, the web feed renders it as a button that opens that topic,
Markdown-rendered, in the existing Brain panel. Detection is validated against the live topic list
already in the browser (`brainTopics(files, …)`, the same list the panel can open), so a link cannot
point at a topic that does not exist. Collision rule: a slug containing `-`, `_` or `.` links on exact
match anywhere; a one-word topic (`roadmap`, `releases`) links ONLY inside inline code. A nearby word
"brain" is NOT a cue (an earlier version used it; `\bbrain\b` matched inside `brain-how-to`). Parsing
and validation live in `site/src/lib/brain-links.ts`; LiveDashboard.astro gets four hunks (an
import, two helpers, the render hook after `setSanitizedMessageMarkdown`, CSS). One paragraph is
added to AGENTS.md telling agents to save durable objects into the brain.

## Doctrine that binds it (AGENTS.md)
Detection must not guess — a wrong automatic answer is worse than none. Any user-facing
enumeration must be generated from the constant that enforces it. Sweep the whole claim family.
A negative result must reach the path it claims to test. The product voice is plain and calm.

## Check, with an attempted refutation each, citing the diff
1. Injection: the render hook runs AFTER the sanitizer. Find any way a signal body can produce a
   link, an attribute, or script through this pass — a topic name containing `<`, `"`, `javascript:`,
   a `data-` attribute, or Markdown that survives sanitization and is then re-parsed here.
2. False links: construct a body where text that is NOT a live topic becomes a button. Consider a
   topic that is a prefix/suffix of another (`roadmap` vs `commonswarm-roadmap`), a topic name with a
   trailing `.` at sentence end, a URL containing a topic slug in its path or query, a fenced code
   block, an existing `<a>`, and a body written before the topic existed.
3. Missed links the operator would expect: `There's a brain topic for CommonSwarm-roadmap` must
   link on the canonical slug; check case folding and the visible text is preserved.
4. The word gate: a one-word topic links only inside inline code. Is that enforced in the parser,
   or only in a test? Would a topic named `brain` or `the` cause harm?
5. Live-list binding: what if `files` is empty or stale when signals render (race at load, topic
   deleted after render, topic created after render)? Does a click on a deleted topic fail
   honestly?
6. The four LiveDashboard hunks: does the render hook run once per message or on every re-render,
   and can it double-wrap an already-linked span? Line ranges 1001, 3273-3288, 3797-3804, 9491-9522.
7. Tests: for each new assertion, would it FAIL if the behaviour regressed? Name any that assert
   `textContent` where the path being tested is an attribute or a node type. The PM claims 23 tests
   and a mutation for each; spot-check five.
8. AGENTS.md paragraph: is every sentence true of the shipped CLI (`cswarm brain put`), and does it
   tell agents anything they cannot do?

Your LAST line must be exactly `VERDICT: PASS` or `VERDICT: FAIL`.
