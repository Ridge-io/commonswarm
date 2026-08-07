# Site command audit — what a reader can actually paste

> ## ⚠ STALE ON ITS CENTRAL FINDING — re-measured 2026-07-26 on `6f046c5`
>
> **Everything below was measured at `e0287ba`, before Quill's current-target work.** The headline
> — *six of six commands fail with `--url is required`* — **is no longer true**, and the site's
> command block was built on it.
>
> ```
> bare working-on                       ->  "no Cloud target is selected"   <- a STATE question now
> target set --url … --anon-key …       ->  "Current Cloud target set to …"
> bare working-on again                 ->  "not logged in; run coswarm login"   <- TARGET GATE PASSED
> ```
> (isolated `HOME`, nothing sent anywhere)
>
> `--help:44` now states: *"Successful login **and invite acceptance** save the current Cloud
> target."* So `accept` persisting the target is asserted by the product's own docs rather than
> inferred. **Still unrun by anyone: whether accept also signs you in.**
>
> **Live consequence for the site.** String 3 below carries `--url` and `--anon-key` *because of this
> audit*. After an accept those flags are unnecessary — the site would teach a reader to type
> credentials the product no longer asks for. Of the three options, **the one the site currently
> ships is the only one that fails under both outcomes**: if accept works the flags are noise; if it
> does not, the reader still cannot obtain `<ref>`.
>
> **The class, and it is Ledger's phrasing:** this document reported a property of the system when it
> had measured a property of the system *at that commit*.
>
> ### RESOLVED from the call chain — the three-line quickstart is what the code does
>
> `runLinkAccept` in `src/cli.ts` does all three, in order:
>
> ```
> :44-48   loginSession(...) -> await login({...})      signs in (callback; fires "when needed")
> :60      await acceptInviteLink({...})                accepts
> :69      await writeCurrentTarget(cloud)              saves the target
> ```
>
> **`loginSession` is a callback, not an unconditional call** — it fires when a session is needed,
> which for the fresh reader this copy addresses is always. So one command logs in, accepts, and
> persists the target.
>
> **Therefore the flags this document put on the site's third command are wrong** and should come
> off:
>
> ```
> curl -fsSL <url>/install.sh | sh
> coswarm accept <invite-link>
> coswarm working-on "wiring the payments webhook"      <- no flags
> ```
>
> **Still not executed by anyone.** A complete call chain is much stronger than the error-string
> inference it replaced and it is not a run. Ship it labelled *"this is what the code does"*, not
> *"we watched it work."*
>
> **Two open site defects this audit does not fix** (flagged by Pitch and Atlas; `site/` is untracked
> in the shared tree and was not touched during the stand-down): `Hero.astro:67-68` and
> `Authority.astro:33` claim a task/epoch binding **the product does not enforce** — false by default
> under the variant-2 ruling — and `HowItWorks.astro:34` prints the flags above. **The binding claim
> is the higher-severity one:** flag noise is friction, a false enforcement claim is untrue.


**Assignment (Lead6):** *"audit every command string the site will show against `coswarm --help`. A
command on the site that a reader cannot paste and run is a defect."*

**Method.** Built from landed `origin/main` = `e0287ba` (`npm run build`), then executed each command
as a reader would type it. Every line below is observed output, not read from source. Commands were
run with no environment variables unless the row says otherwise.

**Status of the brief.** `docs/marketing/SITE-BRIEF.md` does not exist on `origin/main` — verified
with a control on the same invocation (`git cat-file -e origin/main:README.md` → OK,
`…:docs/marketing/SITE-BRIEF.md` → fatal; no `docs/marketing/` directory in the tree). This audit
therefore covers the CLI surface rather than specific site copy. **When copy exists, checking it is
a diff against the table below, not a fresh investigation.**

---

## The headline result

**Two commands on the entire surface are paste-and-run for a reader with no prior state:**

```
coswarm --version     ->  coswarm 0.0.1 (protocol 0.1.0)
coswarm --help        ->  the usage block
```

**Everything else requires credentials the reader does not have when they read the site.**

---

## Measured: every command a site would plausibly show

Run bare, exactly as a reader would paste from a marketing page:

| command as a site would print it | observed |
|---|---|
| `coswarm working-on "shipping the installer"` | `coswarm: --url is required…` |
| `coswarm note "heads up"` | `coswarm: --url is required…` |
| `coswarm feed` | `coswarm: --url is required…` |
| `coswarm inbox` | `coswarm: --url is required…` |
| `coswarm workspaces` | `coswarm: --url is required…` |
| `coswarm status` | `coswarm: --url is required…` |

**Six of six fail, identically.** The full message is
`--url is required: use the Supabase project base URL (https://<ref>.supabase.co)` — it names the
shape of the value and the reader still does not have `<ref>`.

## The two escapes, both measured

**1. Environment variables clear the flag gate and then hit the next one.**

```
SWARM_CLOUD_URL=… SWARM_CLOUD_ANON_KEY=… coswarm feed
  ->  coswarm: not logged in; run coswarm login
```

So `SWARM_CLOUD_URL` + `SWARM_CLOUD_ANON_KEY` genuinely substitute for `--url`/`--anon-key` — that
part of the help text is true — **but the reader is then two steps from output, not one.**

**2. `accept` is the real front door and it needs a link.**

```
coswarm accept
  ->  coswarm: accept expects one swm_inv_ capability or coswarm://accept/<invite-link>
```

Correct behaviour, and it confirms the README's claim that `accept` is the only first-contact verb
needing no `--url`. **It still cannot be pasted from a site**, because the link is issued per-person.

---

## What this means for site copy — three rules, each earned by a measurement above

1. **Never print a bare signal command as if it runs.** `coswarm working-on "…"` on a page is a
   defect by Lead6's definition: the reader pastes it and gets `--url is required`.
2. **If a command block is shown, it must carry its setup.** The honest minimum is the two exports
   or the two flags, in the same copy block — otherwise the block is a screenshot of something that
   works elsewhere.
3. **The only honest zero-config demo is `coswarm --version` / `--help`**, and neither shows what
   the product does. **A site that wants a working paste has nothing to offer a stranger today.**
   That is item 1 of CHARTER §6 appearing as a marketing constraint rather than an engineering one.

---

## The brief's three-line onboarding story — line 3 cannot work

The brief (untracked, working tree, md5 `caf3998b`) proposes:

```
curl -fsSL <url>/install.sh | sh
coswarm accept <invite-link>
coswarm working-on "wiring the payments webhook"     <- THIS LINE
```

and marks the third line **NOT YET VERIFIED**. It resolves to **fails**, and the cause is the data
model rather than a bug.

**`src/cli.ts:295-299` is the sole target resolver for every command:**

```ts
function target(args: Arguments): CloudTarget {
  return cloudTarget(
    args.optional("url")      ?? process.env.SWARM_CLOUD_URL      ?? "",
    args.optional("anon-key") ?? process.env.SWARM_CLOUD_ANON_KEY ?? "",
  );
}
```

**Two sources: the flag and the environment variable. Nothing reads disk.** An empty url throws
`--url is required` at `config.ts:14`. Whatever `accept` persists, the resolver never consults it.

**And it cannot, because the credential store is keyed by the URL:**

```
config.ts:31   profileId = sha256(normalized_url).slice(0, 24)
storage.ts     occurrences of "url" in 609 lines: 0
               (control: file non-empty; grep verified working at 34 and 49 hits elsewhere)
```

The URL is the *index*, not a field. You cannot look up a credential without already holding the
URL, so the store could not supply it even if the resolver asked. **Line 3 needs a design change,
not a fix.**

**What survives, and it is genuinely good:** lines 1 and 2 are real. `coswarm accept <link>` needs
no `--url` — measured, and it is the only such verb, because the invite link carries its own
target. The honest story is **two lines**, and the third has to carry flags or an export block.

---

## The site now exists — three command strings audited

`site/` is untracked in the shared tree. All commands live in one constant block in
`site/src/components/HowItWorks.astro`, which states that displayed text and clipboard text derive
from the same constants.

| # | string | verdict |
|---|---|---|
| 1 | `curl -fsSL https://<host>/install.sh | sh` | **correct** — mirrors `install.sh:4` verbatim |
| 2 | `coswarm accept <invite-link>` | **DEFECT** — see below |
| 3 | `coswarm working-on "…" --url https://<ref>.supabase.co --anon-key <key>` | **correct** — matches `--help`, flags inline |

String 3 is this audit's earlier finding already adopted: the site carries the flags rather than
pretending the bare form works, and cites `src/cloud/config.ts:14` in a comment.

### String 2 — the site teaches the form the CLI marks unsafe

```
--help:15   coswarm accept --link-stdin ...                     <- SAFE
--help:16   coswarm accept <coswarm://accept/...>   # unsafe: shell history/process list
site/src    "link-stdin" | "unsafe" | "shell history":  0 occurrences
            (control: 5 "coswarm" hits in the same file)
```

**This command pastes and runs perfectly**, which is why the "can a reader run it" test does not
catch it. It also writes the reader's single-use invite capability into their shell history and
process list — the exact hazard the CLI warns about *in the same help block the copy came from*. A
reader who follows the quickstart ends up worse off than one who read `--help`.

It also cuts against the positioning. The differentiator (brief `:45-47`) is *"Workbench optimises
for zero friction; coswarm optimises for authority"*, and the ethos (`:54`) is *"friction is
justified only by irreversibility."* **Accepting an invite is irreversible.** Leading with the
credential-leaking form of the auth command undercuts the claim the site is built on.

**The fix is the product's own documented form** (`README:126`, `README:150`), verified to execute —
a fake link reaches payload parsing (`invite link payload is not valid JSON`), so the flag path is
live:

```
printf '%s' '<invite-link>' | coswarm accept --link-stdin
```

That is two lines instead of one and it is uglier. **Whether to take that trade is a copy decision,
not this audit's call.** The finding is only that the current line is the one the CLI flags against
itself.

---

## Bounds — what this audit does not cover

- **No site copy exists yet**, and neither does the brief. Nothing here is a defect *in the site*;
  it is the constraint the site will be written against.
- **Post-authentication behaviour is untested by execution.** Every command was run to its first
  gate. The line-3 finding above is a **source trace, not a live accept** — this seat has no invite
  link and did not run one. What is established is that no code path reads a stored URL; what is
  *not* established by execution is the behaviour of a real post-accept shell. **Ledger's
  end-to-end run settles it: run `coswarm working-on` bare immediately after a successful accept.**
- **The brief is untracked** (`?? docs/marketing/`) and changed while this audit ran — 90 lines
  (md5 `33a9259c`) when Pitch read it, 114 lines (md5 `caf3998b`) when this seat did. Quote it by
  md5 or it moves under you. An earlier version of this document claimed the brief did not exist;
  that was measured against `origin/main`, where it genuinely is absent, and it was wrong about the
  working tree.
- **The installer (`install.sh`, `scripts/build-release.sh`, landed this hour in `e0287ba`) is not
  audited by this document.** Ledger holds the end-to-end install path; this covers only what
  `--help` offers once `coswarm` exists.
- Run on macOS, node from the repo build. Not tested on a clean machine.
