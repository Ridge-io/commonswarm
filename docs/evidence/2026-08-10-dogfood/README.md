# Dogfood run — 2026-08-10, from the beginning

**Method.** Installed from the LIVE installer into an isolated prefix, and ran as a genuinely
cold user via `HOME` override. Everything below is against production
(`ukezjcnxjvkpkeezxaew`), CLI **0.1.11** (sha256 `8480682a…`), which is what a stranger gets
today. **The D-080 fix is NOT in this build** — it is on `main`, unreleased.

## Instrument check, before any finding

`CSWARM_STATE_DIR` **does not exist.** The credential path is hardcoded at
`src/cloud/storage.ts:92` to `~/.cswarm/credentials.d`. My first isolation attempt set that
variable and would have dogfooded **as the Lead** while reporting a stranger's experience.

Real isolation is a `HOME` override, and it was verified with a control on the same invocation:

```
$ cswarm target show                      # the real user
Current Cloud target: https://ukezjcnxjvkpkeezxaew.supabase.co
Anon key fingerprint: 31639e49bcc6

$ HOME=<isolated> cswarm target show      # the stranger
No current Cloud target is saved. …
```

Two different answers, so the isolation is real. Had both printed the target, the run would have
measured nothing.

---

## F-1 — the installer's own terminal path dead-ends for the user it was written for

**Severity: MAJOR.** It is the first thing a stranger runs, and it is the self-serve path.

The installer's closing output:

```
No invite? Make your own workspace. It is free and takes no card:

  https://commonswarm.com/app

Or stay in the terminal:

  cswarm login
  cswarm new "<project name>"
```

Both terminal commands fail for exactly that reader:

```
$ HOME=<isolated> cswarm login --no-browser
cswarm: no Cloud target is selected: start with cswarm accept --link-stdin because invite links
carry the Cloud target …, or run cswarm target set --url https://<ref>.supabase.co --anon-key
<key> using values from whoever runs this deployment, or from your own project's API settings if
you created it; …

$ HOME=<isolated> cswarm new "My Project"
cswarm: no Cloud target is selected: …same…
```

Control: `cswarm --help` exits 0 in the same isolated HOME, so the binary is fine and these are
not a broken install.

**The remedy text offers three routes and none of them is open to this reader** — the same shape
as D-067, whose fix is quoted in the code comment directly above this very message:

| route offered | why it fails for a cold self-serve user |
|---|---|
| `cswarm accept --link-stdin` | they have no invite link; that is what "No invite?" meant |
| "values from whoever runs this deployment" | for a self-serve signup that person **is them** |
| "from your own project's API settings if you created it" | they did not create a Supabase project |

**`install.sh` already knows this, in writing.** Lines 146–148:

> *"WITH a link: `accept` is the only first-contact verb that needs no `--url`, because the link
> carries its own target. **Sending someone to `login` would send them looking for a project URL
> that has no page to come from.**"*

Line 183 then prints `cswarm login` anyway. The comment governs the invite branch; the "Or stay in
the terminal" line was written for the no-invite branch and reintroduced the exact failure the
comment names. Nothing in `install.sh` is executed by a gate, which is how both of the file's
previously-recorded mechanism bugs also shipped.

**The target is not secret and is already published on the host the installer came from**, so this
is detectable rather than askable, per the onboarding direction in AGENTS.md:

```
$ curl -s https://commonswarm.com/start | grep -o 'commonswarm:url" content="[^"]*"'
commonswarm:url" content="https://ukezjcnxjvkpkeezxaew.supabase.co"
```

**NOT established:** whether the `/app` web path works end to end for a cold user. Only the
terminal path was exercised here.

---

## F-2 — D-080 REPRODUCED DETERMINISTICALLY, and the fix VERIFIED against production

This closes the register's *"D-080's fix has never been exercised against a real start."* It has
now, on production, and the reproduction needs **no intermittent canary failure** — a clean
stop/start cycle is enough.

**The trigger is simpler than the register says.** The register describes D-080 as a retry after a
*failed* start. The fallback also treats `stopped` as terminal, so **a normal stop followed by a
normal start reproduces it every time.** That is a far more common user action than a retry after
failure, which widens the defect's blast radius.

| # | build | stale status on disk | `listen start` said | elapsed | what was TRUE |
|---|---|---|---|---|---|
| 1 | 0.1.11 | *(none)* | "Listener is ready", pid 45697 | ~30s | ready |
| 2 | 0.1.11 | `stopped` pid 45697 | **"listener failed (stopped); no ready listener was left running"** | **0s** | pid 49631 spawned, `starting`, "No listener error is recorded", **reached `ready` at +24s** |
| 3 | main (fixed) | `stopped` pid 49631 | "the host did not prove that CommonSwarm controls ACP tool permissions" | ~7s | **genuinely this instance's own failure** — status carried the NEW pid 52957. The over-fix control holding in production: a real failure is still reported |
| A | 0.1.11 | `failed` pid 52957 | **"the host did not prove that CommonSwarm controls ACP tool permissions"** | **0s** | pid 56218 spawned and **reached `ready`** |
| B | main (fixed) | `stopped` pid 56218 | **"Listener is ready"**, pid 58711 | 8s | ready |

**Rows 2 and B are the A/B**: byte-identical stale condition, opposite outcomes.

**Timing alone discriminates the two defects, and this is the field test worth keeping.** D-080
fails at **0s** — the status file is read on the first poll before anything can have happened. A
genuine D-081 canary failure takes **~7s**. Row 3 was a real failure and row A was not, and the
elapsed time said so before the pid did.

**The failure messages assert two things that were false.** Row 2 said *"no ready listener was
left running"* while a listener it had just spawned was running and reached ready 24s later. Row A
gave a **specific, actionable** diagnostic for a start that was fine. In both, `listen start`
abandons a healthy listener and tells the user nothing is running — so the user either walks away
leaving an orphan, or retries into a collision.

This is the same claim family as the `ready_timeout` string corrected in `dd41de1`: a message
asserting the process's state, which the code does not check, rather than our own action.
**`"no ready listener was left running"` is still in the tree** (`cli.ts`, the generic fallback in
`listenerFailureMessage`) and is not fixed by the D-080 change — see F-3.

**NOT established:** whether the `claude`, `codex` or `grok` providers behave the same. Only
`opencode` 1.18.10 was exercised. The mechanism is provider-independent — it is in
`waitForListenerReady`, above the adapter — but that is an argument, not a measurement.

---

## F-3 — "no ready listener was left running" was measured false · FIXED

The generic fallback in `listenerFailureMessage`. Row 2 above printed it while the listener it
had spawned was `starting` with no error recorded, and that listener reached `ready` 24s later.
Nothing on that path stops the child and nothing re-checks it.

Now: `listener failed (<code>); check cswarm listen status before starting another`.

**Why the earlier sweep missed it.** `dd41de1` corrected the same defect in the `ready_timeout`
string and swept the claim family. This line survived because it **names no error code** — it did
not look like a member of the family being swept. Enumerating every string a function can RETURN,
rather than every string matching the phrasing under review, is what found it.

## F-4 — a reply was invisible as a reply · FIXED

`cswarm reply` sets `in_reply_to`; the run read it back from the JSON surface carrying the exact
ask id. The human line dropped it, so the reply arrived rendered `[note]`, indistinguishable from
an unrelated one — in a product whose core loop is ask → reply.

**Not a regression.** The same inbox held an **eleven-day-old** reply never shown as one. This has
been true for every reply the product has carried.

## F-5 — `ask --wait` timed out with no next step · FIXED

*"Ask shared. No reply arrived before the wait ended; the ask remains live."* True, and it leaves
the reader with nothing to do — the defect Wren and Joist recorded on `listen stop`, one verb
away. `cswarm inbox` is verified, not guessed: this run posted an ask, replied, and read the reply
from the asker's inbox.

The sentence had **two** producers, human and JSON. It is now one shared constant, because
`workspaces.ts` already records what editing both looks like when it goes wrong.

**And fixing it broke a test I did not run before publishing.** `tests/support/agent-receive-cli.test.ts`
pinned the old literal. `npm test` was **498/499** while I wrote a commit message claiming
499/499 — I had read `test:p1-cli` green and reported the other number without looking. Corrected
in `27a1f9c`. The file lives in `tests/support/`, which the `test:p1-cli` glob does not reach and
`npm test` reaches only because it names the file literally: **both gates were needed to see it.**

## F-6 — `project` and `workspace` are used interchangeably · NOT FIXED, needs a decision

Measured in `src/cli.ts` prose, with flag and field names (`--workspace-id`, `SWARM_CLOUD_WORKSPACE_ID`)
excluded because those are identifiers and must not change:

```
16 project     11 workspace
 2 projects     5 workspaces
```

Roughly even, inside one CLI. Two consecutive commands in this run:

```
$ cswarm use <id>
Selected project Dogfood Workspace (3ab184b3-…).

$ cswarm note "…"
Signal shared. It is immutable and visible to members of this workspace.
```

`install.sh` names this drift and declines it: *"the site and the docs say 'workspace' throughout.
That drift is real and is not this file's to settle."* README is also split (14 / 21).

**Left unfixed deliberately.** Which noun wins is a product decision, not a defect fix, and a
blanket rename touches help text, error messages, and the tests that pin them. Recorded with the
measurement so whoever decides has the numbers.

## What this run did NOT establish

- **`cswarm login` first-time GitHub sign-in.** Still unverified, in every round. Needs a browser.
- **The `/app` web signup path.** Only the terminal path was exercised for F-1.
- **The `claude`, `codex`, `grok` providers.** Only `opencode` 1.18.10 ran. D-080's mechanism sits
  in `waitForListenerReady`, above the adapter, so it should be provider-independent — that is an
  argument, not a measurement.
- **Whether D-081's canary intermittency has a cause.** One genuine failure was observed in this
  run (row 3) and one clean start (row 1), which is consistent with the existing record and adds
  nothing to the diagnosis.
- **`member remove`'s success path.** Still blocked on a human at a keyboard for
  `cswarm login --no-browser`.
