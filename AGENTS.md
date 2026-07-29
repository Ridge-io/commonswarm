# AGENTS.md — cloud-swarm

**CommonSwarm** — coordination service for teams where people and AI agents work side by
side. A CLI (`cswarm`), a hosted Supabase backend, and a web front door at
https://commonswarm.com — four Astro routes including self-serve signup (`/start`) and a
dashboard (`/app`), with a workspace-first redesign chartered in
`docs/design/2026-07-29-WORKSPACE-FIRST-DASHBOARD.md`. The superseded phrase — *"there is
no web UI"* — is **dead** (2026-07-29): it predates the deployed routes. Agents post
short, immutable *signals* of intent ("I'm about to refactor auth") so collaborators don't
step on each other. Posting a signal never claims, blocks, or closes a task.

Status: **P3-1, open free tier** — self-serve signup is LIVE. Node >= 24.

★ **`SWARM_SELF_SERVE=1` has been set on the production project since 2026-07-28.** A stranger can
create their own workspace at https://commonswarm.com/start with no invitation. The superseded line
— *"invited dogfood — pre-launch, invite-only, not self-serve"* — is **dead**, and it did real
damage before it was caught: a cross-family consumer reviewer read the matching claim on the live
home page, concluded signup was unavailable, and prescribed rebuilding the site around a waiting
list. See D-023. **Availability copy asserts deployment state and lives in git, so nothing fails
when the deployment moves — grep every surface when a gate flips.**

**The product was renamed from `coswarm` to CommonSwarm / `cswarm` (2026-07-27)** because
the old name collided with a competitor. Prose says CommonSwarm; anything a user types says
`cswarm`. Four things still legitimately read `coswarm` and must not be "fixed":

- ~~the release repo default `Ridge-io/coswarm-dist` in `install.sh`~~ — **dead**
  (2026-07-29): the decision landed; `install.sh:16` now defaults to `Ridge-io/cloud-swarm`
  (public), and the published installer at commonswarm.com/install.sh installs cswarm 0.1.1;
- the Vercel project and live URL `coswarm-site` / `coswarm-site.vercel.app` — still the
  deployed site, see the deploy section below;
- the esbuild define `__COSWARM_VERSION__` — a build-time identifier shared between
  `scripts/build-release.sh` and `src/cli.ts`; both sides must change together;
- the git repo `cloud-swarm` and the GitHub org `Ridge-io` — operator actions.

Also unaffected, and different things entirely: the PostgreSQL schema `swarm.`, every
`SWARM_*` env var, and the separate local `swarm` CLI the agent fleet runs.

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
| `npm run check:edge` | `deno check` over both edge functions. Needs `brew install deno`. |

Anything touching the database needs local Supabase up (`npm run db:start`, needs Docker).

There is **no lint or format step** — no ESLint, Prettier, Biome, or `.editorconfig` in
this repo. Don't invent one or add a `lint` script without being asked.

The marketing site is a separate npm project: `cd site && npm install && npm run build`
(Astro 7, static output).

## Layout

```
src/protocol/   pure authority core — reducer, events, commands. No I/O.
src/cloud/      client side: auth, signals, workspaces, transport.
src/cli.ts      the cswarm CLI surface.
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

**Edge functions are outside `tsc`.** `tsconfig.json` sets `include: ["src/**/*.ts"]`, so
nothing under `supabase/functions/` is checked by it. `npm run build` passing tells you
**nothing** about whether an edge function compiles.

★ **They are no longer unchecked, though — use `npm run check:edge`** (added 2026-07-27).
It runs `deno check` over both functions and needs Deno (`brew install deno`). Measured on
the tree at `ab9babb`: both functions pass, and a deliberately broken copy exits 1 with
TS2322, so the check discriminates. The superseded line — *"Deno is not necessarily
installed, so edge functions cannot be checked here"* — is **dead**: install it and check.
Two caveats that still stand: the checker is not run by any other script, and
`_shared/protocol.js` is generated, so a stale bundle typechecks fine while being wrong.

**`supabase functions serve` does NOT inherit the parent environment.** The runtime gets
only what `--env-file` holds. `tests/p1-server` passed `--env-file /dev/null` for a long
time, which means the function ran with an **empty** environment and every env-gated branch
was silently untestable — the `SWARM_ENV=test` in the spawn's `env:` never reached
`Deno.env.get`. It only went unnoticed because the guard it protects also depends on env
vars that never arrived. The suite now writes a real temp env file. If you add an env-gated
branch, add it there or your test asserts against the default, not your feature.

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

## Deploying the marketing site

Live: **https://commonswarm.com** (Vercel project `coswarm-site`, scope `ridgedotio`;
`coswarm-site.vercel.app` is the project alias and also serves). The project keeps its old
name — renaming it is an operator action and would move the alias URL.

**`commonswarm.com` is LIVE** (2026-07-29): DNS is on Cloudflare, apex + www answer 200,
the cert is valid to 26 Oct 2026, and `legal@`/`security@commonswarm.com` deliver
(verified end to end — D-007/D-008). It is the public URL; write copy against it.
`coswarm-site.vercel.app` remains the Vercel project alias underneath and still serves.
Two superseded lines, both **dead**: *"the name `coswarm` is decided, the domain is not"*
(the name is CommonSwarm and the domain is decided), and *"DNS is parked and points at
nothing — `coswarm-site.vercel.app` is still the only public URL"* (the repoint happened
2026-07-28/29; the sweep found this very line still instructing agents to write the old
state, which is how D-023 propagated).

```sh
cd site && rm -rf dist && npm run build          # rm -rf is load-bearing, see below
cp -r .vercel dist/.vercel                       # load-bearing, see trap 5
vercel deploy dist --prod --yes --scope ridgedotio
```

**`site/.env` is required and is NOT in the repo.** It is gitignored on purpose — Base.astro
states the standing rule that no key is committed, because a committed key outlives the
project and gets rotated by hand. Without it the build SUCCEEDS and silently produces a site
whose `/start` and `/app` have no backend and whose GitHub sign-in does nothing. That shipped.

```
PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
PUBLIC_SUPABASE_ANON_KEY=<the anon key, from `supabase projects api-keys`>
```

The anon key is a public identifier protected by RLS, not a secret. **A service-role key must
never appear in any file under `site/`** — `supabase projects api-keys` prints it two rows
below the one you want.

The site build also copies the repo-root `install.sh` into `public/` (`npm run
sync:installer`, wired into `build`). The repo-root file is the single source of truth; the
copy is gitignored so the two cannot drift.

`--scope ridgedotio` is required; without it the CLI stops and asks. `vercel link
--project coswarm-site --scope ridgedotio --yes` is needed before any `vercel project`
subcommand.

**Five traps, each of which cost a deploy. Trap 5 is the newest and the nastiest:**

5. **`--name` IS DEPRECATED, AND DROPPING IT SILENTLY DEPLOYS TO A NEW PROJECT.** The
   command here used to end `--name coswarm-site`. Newer Vercel CLIs ignore that flag with a
   deprecation warning, and then infer the project **from the deployed directory's name** —
   so `vercel deploy dist` created and deployed to a brand-new project called **`dist`**,
   reported "Production" and "Aliased" in green, and exited 0. `commonswarm.com` kept
   serving the OLD build. Nothing failed; the deploy simply went somewhere else.
   The fix is the `cp -r .vercel dist/.vercel` above: `site/.vercel` is linked to
   `coswarm-site`, but `rm -rf dist` destroys the copy inside `dist/` on every build, so it
   has to be restored before every deploy. **This is exactly why the "verify the DEPLOYED
   page" rule below exists** — a green deploy log proved nothing, and only fetching
   commonswarm.com and grepping for a string from the new build caught it.

1. **`rm -rf dist` before building.** Astro does not clean `dist/`, so stale files survive and
   get deployed. A grep of `dist/` can report content that is no longer in `src/`.
2. **Astro ships HTML comments verbatim.** `<!-- ... -->` in a template is published to the
   browser; only frontmatter `/* ... */` is stripped. A retired headline sitting in an HTML
   comment went live on a public page.
3. **New deployment URLs are SSO-protected.** `coswarm-site-<hash>-ridgedotio.vercel.app`
   returns **302** to `vercel.com/sso-api` for anyone not logged in. The **project alias**
   `coswarm-site.vercel.app` is the public one. Never hand out a per-deployment URL as if it
   were public — check for a 302 first.
4. **Verify the DEPLOYED page, not the source you edited.** Fetch the live URL and grep it,
   with a positive control proving the grep matches. Two false claims survived a source-level
   fix and were only caught by curling production.

```sh
U=https://commonswarm.com
curl -s -o /dev/null -w '%{http_code}\n' "$U"        # 200, not 302
curl -s "$U" | grep -c '<some string that MUST be there>'   # positive control
curl -s "$U" | grep -c '<the thing that must be GONE>'      # must be 0

# The two checks that would have caught what actually shipped broken:
curl -s -o /dev/null -w '%{http_code}\n' "$U/install.sh"           # 200 -- the installer
curl -s -o /dev/null -w '%{http_code}\n' "$U/nope.sh"              # 404 -- control for it
curl -s "$U/start" | grep -o 'commonswarm:url" content="[^"]*"'    # MUST be non-empty
curl -s "$U/start" | grep -c 'InNlcnZpY2Vfcm9sZSI'                 # 0 -- no service_role JWT
```

Both failures were invisible in the source and in the build log. The install command read
`curl -fsSL https://<host>/install.sh | sh` on the live front page, and the backend meta tags
rendered as `content=""`. Grep the DEPLOYED page, and pair every "must be absent" grep with a
"must be present" one on the same invocation.

There is no CI. Deploys are manual and are the Lead's call; nothing deploys on push.

### zsh mangles `$rev:src/...` — brace it

This cost three agents six failed probes in one session, each blaming "zsh being zsh":

```sh
git rev-parse "$r:src/cli.ts"      # zsh: bad substitution   <- DIES
git rev-parse "${r}:src/cli.ts"    # works                   <- the fix
```

zsh parses `$r:s` as parameter `$r` with a **`:s` substitution modifier**. Any git revision
written as `$var:path` where the path begins with `s` (`src/`, `site/`, `supabase/`) is
mangled before git sees it. `tests/` and `docs/` are fine — it is specifically `s`.

**The trigger is a literal `s` in the source text after the colon, not the expanded value:**

```sh
p=src/cli.ts; git rev-parse "$r:$p"   # WORKS — identical value, parses fine
```

`$r:$p` is immune because the character after `:` is `$`. That is why this bug hides: **the
loops and helper functions we write to be careful are exactly the form that cannot reproduce
it.** It only bites in the quick literal one-liner you type while checking something else —
and a passing test written as a loop does **not** clear a literal call site.

**It has TWO faces and the second is far worse — measured, not theorised:**

```
$r:src/...      -> "bad substitution", and it ABORTS THE WHOLE SCRIPT.
                   Nothing after it runs. A later line reporting
                   "command not found: head" is this, not a PATH problem.

$r:site/...     -> SUCCEEDS. SILENTLY. AND RETURNS THE WRONG OBJECT.
                   unbraced  $r:site/src/pages/index.astro -> 362cb4307d48...
                   braced  ${r}:site/src/pages/index.astro -> 4dded0a0f977...
                   Two different blobs. No error. No warning.
```

zsh's `:s` takes the next character as its delimiter, so `site/` parses as a *valid*
substitution with `i` as the delimiter — it mangles the path and git resolves whatever it is
handed. You get a real 40-character SHA for an object you did not ask about.

**Retroactive consequence:** any past "not found", or any blob comparison, produced by an
unbraced literal is **suspect, not evidence**. One wrong claim in this repo has already been
traced to it — a seat was told their finding was overstated on the strength of a path that
had silently resolved elsewhere.

**Why it matters beyond ergonomics:** the failure prints to stderr and the command produces no
stdout, so a probe wrapped in `$(...)` yields an empty string that reads as *"absent"*. It is a
dead command wearing the costume of a measurement — one more way to manufacture a zero. If a
path-existence check comes back negative, confirm the command actually ran.
