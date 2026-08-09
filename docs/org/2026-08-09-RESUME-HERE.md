# Resume here — 2026-08-09

**Verify every SHA by hash.** Braced revisions only: `"${R}:src/..."`, never `"$R:src/..."`.

This file supersedes `2026-08-07-RESUME-HERE.md`. That file is **stale in a way that cost real
work** — see "What I got wrong" below.

## Refs

```
main    a1be4e3   (run `git rev-parse --short main`; this file is written at a point in time)
GitHub  2540bae   — main is AHEAD by 6 commits. PUSH BEFORE ANYTHING ELSE.
```

## LIVE IN PRODUCTION

| | |
|---|---|
| CLI | **v0.1.9** — `curl -fsSL https://commonswarm.com/install.sh \| sh`, sha256 `fa0ca332…6555a` |
| Verified by | the Lead, Wren (second machine), and Verity — three independent installs, same hash |
| Supabase pooler | `pool_size = 38` on `ukezjcnxjvkpkeezxaew` |
| Edge functions | `read` **v6**, `command` v16, `capability` v2 — **unchanged this session** |

**Nothing server-side was deployed.** Every fix below is client-side or copy. That was deliberate:
`read` is under the D-047 freeze, and `command` is the write path for every verb.

## What v0.1.9 shipped, and where it came from

Seven user-facing changes, all found by running the fleet's own coordination through CommonSwarm
across two people and two machines:

| | |
|---|---|
| `cswarm members` | the roster, readable by an **agent** (D-062) |
| directed sends | name the recipient they resolved to (D-062) |
| `--json` | accepted on `token mint`, `principal create`, `invite` (D-064) |
| `cswarm invite revoke` | invitations were unrevocable (D-069) |
| `accept` | names the workspace you were moved off (D-068) |
| setup copy | no longer assumes someone invited you (D-067) |
| installer | hides the invite link as you paste it (D-066) |

**Landed after 0.1.9 and NOT released** — `a1be4e3` and back: D-070 (empty roster no longer claims
emptiness), D-072 (`member remove` no longer promises a retry that cannot work), D-073 (server
errors printed twice), D-074 (transitional states say how to confirm). **A 0.1.10 is owed.**

## MEASURED, NOT INFERRED

- **Cross-user, cross-machine round trip** — `docs/evidence/2026-08-08-cross-user-round-trip/`.
  Four controls on one invocation. This was the claim the whole 2026-08-07 positioning rested on.
- **The full supported chain**: `invite` → link → `accept --link-stdin` → **principal
  auto-created** → `mint` → directed ask across users and machines. That was the last OPEN
  launch-bar item.
- **Auto-created principal names are `<unix-user>@<hostname>-<device-prefix>`** — collision-
  resistant by construction, confirmed on **two different hosts**. So D-062's collision class is
  **not reachable via `accept`**; it lives only in `principal create --name`.
- **The agent path writes ZERO FILES** into a pristine `HOME`, and still did on the shipped
  artifact after release. Gated in `tests/p1-cli/agent-path-stateless.test.ts`.
- **Renewal fires from a one-shot signal verb** (Plumb, on the published binary). The root token
  must be *used* once first, so renewal takes two invocations, not one.

## GATES

```
build         0 errors        npm test        499/499
check:tests   0 errors        test:p1-cli     188/188        site            146/146
```

## NEXT ACTIONS, in order

0. **`git push origin main`.** Six commits are local-only, including the whole D-070…D-075 set.
1. **TWO OPERATOR DECISIONS BLOCK EVERYTHING ELSE.** The fleet is stood down because of them:
   - **Free a workspace slot, or authorise archiving (D-075).** The Lead and Wren each hold three
     owned workspaces. Neither can create a fourth. The remaining release-verification test —
     `invite` → `accept` on 0.1.9 rather than 0.1.8 — is **unreachable by either party**.
   - **`cswarm login --no-browser`.** It prints an OAuth URL for a human to open by hand. This is
     the only route to the `member remove` **success** path; Wren's browser automation is down and
     it will not re-authenticate blind. See D-072.
2. **Release 0.1.10.** Four fixes are landed and invisible to users. The procedure that worked is
   in this file's commit history: bump with `npm version --no-git-tag-version`, rebuild the site
   (the download gate catches a stale artifact), `scripts/build-release.sh`, `gh release create`,
   then **verify by downloading from `releases/latest/download` and running the real installer**.
3. **The `claude` and `codex` adapters have NEVER RUN — anywhere.** `listen start --provider
   claude` refuses cleanly with the exact package and version, and spawns nothing. Exercising
   either needs a global `npm install -g` on a collaborator's machine. Largest untested surface.
4. **`cswarm login` first-time GitHub sign-in is UNVERIFIED**, in every round. Everyone was
   already signed in and `accept` short-circuits to *"Already signed in"*. Needs a working browser.

## STILL OPEN, and why each is not just "not done yet"

- **D-075** archiving is designed, honoured by the cap, and unreachable. `archived_at` has **0**
  writes against a control of 3 for `revoked_at`. Needs a `command` edge change.
- **D-065** `invite` needs an email the product never shows you. The protocol already allows
  `email: null`; the **wire contract** does not. Needs a `command` edge change.
- **D-071** the roster is unbounded and unpaginated while `inbox`/`feed` cap at 1..100. Needs a
  `read` edge change — **under the D-047 freeze**.
- **D-061** a directed signal is still invisible to its author. `cswarm members` and the recipient
  echo reduce the pain; there is still no sent view.

## WHAT I GOT WRONG, so it is not repeated

- **D-050 was fixed and both the register and the resume file said it was open.** I read both and
  sent Wren to hunt it on a second machine. Wren walked an `opencode` teardown — **a different
  code path from the one the entry describes** — and reported a non-reproduction against a
  claude-adapter defect. Now marked FIXED with a mutation as evidence. **I then found the same
  contradiction on D-062 and D-063** — `OPEN` headings over bodies recording the fixes — and
  corrected those too. **Check the heading against the body before acting on a register entry.**
- **I published a live-capability exposure that did not exist.** Wren and I both said its invite
  link was live and unrevoked. It had been dead since I accepted it. I got `role_forbidden`, which
  fires before liveness is evaluated; Wren had no verb. **Each of us inferred exposure from our
  own inability to act** — and I had already measured `invitation_not_live` on the symmetric case
  hours earlier.
- **I nearly reported a working release tool and a working artifact as broken, within one hour**,
  both by running the bundle inside the repo where `package.json` sets `"type": "module"`.
- **I ran the dogfood while not reading cswarm — twice.** Verity's answers were sitting in cswarm
  notes and I re-assigned work it had already done.

## THE RULES THIS SESSION ADDED TO AGENTS.md

- **A negative result is evidence only if the path it was meant to exercise was reached** (Wren).
  Six measured instances tabulated.
- **Honesty is not sufficient: a true word in a success-shaped response gets skipped** (Joist,
  then Wren committing it against its own endorsement). `exit 0` plus a success shape overrides
  the content. The fix is structural — say what to do next.

## NOT ESTABLISHED

- Whether an archived workspace stays readable to its members (`read` filters `archived_at IS
  NULL` in at least three places).
- Whether any token other than the Lead's was ever minted for the stale `Wren` principal
  `23733ab6`. The argument rests on owner-only minting, not on a measured count.
- Whether `invitation_not_live` should distinguish accepted / revoked / expired. Only *accepted*
  means a stranger may now be a member.
- The cause of the intermittent `member read` failure (~1 in 12). **Not the pooler** — neither
  deployed nor current `read` emits 503 on any path. Gateway/runtime is the leading class and
  needs a log join for `2026-08-08T13:16:45Z`–`13:17:02Z`.
- Whether any of this friction causes abandonment. Every finding here came from people who wrote
  the product and wanted it to work.
