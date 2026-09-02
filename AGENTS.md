# AGENTS.md — commonswarm

You are AGI-pilled.

---

## Done means done

Not half done. Not done except for the part you decided to skip. And not a report about how it will be done.

Five things asked means five things delivered, no matter how long they'll take. If the fifth is genuinely blocked, finish the other four and name the blocker in one sentence. The specific blocker. Not "this needs more investigation."

## Act. Don't ask.

Reversible and cheap? Do it, then tell me. Research, data pulls, analysis, drafts, refactors inside the scope I gave you, testing an API. A question costs me more than a re-run costs you.

Ask first only for: anything reaching an audience, anything we cannot undo, anything expensive.

Something is broken? Fix it. Reporting an issue you could have fixed turns your work into my to-do list.

## A question is a question

When I ask a question, answer it. Do not implement it.

"Should we use X?" is not "migrate everything to X." "What would it take to add Y?" is not "add Y."

When in doubt, assume it's a question. Answer first. Act when I say go.

## Speed (Opus 5 only)

When running as Opus 5: optimize for wall-clock speed. Finish tasks quickly.

- Parallelize aggressively. Independent tasks run at the same time, never one after another — batch tool calls, spawn subagents concurrently.
- Delegate by complexity: Sonnet 5 subagents for routine work (search, bulk edits, boilerplate, verification), Opus 5 subagents for hard reasoning that can run independently.
- Keep working in the main thread while subagents run — don't sit idle waiting on them.
- Don't over-deliberate. Enough info to act = act. No long option surveys for decisions with an obvious default.
- Speed never trades away quality: same rigor, same verification, same "done means done". If parallelizing risks a worse result, slow down.
- No conflicts from parallelism: never let two subagents touch the same files or overlapping scope. Split work by non-overlapping boundaries; merge and reconcile results in the main thread.

## Short responses

It's been a long day and my brain is fried, talk to me like I'm 5.

Small words, short sentences, short paragraphs. If you have to use a big word, explain it right after. Only return what's actually necessary.

Just tell me what you did, did it work, what do I do now.

If I have to decide something: 2 options max, the context I need to pick fast, and which one you'd go with.

Keep paths and commands exact.

Always use ASD-STE100 Simplified Technical English when you talk to me.
---

**CommonSwarm** is a coordination service for people and AI agents working side by side. It has the
`cswarm` CLI, a hosted Supabase backend, and a web front door at https://commonswarm.com. Agents post
short, immutable signals of intent so collaborators do not step on each other. A signal never claims,
blocks, or closes a task.

Status: **P3-1, open free tier**. `SWARM_SELF_SERVE=1` is live in production; `/app` owns signup and
the workspace, while `/start` is a compatibility handoff. Node >= 22. The old "no web UI" and
"invite-only" claims are retired.

The product was renamed from `coswarm` to CommonSwarm / `cswarm` on 2026-07-27. Prose says
CommonSwarm; anything a user types says `cswarm`. Do not rename the Vercel project or alias
`coswarm-site`, or the paired build identifier `__COSWARM_VERSION__` in `scripts/build-release.sh`
and `src/cli.ts`. The PostgreSQL schema `swarm.`, `SWARM_*` variables, and separate local `swarm` CLI
are unrelated names.

The repo moved on 2026-08-10 by creating `Ridge-io/commonswarm`, not by renaming the old repo. Its
history was rewritten, so every SHA changed. `Ridge-io/cloud-swarm` was deleted on 2026-08-17.

## Commands

| Command | What it does |
|---|---|
| `npm install` | Installs dependencies; `prepare` builds the package. |
| `npm run build` | `tsc` → `dist/`; wipes `dist/` first and makes `dist/cli.js` executable after. |
| `npm test` | Pure gate for every file named in the literal `test` script; no network or database. |
| `npm run test:p1-cli` | Pure gate that globs `tests/p1-cli/**/*.test.ts`; no network or database. |
| `npm run test:p1-local` | Runs the four files named in the script; needs local Supabase and an exclusive DB slot. |
| `npm run test:p1-server` | Globs `tests/p1-server/**/*.test.ts`; needs local Supabase and an exclusive DB slot. |
| `npm run test:uxtest` | Runs the cross-machine UX harness. |
| `npm run check:tests` | Typechecks `tests/` as well as `src/`. |
| `npm run db:start` / `db:stop` / `db:reset` / `db:status` | Controls local Supabase; needs Docker. |
| `npm run build:command-core` | Regenerates the edge-function protocol bundle. |
| `npm run check:edge` | Runs `deno check` on `command`, `read`, and `capability`; needs Deno. |

The site is a separate project: `cd site && npm install && npm run build` (Astro 7, static output).

## Layout

```
src/protocol/   pure authority core — reducer, events, commands; no I/O
src/cloud/      client side — auth, signals, workspaces, transport
src/cli.ts      cswarm CLI surface
supabase/       migrations + Deno edge functions: command, read, capability
tests/          pure, CLI, local-Supabase, and server-Supabase suites
scripts/        build and verification helpers
site/           Astro site — hand-written CSS, no Tailwind
docs/design/    SWARM-CLOUD.md is the canonical spec; on conflict it wins
docs/evidence/  committed artifacts backing completion claims
```

## Reachable traps

**A test file runs only when a package script names or globs it.** `npm test` is a literal list;
`test:p1-cli` and `test:p1-server` glob their trees; `test:p1-local` names four files. A new file in
`tests/support/` does not run unless the script names it. Check the gate and report it when adding a test.

**Edge functions are outside `tsc`.** `tsconfig.json` includes only `src/**/*.ts`. Run
`npm run check:edge`; it names the current three entrypoints and no other gate runs it. A fourth function
would need adding, and a stale generated protocol bundle can still typecheck.

**`supabase functions serve` gives Deno only the values in `--env-file`.** Parent `env` values do not
reach it. Add every environment-gated test value to the temporary env file used by the server suite.

**`supabase/functions/_shared/protocol.js` is generated.** Edit `src/protocol/index.ts`, then run
`npm run build:command-core`; `pretest:p1-server` also regenerates it. Never hand-edit the bundle.

**A shared checkout can be on another agent's branch.** Before commit, run
`git rev-parse --abbrev-ref HEAD` and inspect `git worktree list`. Use one writer per branch/worktree;
never push a branch you do not own. Run `scripts/branch-audit.sh` before pruning local branches.

**`scratchpad/` is gitignored.** Put evidence that must survive in `docs/evidence/` or `docs/org/`.

## Session continuity

Read the newest `docs/org/*-RESUME-HERE.md` on `main` before re-deriving work:

```sh
ls -1 docs/org/*RESUME-HERE.md | sort | tail -1
```

The resume file must land on `main`. Write it for a cold successor and include: refs by hash; what is
LIVE versus merely written; the next file, line, or command; what is deliberately DEFERRED; what was
NOT established; and corrections to published claims, including the retired wording when readers may
still meet it. Record operator-relevant facts in a durable artifact as you learn them, not only in chat.

## Sprint hygiene: every lane leaves nothing behind

Measured 2026-09-02: `git worktree list` had 46 entries and 45 local branches before a cleanup lane pruned
them; the operator ruled that this is part of every sprint, not a chore for later. The lead runs it; a Codex
lane does the work.

1. **One worktree per lane, under the session scratchpad**, branch `lane/<name>`, `node_modules` symlinked
   from the main checkout. Never a checkout of the shared tree. Arms get their own detached worktree each.
2. **Merge, then delete.** When a lane's commits are on `main` (or on a `release/<v>` branch that reaches
   `main`), remove its worktree at once and delete the branch as soon as `git cherry main <branch>` shows
   zero `+` lines. A branch that still shows `+` lines is the only copy of something: keep it and say why in
   the ledger.
3. **A release ends on one branch.** Before writing "released", `git worktree list` shows the main checkout
   only and `git branch` shows `main` only. Dirty worktrees that are not yours: save `git diff` to
   `docs/evidence/<date>-cleanup/<branch>.patch`, then remove.
4. **Cleanup is a lane** (`scripts/branch-audit.sh` first, then `git worktree prune`, `worktree remove`,
   `branch -d`), with a protected list of live lanes and a report of every removal and every keep.
5. **Kill your processes.** No `codex exec`, arm, or test runner of yours survives the sprint; `pgrep -f
   <your scratchpad id>` must be empty before you report done.

## Verification

Read `docs/org/2026-07-26-simplification-state.md` before a nontrivial change.

- **Measure the artifact, not its name.** Resolve the path, URL, ref, or symlink first.
- **Run a positive control on the same invocation.** A probe that cannot fail proves nothing. Use
  `scripts/probe-check.sh` and `scripts/path-check.sh` rather than rebuilding their checks.
- **Enumerate, don't pattern-match.** List the set and count it; a grep against a guessed path can make a confident zero.
- **Pushed ≠ landed ≠ applied.** State which one you established.
- **Review the decision set, not only its items.** Individually correct rulings can be unsafe together.
- **Corrections go in the artifact, not in a message.** Preserve retired wording when later readers may meet it.
- **D-036 model-inversion gate:** every SHA-changing lane needs two substantive arms on the exact SHA:
  an exact review and an independent cross-family inversion. Choose two different families from Codex,
  Grok, and Gemini, in that preference order; the author's family is excluded. One arm, an empty PASS,
  or output without reasoning is not a review. If either arm changes the SHA, rerun both.
  - Call Grok headlessly as `grok -p "<prompt>"`. Do not pipe into it (`Device not configured`), and do
    not use macOS `timeout` (exit 127). Re-probe tool availability before stating it.
  - For every arm, assert that a `VERDICT` line is present. Absence of an error string is not success;
    a reply without a verdict is not a review, so the lane still owes that arm.
- **A claim about a running listener needs a live control.** Tests with a fake bridge and two review arms
  passed a lane whose status fields were `null` on a real detached listener (v0.1.46). A lane that changes
  what a live listener reports must start one with `--state-dir <temp>` and paste its status JSON.
- **Durable by default.** Operator- or system-read state belongs in Postgres. Process memory is only a
  cache or a home for state that can be derived again; serverless invocations do not share it.

State what you did **not** establish alongside what you did.

## D-053: never branch on `error.message`

`error.message` is presentation. Classify with a named error class, a stable code we assign, or our own
state; a caller's `AbortSignal` is authoritative for cancellation. Normalize raw stream failures to a
typed code at the boundary. Name every producer that can populate a message before clearing a classifier.

Measured instance: an ACP child's JSON-RPC prose was copied into an error, and a retry regex matched that
prose. With the same type and code, the provider could change whether CommonSwarm re-prompted it.

## Claim controls prove stability, not truth

If a test asserts a user-readable string, it reviews a **claim**, not only behavior. A control can
discriminate and still pin the wrong claim. Check each claim against what the underlying system does,
not against another artifact that repeats it. Enumerate every surface in the claim family—including
tests, comments, and docs—then read each statement clause by clause.

Measured instance: sign-out copy said it ended every session, and a test required `/every session/`.
The endpoint revoked refresh tokens but could not revoke issued access JWTs. The green mutation control
therefore defended a false claim, and a sibling clause survived until the whole claim family was swept.

## Honesty is not sufficient

When a command returns while work continues, state what the reader must do next. Exit 0 and a success-shaped
response can make a true state word easy to skip. Apply this to transitional states, partial success, and
accepted-but-not-applied work.

Measured instance: `cswarm listen stop` returned `state: "stopping"`, exit 0, and readers treated teardown
as complete. The durable form says: `This is still in progress. Confirm with: cswarm listen status …`.

## A negative result must reach the path it claims to test

Before recording a negative, ask: **what would this probe return if the feature were present and working?**
If the answer is the same, the probe did not measure the feature. Show that the intended gate was reached;
mutation testing proves a control can fail, not that it fails for the claimed reason.

Measured instance: a control used `--not-a-real-flag`; the parser rejected it before the validator. It
failed whether the validator worked or not, so its negative result was not evidence about validation.

## Onboarding: ask for the minimum, detect the rest

1. **Every field must justify itself.** If context can determine or default it, remove it; put rare choices in settings.
2. **Detect rather than ask.** Let agents inspect their environment, repo, or APIs.
3. **Chrome is not information.** Remove borders, panels, headings, and helper text that only restate labels.
4. **Simplicity is an engineering result.** A short form can need more work behind it; budget for that.
5. **Measure fields and steps.** Record a reason for every addition.

Constraint: detection must not guess. `CLAUDE_CODE_ENTRYPOINT` can be inherited by a Codex child and
mislabel it as Claude Code. Return a value or nothing; a wrong automatic answer is worse than the question.

## Writing for users

The product voice is plain and calm. CLI output says what just happened, what is now true, and what happens
next, so nobody has to check whether it worked. The benefit is agents coordinating so collaborators are
unblocked — never control, authority, or enforcement (that framing was retired as friction). Availability
copy asserts deployment state and lives in git: when a gate flips, grep every surface. Claims about what
CommonSwarm does must hold for BOTH the hosted workspace and the optional local listener.

## Writing: modifiers and invented contrasts

Use the shortest precise statement. Remove modifiers such as *actual, real, true, clear, honest, genuine,
main, key,* or *important* when they add no fact. Do not invent an opposing view for an “X, not Y” contrast,
and never imply that someone argued a view they did not introduce.

## Workspace brain and releases

The CommonSwarm workspace brain (`cswarm brain ls | get <topic>`) holds live doctrine that moves faster than
this file: `brain-how-to` (its constitution), `false-success-signals`, `shared-host`, `listener-attended`,
`agent-restart`, `releases`. Read the relevant topic before a big task; write durable findings with
`cswarm brain put`. Cite topics by NAME only, never by section number or item count.

Releasing: the ritual lives in the brain topic `releases` and the newest `docs/org/*-RESUME-HERE.md`. The
CLI version on `/download` is derived from the root `package.json` through `site/src/lib/release.ts`; bump
with `npm version --no-git-tag-version <v>` so the lockfile stays in sync (`npm --prefix site test` rejects
drift). Every SHA-changing lane needs both D-036 arms before it lands.

## ⚠️ `cloud-swarm-dev` IS PRODUCTION

The Supabase project `cloud-swarm-dev` (ref `ukezjcnxjvkpkeezxaew`) is the CommonSwarm production project;
there is no separate CommonSwarm production project. The live site publishes
`https://api.commonswarm.com` in its `commonswarm:url` meta tag. That active custom domain and
`https://ukezjcnxjvkpkeezxaew.supabase.co` serve the same project.

Resolve the ref against the live page before `supabase db push`, `functions deploy`, or any destructive
operation. Local work uses `npm run db:start` at `127.0.0.1:54321` and must never touch this project.

## Deploying the marketing site

Live: https://commonswarm.com. Vercel project: `coswarm-site`; scope: `ridgedotio`; public project alias:
`coswarm-site.vercel.app`. The old project name is intentional.

Before building, `site/.env` must contain `PUBLIC_SUPABASE_URL=https://api.commonswarm.com` and the anon
key from `supabase projects api-keys`. A build without them succeeds but publishes empty target metadata;
`/app` and GitHub sign-in fail, and `/start` hands off to that broken app. Never put a service-role key under `site/`.

```sh
cd site && rm -rf dist && npm run build
cp -r .vercel dist/.vercel
vercel deploy dist --prod --yes --scope ridgedotio
```

1. **Clean `dist/`.** Astro does not remove stale output; `rm -rf dist` before the build is load-bearing.
2. **Remove HTML comments.** Astro publishes template `<!-- comments -->`; frontmatter comments are stripped.
3. **Use the public alias.** Per-deploy URLs can return 302 to Vercel SSO; check before sharing one.
4. **Verify production.** Fetch the deployed page with a positive control; source and build logs are insufficient.
5. **Preserve the project link.** `--name` is deprecated; copy `.vercel` into rebuilt `dist/` or deployment can silently target a new `dist` project.

```sh
U=https://commonswarm.com
curl -s -o /dev/null -w '%{http_code}\n' "$U"                         # 200, not 302
curl -s "$U" | grep -c '<some string that MUST be there>'            # positive control
curl -s "$U" | grep -c '<the thing that must be GONE>'               # 0
curl -s -o /dev/null -w '%{http_code}\n' "$U/install.sh"             # 200
curl -s -o /dev/null -w '%{http_code}\n' "$U/nope.sh"                # 404 control
curl -s "$U/start" | grep -o 'commonswarm:url" content="[^"]*"'     # non-empty
curl -s "$U/start" | grep -c 'InNlcnZpY2Vfcm9sZSI'                   # 0: no service_role JWT
```

## zsh: brace every revision-with-path

Always write `${rev}:path`, never `$rev:path`; zsh can mangle the latter before Git sees it, sometimes
without an error. The exact double-quoted construct `"$R:Xzzz"` was measured one letter at a time:

```
MANGLED:  a c e h l q r s t u   and   A P Q
SAFE:     everything else
```

Brace every revision-with-path even when the path begins with a measured safe letter.
