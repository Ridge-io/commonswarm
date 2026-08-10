# Resume here — 2026-08-09

**Verify every SHA by hash.** Braced revisions only: `"${R}:src/..."`, never `"$R:src/..."`.

This file supersedes `2026-08-07-RESUME-HERE.md`. That file is **stale in a way that cost real
work** — see "What I got wrong" below.

## Refs

```
main    4f3dfd5   — LANDED. GitHub and local agree, verified by `git ls-remote` with
                    both controls (an absent ref returns 0 rows, `main` returns 1).
                    Everything below through the D-080 section is at or before this.
```

The three lines this block held before are kept in git history rather than here; each was
accurate when written and stale within the hour. Two of them were superseded by my own commits
while I was writing the file.

Run `git rev-parse --short main` and `git ls-remote https://github.com/Ridge-io/cloud-swarm
refs/heads/main` before trusting either line. This block was already wrong once within an hour of
being written — it said "AHEAD by 6 commits, PUSH BEFORE ANYTHING ELSE" after the push had
happened. **A resume file is a snapshot, and its Refs block is the part that rots first.**

## LIVE IN PRODUCTION

| | |
|---|---|
| CLI | **v0.1.11** — `curl -fsSL https://commonswarm.com/install.sh \| sh`, sha256 `8480682a…396860` |
| Verified by | the Lead, Wren (second machine), and Verity — three independent installs, same hash |
| Supabase pooler | `pool_size = 38` on `ukezjcnxjvkpkeezxaew` |
| Edge functions | `read` **v6**, `command` **v17** (2026-08-09), `capability` v2 |

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

**v0.1.10 SHIPPED 2026-08-09**, sha256 `ee34b686…cc1c73`, verified by running the live installer:
D-070 (empty roster no longer claims emptiness), D-072 (`member remove` names both requirements),
D-073 (server errors printed once), D-074 (transitional states say how to confirm), D-075 (cap
3 → 10). **Nothing is now landed-but-unreleased.**

**One server deploy happened**: `command` v16 → v17 for the cap. `read` untouched at v6, so the
D-047 freeze holds.

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

0. ~~`git push origin main`~~ — **done**, `2d62161`, verified against `git ls-remote`.
1. **TWO OPERATOR DECISIONS BLOCK EVERYTHING ELSE.** The fleet is stood down because of them:
   - **Free a workspace slot, or authorise archiving (D-075).** The Lead and Wren each hold three
     owned workspaces. Neither can create a fourth. The remaining release-verification test —
     `invite` → `accept` on 0.1.9 rather than 0.1.8 — is **unreachable by either party**.
   - **`cswarm login --no-browser`.** It prints an OAuth URL for a human to open by hand. This is
     the only route to the `member remove` **success** path; Wren's browser automation is down and
     it will not re-authenticate blind. See D-072.
2. ~~Release 0.1.10.~~ **DONE** — shipped 2026-08-09, `ee34b686…cc1c73`. The procedure that
   works: bump with `npm version --no-git-tag-version`, rebuild the site (the download gate
   catches a stale artifact), **`cp -r .vercel dist/.vercel` before deploying**,
   `scripts/build-release.sh`, `gh release create`, then verify by downloading from
   `releases/latest/download` **and running the real installer**.
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
- **D-076** the intermittent read 503 is a **`postgres@3.4.9` null-socket crash** in the read
  isolate, root-caused by Plumb via a `request_id` join: 8 crashes in a day, 8/8 joining a
  `POST 503 /read`. Upstream PR #1168 is **open and unmerged**, so there is no version to upgrade
  to. **Mitigated in 0.1.11** by a bounded one-shot read retry — the crash is transient because a
  retry reaches a fresh isolate. The driver bug itself is untouched and needs `read`, which is
  frozen.
- **D-048** an `ANTHROPIC_API_KEY` user gets an auth-less Claude child. **Re-measured 2026-08-09
  and the mechanism still holds** — key stripped, `HOME` and `PATH` survive. Needs a design
  decision rather than a fix: `DENY_NAME_RE` is deliberate and stops credentials leaking into
  spawned hosts. What the child actually *does* is still unmeasured and needs the adapter
  installed, so it is blocked behind action 3.

**Four entries were found stale on 2026-08-09** — D-050, D-062, D-063 and D-038 were all fixed
while marked OPEN. See the hygiene note at the end of `DEFECT-REGISTER.md`. **Check an entry's
heading against its body, and re-measure, before dispatching anyone against it.**

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

## D-080 FIXED — and the review round is the part worth reading

`1ed9ca7` (mechanism) and `dd41de1` (the two holes both review arms found). Client-side only;
nothing deployed. Gates: build, `check:tests`, `npm test` 499/499, `test:p1-cli` 203/203.

**The mechanism.** `waitForListenerReady` falls back to the status FILE when the live control
query fails — which is the NORMAL state in the first moments of a start, because the socket is not
up yet. The listener directory is keyed by CONFIG HASH, so an identical retry reads **the previous
run's** terminal status and reports it as its own. The live branch already rejected a mismatched
pid; the fallback checked nothing. This also explains the backwards diagnostics Wren recorded,
without needing a second cause.

**The first fix was insufficient and I published it before review.** Two arms (Gemini inversion,
Codex exact) independently found the same two holes: pids are recycled so a pid match alone is not
identity, and `expectedPid === undefined ||` preserved the unsafe behaviour for any caller that
could not supply one. Both closed in `dd41de1` — a `startedAtFloorMs` captured **before** the
spawn, and both identifiers now required to MATCH rather than merely be absent.

**A CLI string I wrote asserted something the code does not guarantee, and my own test defended
it.** The timeout message said the listener *"was not stopped"*. The wait loop performs no final
liveness check, so the child can exit between the last poll and the throw. I had written a control
**requiring** that string. This is the `/every session/` shape from AGENTS.md, and it was caught by
a non-author, not by me. Now: *"cswarm did not stop it"* — our action, which is guaranteed, rather
than the process's state, which is not. **The test NAME carried the refuted claim too**; a sweep
over the claim family rather than over the diff is what found it.

**The first mutation round failed to justify one of three mechanisms, and that is a result, not a
hiccup.** Deleting the pid match left every test green, because each case was also caught by the
timestamp floor. An ungated check is one a later reader deletes after running exactly that
mutation. The missing case was a CONCURRENT second instance — a status written after the floor
under a different pid, which the floor admits and only the pid rejects. All three discriminate now.

## A TRAP THAT FIRED AGAIN, on the documented remedy itself

AGENTS.md says of macOS's missing `timeout`: *"(Use `gtimeout`, or no timeout.)"* **`gtimeout` is
not installed on `yulanbots-mac-mini`.** `gtimeout 60 git ls-remote …` exits 127 with no stdout, so
the `ls-remote` control returned **0 rows** and read as *"the branch is absent from GitHub"* — the
branch was present. The remedy reproduced the trap it fixes. AGENTS.md is corrected. The control
is what caught it, for the second time in this file.

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
- **Whether D-080 was the only cause of the report Wren filed.** D-081 records the opencode canary
  as genuinely intermittent, so a start CAN fail for real. This fix stops a previous failure being
  reported as the current one; it does not make the canary reliable, and the two must not be
  conflated by anyone reading the fix as "listener start is fixed".
- **The six-second `listen status` window is untouched.** A status poll can still return a
  transient as though it were an outcome — the second observer error in D-080, and a property of
  the product rather than of the observer.
- **D-080's fix has never been exercised against a real start.** Every gate on it is a pure unit
  test with a synthetic status file. The measured scenario needs two consecutive starts in one
  config-hash directory where the first fails.
