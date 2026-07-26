# AGENTS.md — cloud-swarm

Coordination service for teams where people and AI agents work side by side. A CLI
(`coswarm`) plus a hosted Supabase backend; **there is no web UI**. Agents post short,
immutable *signals* of intent ("I'm about to refactor auth") so collaborators don't step
on each other. Posting a signal never claims, blocks, or closes a task.

Status: **P3-1, invited dogfood** — pre-launch, invite-only, not self-serve. Node >= 24.

## Commands

All verified working from a clean `npm install` on this repo.

| Command | What it does |
|---|---|
| `npm install` | Deps. No postinstall surprises. |
| `npm run build` | `tsc` → `dist/`. Wipes `dist/` first, `chmod 755 dist/cli.js` after. |
| `npm test` | 66 tests — protocol reducer only. **Read the trap below.** |
| `npm run test:p1-cli` | 77 tests. 74 are pure; `local-integration.test.ts` (3) needs local Supabase. |
| `npm run test:p1-server` | 17 tests. **Requires local Supabase running** (Docker). ~30s. |
| `npm run test:uxtest` | 6 tests, the cross-machine UX harness. |
| `npm run db:start` / `db:stop` / `db:reset` / `db:status` | Local Supabase lifecycle. |
| `npm run build:command-core` | Regenerates the edge-function protocol bundle. |

Anything touching the database needs local Supabase up (`npm run db:start`, needs Docker).

There is **no lint or format step** — no ESLint, Prettier, Biome, or `.editorconfig` in
this repo. Don't invent one or add a `lint` script without being asked.

The marketing site is a separate npm project: `cd site && npm install && npm run build`
(Astro 7, static output).

## Layout

```
src/protocol/   pure authority core — reducer, events, commands. No I/O.
src/cloud/      client side: auth, signals, workspaces, transport.
src/cli.ts      the coswarm CLI surface.
supabase/       migrations + Deno edge functions (command, read).
tests/          protocol tests; tests/p1-cli/ and tests/p1-server/ are separate suites.
scripts/        verification helpers (see below).
site/           Astro marketing site — hand-written CSS, no Tailwind.
docs/design/    SWARM-CLOUD.md is the canonical spec; on conflict it wins.
docs/evidence/  durable artifacts backing completion claims. Committed on purpose.
```

## Traps

These have each cost someone real time. They are not theoretical.

**`npm test` names its test files explicitly.** The script is
`node --test tests/protocol-next.test.ts tests/protocol-workspace.test.ts` — a literal
list, not a glob. A new file in `tests/` is silently *not run*. Verified: adding a test
file leaves the count at 66; the same file runs when named. If you add a root-level test,
add it to the `test` script. (`test:p1-cli` and `test:p1-server` do glob their
directories, so files added there are picked up.)

**Edge functions are outside every typechecker here.** `tsconfig.json` sets
`include: ["src/**/*.ts"]`, so nothing under `supabase/functions/` is checked by `tsc`.
They are Deno, and Deno is not necessarily installed. `npm run build` passing tells you
**nothing** about whether an edge function compiles.

**`supabase/functions/_shared/protocol.js` is generated — do not hand-edit.** It is built
from `src/protocol/index.ts` by `build:command-core`, which runs automatically as
`pretest:p1-server`. Edit the TypeScript source; the file carries a `GENERATED` banner.

**The working tree may be on another agent's branch.** This repo is worked by several
agents at once and the shared checkout is often *not* on `main`. Run `git rev-parse
--abbrev-ref HEAD` before you commit, and check `git worktree list`. One writer per
branch and per worktree — never push to a branch you don't own; fork instead. Branches
that exist locally may hold the only copy of something: `scripts/branch-audit.sh` tells
you which are debris and which are unique before anyone prunes.

**`scratchpad/` is gitignored.** Evidence cited from a document must live somewhere
durable — that is what `docs/evidence/` is for. A completion claim whose evidence cannot
be re-read later is not evidence.

## Verification

The distilled operative rules. Full doctrine, with the incidents that produced it, is in
`docs/org/2026-07-26-simplification-state.md` — read it before any nontrivial change.

- **Measure the artifact, not its name.** Resolve the path, URL, ref, or symlink before
  trusting a result. A green check against the wrong target is not a green check.
- **Run a positive control on the same invocation.** A probe that cannot fail is
  indistinguishable from one that passed. If both arms of a check produce identical
  output, the instrument is broken — that is not a result. `scripts/probe-check.sh` and
  `scripts/path-check.sh` enforce this; use them rather than re-deriving it.
- **Enumerate, don't pattern-match.** List the actual set and count it. Grepping for a
  string you expect returns a confident zero when you guessed the wrong path.
- **Pushed ≠ landed ≠ applied.** Say which one you mean. A commit on a branch is not on
  `main`, and a migration written is not a migration applied.
- **Review the decision set, not the items.** Individually-correct rulings have been
  unsafe in combination.
- **Corrections go in the artifact, not in a message.** A correction in chat never reaches
  whoever pulls the repo tomorrow. Keep the superseded line, marked dead.

State what you did **not** establish alongside what you did.

## Code style

Observed in the codebase, not aspirational:

- 2-space indent, semicolons, no tabs anywhere.
- **Quote style is mixed and file-local**: `src/protocol/**` uses single quotes,
  `src/cli.ts` and `src/cloud/**` use double. Match the file you are editing; don't
  normalize a file you're only passing through.
- ESM with `Node16` resolution — relative imports **must** carry the `.js` extension
  (`from './events.js'`), even though the source is `.ts`.
- `strict: true`. Edge functions additionally use `noUncheckedIndexedAccess`.
- Exported functions and classes get a `/** ... */` one-liner saying *why*, not what.
- Comments cite spec sections (`§2.2`) where behaviour is spec-mandated. Keep those
  references accurate if you move the behaviour.
- Errors are named classes with a `name` field, thrown rather than returned; the reducer
  halts on unknown input rather than skipping it.

## Writing for users

The product voice is plain and calm. CLI output tells the user what just happened, what
is now true, and what happens next, so they never have to check whether it worked. The
benefit being sold is **agents coordinating so collaborators are unblocked** — not
control, authority, or enforcement. An earlier "authority / on the record" framing was
explicitly retired for reading as friction; see `docs/marketing/SITE-BRIEF.md`.

Reduce safeguards where they only add ceremony; assume agents are intelligent. Simpler is
better. But the safeguards named in the doctrine file as must-survive are load-bearing —
check that list before removing a check.
