# Recommendation to the Lead: persona isolation for uxtest

**Headline: one approach survives, but only with the claim reduced — and the previously reported "there is no non-vacuous gate" is wrong. I found one, and measured it working today.**

The formal panel count was: proposals 1, survived-with-a-non-vacuous-gate 0. I am overriding that count on one specific point, and I want to be explicit about why, because the Lead should not take my recommendation on the strength of a disagreement I fail to justify.

The reviewer's decisive claim against the gate was that `sandbox_check` cannot discriminate — that it returned −1 for both a sandboxed and an unsandboxed process, and 1 (the "denied" value) for nonexistent pid 999999. I reproduced the −1 exactly, and it is an artifact of how the call was made: with the `SANDBOX_CHECK_NO_REPORT` flag (0x80000000) OR'd into the filter type, this OS build returns −1 unconditionally, for every pid and every path. Called with plain `SANDBOX_FILTER_PATH` (1) and no flag, from a small C helper rather than through ctypes variadics, it discriminates cleanly. Measured on the mini today, same repo path in every row:

- live process that was exec'd through `sandbox-exec` with a profile denying the repo → **1**
- live process **forked from** that process (not itself exec'd by `sandbox-exec`) → **1** (inheritance is visible to the query)
- live unsandboxed process, and the querying process itself → **0**
- live sandboxed process asked about `/etc/hosts` (an allowed path) → **0**
- live process sandboxed with a *different* profile that denies something else → **0**
- dead / nonexistent pid → **1 for every path, including `/etc/hosts`**

That last row is the trap the reviewer found, and it is real — but it is escapable, because the same pid answers **0** for an allowed path only when it is alive and correctly confined. A pair of answers, not one, is the discriminator. That is the whole gate, and it is the part of this recommendation that matters most.

---

## 1. The one recommended approach, and the reduction that comes with it

**Adopt the typed-command jail's filesystem layer, restructure the profile from a blocklist to default-deny-read, add a credential-channel denial, and replace the isolation claim in §7.2.2 with a narrower one that the gate can actually certify.**

It beat the alternatives because there were no real alternatives: the PATH-shim approach is refuted by measured fact 1 (the tab inherits cmux's environment) and by absolute-path bypass, and nothing else on the table reaches the persona at all. The typed-command delivery channel is the only spawner-controlled channel that does reach it, and `sandbox-exec` is the only boundary on this machine that a process cannot undo for itself or for its children.

**The reduction is the important half of the recommendation.** The claim "the persona is isolated from the product" is not enforceable and should be struck. Three of the reviewer's breaks are correct and cannot be closed by any sandbox profile:

- the persona must be able to run the product, so the built `dist/` in its own root is readable by construction;
- the product's own runtime credentials are in the persona's hands the moment the product runs, so §7.2.1 as currently written ("obtaining `SWARM_CLOUD_URL` / `SWARM_CLOUD_ANON_KEY` voids the round") voids *every* round by construction and must be reworded to "obtains them from the repository or the harness apparatus";
- pretraining residual is already conceded in §7.2 item 5 and is not going away.

The claim I recommend, in the words I would put in HARNESS.md:

> For the duration of the round, the persona process and every process descended from it were denied, by the kernel, read access to the product repository, to the global npm link and the `coswarm` symlink behind it, to the real user's home directory, to the prior-agents' scratch tree under `/private/tmp`, and to the keychain — and therefore to any credential capable of fetching the private repository over the network. This was verified against the live persona pid by kernel query at spawn and again at teardown. It is *not* a claim that the persona learned nothing about the product; the compiled `dist/` it executes, path existence metadata, and pretraining residual remain and are enumerated in §7.2.3.

A smaller true claim beats a larger unenforceable one, and §1b prefers the smaller thing.

## 2. The exact change

**`uxtest/scripts/spawn-observed.sh`, lines 47–59.** Stop calling `swarm spawn`. Issue `cmux new-surface` + `cmux send` + `send-key Enter` directly — the script already does exactly this at lines 132–136 for its retry path, so the plumbing exists. The typed line becomes `cd <workspace> && exec ~/uxtest-harness/jail/enter <round> <role>`. (The alternative is an exec-prefix flag on `swarm/src/index.ts:1844`; I prefer the harness-local route because it changes nothing in a tool the persona also uses.)

**New `uxtest/jail/enter`**, installed to `~/uxtest-harness/jail/enter` — deliberately *outside* `~/uxtest/`, so the persona cannot read the apparatus. It writes its own pid to `$ROOT/run/<role>/<round>.pid` (the pid survives the exec chain) and then execs `/usr/bin/sandbox-exec -f persona.sb /usr/bin/env -i …`. The env allowlist **must** include `UXTEST_HOME_ROOT` and a jail-internal `TMPDIR`. The reviewer's break 3 is correct and I confirmed the cause in the source: `coswarm-wrapper.sh:5` and both tripwire scripts open with `root="${UXTEST_HOME_ROOT:-$HOME/uxtest}"`, so relocating `HOME` without passing `UXTEST_HOME_ROOT` makes `coswarm` exit 127 with "copied coswarm build is missing". And `TMPDIR` must move inside the jail because the profile denies `/private/tmp`.

**New `uxtest/jail/persona.sb.in`** — default-deny-read, not a blocklist. This is my main change to the proposal, and it matters: it closes three of the reviewer's breaks in one rule rather than by remembering to enumerate them. The measured working shape is `(allow default)` `(deny file-read*)` `(allow file-read-metadata)` then `(allow file-read* file-map-executable …)` over `/usr /System /bin /sbin /Library /private/etc /private/var /dev /opt/homebrew` and the jail root, then narrow denies for `/opt/homebrew/lib/node_modules/cloud-swarm` and `/opt/homebrew/bin/coswarm`, plus `(deny mach-lookup (global-name "com.apple.SecurityServer"))` and `(deny process-exec …)` on `security`, `gh`, `osascript`, `cmux.app`. Verified under exactly that profile today: `node` runs (v26.5.0), `ls /usr/bin` works, and **`cat` of the repo, `ls /private/tmp/claude-501`, `cat ~/.ssh/id_ed25519`, and `cat ~/.local/bin/swarm` all return "Operation not permitted"** without any of them being named in a deny rule. Note that it took me two iterations to get a default-deny profile that didn't SIGABRT everything — `(allow file-read-metadata)` and `file-map-executable` are both load-bearing.

The credential denial is what closes the reviewer's decisive break. That break is real on this machine — `~/.gitconfig` does set `credential.https://github.com.helper=!/opt/homebrew/bin/gh auth git-credential`, `gh auth token` returns a 40-character token, and the repo is private (unauthenticated `api.github.com/repos/Ridge-io/cloud-swarm` → 404). Under the profile with the two credential rules added, measured today: `gh auth token` → "no oauth token found for github.com"; `security find-generic-password` → `execvp() … Operation not permitted`; `git ls-remote https://github.com/Ridge-io/cloud-swarm` → "could not read Username for 'https://github.com'". The network stays open (the persona is a Claude session and needs it); the *credential* closes, and GitHub itself enforces the rest. That is the right place to cut, because the boundary you can hold is "no credential", not "no network".

**New `uxtest/scripts/sbcheck.c`** (~25 lines) built at preflight into `~/uxtest-harness/bin/sbcheck`; preflight dies if it cannot build. Signature: `sandbox_check(pid, op, type, arg)`, called with type 1 for paths and type 2 for mach global-names, never with the NO_REPORT flag.

**New `uxtest/scripts/assert-jail.sh`** — section 3.

**`uxtest/scripts/preflight.sh`, lines 122–131 and the mirrored remote block at 133–141.** Delete the vacuous check. Keep the "copy is not a symlink" and SHA assertions — they are still meaningful hygiene — but they stop being the isolation claim. Add in their place: build `sbcheck`; run `assert-jail.sh --selftest`; and two behavioural probes against the real instantiated profile, `sandbox-exec -f persona.sb /bin/cat $UXTEST_REPO/package.json` must fail and `sandbox-exec -f persona.sb $ROOT/bin/coswarm --help` must succeed. Both can fail; the pair also covers process-exec denials, which (measured) the kernel query cannot answer — `sandbox_check` with `process-exec` returned −1 in every configuration, so exec denials are enforced but only verifiable behaviourally.

**`uxtest/scripts/sync-machine2.sh`.** Copy the `swarm` CLI into `$ROOT/bin` as a real non-symlink copy, mirroring what already exists for `coswarm`; copy the `/join-swarm` skill into the jail HOME's `.claude/skills/`; allow the profile to read and write `~/.swarm/swarm.db{,-wal,-shm}` by literal path. This is not optional polish — the reviewer's break 4 is structural and correct: `~/.local/bin/swarm` is a three-line wrapper whose body is `exec /Users/yulanbot/Developer/Ridge.io/swarm/bin/swarm`, inside the denied tree, and the skill lives in the denied real `~/.claude`. Without this fix `wait_for_agent_local` never observes membership and `spawn-observed.sh` dies after three attempts every round. Also strip `*.map` and `*.d.ts` when copying `$ROOT/product` — and note that this breaks preflight's `mini_sha = repo_dist_sha` comparison unless `bundle_sha` is computed over the same filtered set on both sides.

**Delete `uxtest/scripts/path-tripwire.sh` and `isolation-tripwire.sh`** and the `~/uxtest/bin/{cat,ls,grep,head,tail,sed,find,node,python3,readlink,which,rg,jq,…}` shims they install. They are the mechanism that was never in force; `$ROOT/bin` is first on PATH so under the jail they would break the persona's basic tools; and they were always bypassable with an absolute path. Keep only `coswarm` and `swarm` in `$ROOT/bin`, and move the wrapper body out of the persona root behind a thin trampoline.

## 3. The gate

`uxtest/scripts/assert-jail.sh <round> <role>`, run at spawn (before the brief is delivered) and again at teardown (before collect).

**Step 0 — negative control, every invocation, before anything else.** Launch an ordinary unsandboxed `sleep` in the harness's own scratch, run the identical decision function against it, and **require the verdict to be RED**. Then run it against a pid that has just exited and require RED again. If either control comes back GREEN, `die` with "gate self-test failed: the gate cannot fail; refusing to certify". The gate carries its own proof of falsifiability and executes it every time.

**Step 1 — locate the persona pid; never guess it.** Read `$ROOT/run/<role>/<round>.pid`, written by `enter` before it execs. Then three independent confirmations, any failure RED: the pid is alive (`kill -0`); `lsof -a -p <pid> -d cwd` names the persona workspace; `ps -o command= -p <pid>` shows the agent binary, not a shell.

**Step 2 — ask the kernel about that pid.** Seven answers, all required:

| query | required |
|---|---|
| `file-read-data` `$UXTEST_REPO/package.json` | 1 (denied) |
| `file-read-data` `/etc/hosts` | **0 (allowed)** |
| `file-read-data` `$ROOT/product/dist/cli.js` | 0 (allowed) |
| `file-read-data` `/opt/homebrew/lib/node_modules/cloud-swarm/package.json` | 1 |
| `file-read-data` `/private/tmp/claude-501` | 1 |
| `file-read-data` `<real HOME>/.ssh/id_ed25519` | 1 |
| `mach-lookup` `com.apple.SecurityServer` | 1 |

The mach-lookup row is measured discriminating: 1 under a profile with the credential deny, 0 under one without it.

**RED conditions — the concrete states in which it fails.** The typed `exec` line garbles in zsh's rc chain, or `cd` returns nonzero, and an unjailed shell is left sitting there: no pid file, or the pid is a shell — RED at step 1. This is the reviewer's break 5, and it is the failure the current design has no answer for at all. `sandbox-exec` silently not applied, profile path typo, profile file missing: row 1 returns 0 — RED. The persona has already exited, or the pid was recycled: rows 1 and 2 both return 1, and **row 2 is what catches it** — RED. Someone "hardens" the profile into denying the world, or last round's profile is still installed: row 3 returns 1 — RED, and the product would be broken anyway. Credential channel left open: row 7 returns 0 — RED. Gate run on a machine with no round in progress at all: step 1 finds nothing — RED.

**Why it is not vacuous.** Five reasons, in descending order of how much I would stake on them.

First, it never constructs the thing it tests. `preflight.sh:126` builds `PATH="$UXTEST_MINI_HOME_ROOT/bin:$PATH"` and then asks `command -v coswarm` *under that PATH* — it supplies the answer and then reads it back, which is why it passes for any directory containing any executable named `coswarm`, including a fake one. The gate asks the kernel about a pid it did not create and cannot influence, and the answer is the enforcement decision the kernel will actually make when that process reads that path.

Second, it has three distinguishable outcomes, two of them RED, all measured: live-and-confined → (1, 0); live-and-unconfined → (0, 0); dead-or-nonexistent → (1, 1). A single-question gate collapses the first and third; the two-question form does not.

Third — and this is the acceptance criterion I would hold the implementer to — **run it against today's setup and it must go RED immediately**, because today's persona is unconfined and row 1 returns 0. Build the gate first, watch it fail, and only then build the jail that makes it pass. A gate that goes green on the current system is by construction the same kind of gate we are replacing.

Fourth, the query agrees with behaviour. For every pid/path pair I tested — direct exec'd process, forked child, grandchild — a `sandbox_check` of 1 and an actual read returning EPERM co-occurred, and 0 co-occurred with a successful read. The gate is not measuring a proxy for the boundary; it is interrogating the boundary.

Fifth, confinement is one-way: a sandboxed process cannot un-sandbox itself or its children. So a check at spawn and a check at teardown, tied to the same pid by step 1, bracket the round. If the persona restarts mid-round the pid file no longer matches a live agent in the workspace, and teardown goes RED.

## 4. What remains open

The compiled product in `$ROOT/product/dist` stays readable — the persona executes it. Stripping maps and `.d.ts` reduces it to minified output, but it is source-derived and it is in the persona's hands. Worse, deleting the PATH shims removes the only thing that ever *recorded* a read of it. I am naming that as a real regression in observability, traded knowingly for an actual boundary, because the shims' record was bypassable by typing `/bin/cat`. Seatbelt's `(with report)` modifier on an allow rule might restore a passive log; I did not test it and am not claiming it works.

Path existence leaks. `(allow file-read-metadata)` is required for the profile to function, so `ls -la /opt/homebrew/lib/node_modules/` still shows a `cloud-swarm` entry — name and symlink length, not target, not contents. The npm package name is something the persona is meant to discover anyway.

Network egress stays open and cannot be hostname-filtered by seatbelt. The cut is at the credential, not the socket. If a token ever reaches the jail — someone passes `GH_TOKEN` through the env allowlist, or a token lands in a file inside the persona root — the break reopens completely. Add a preflight assertion that the `env -i` allowlist contains no `*TOKEN*` / `*KEY*` name other than the ones deliberately required.

Web search and public discussion of the product remain a behavioural rule (§7.2 item 5), enforced by transcript audit, not by the kernel.

The product's own runtime credentials are in the persona's hands by construction; §7.2.1 needs the rewording above or it voids every round.

## 5. Can R1 run before this lands?

**No — not as a round that produces a §7.2.2-clean number.** Today the isolation instrumentation never reaches the persona, the persona has a direct symlink path into the live repo, and the check that asserts otherwise cannot fail. Any discovery metric collected under those conditions is unqualified, and the discovery metrics are the entire point of R1.

What *can* run today, and I would recommend it, is a **non-scored plumbing pilot explicitly tagged `isolation:none`**, whose only purpose is to de-risk the delivery channel — because the single riskiest unknown in this whole design is whether the typed `exec` line survives zsh's rc chain, autosuggest, and bracketed paste reliably enough to be the thing standing between "measured" and "void". Learn that before you build on top of it. Publish nothing from it.

The minimum before a scoring round is: the gate (step 0 through step 2), the `enter` script with `UXTEST_HOME_ROOT` and jail-internal `TMPDIR`, the default-deny profile with the credential rules, the preflight replacement, and the swarm-join re-plumbing. That last one is not optional — without it no round starts at all. The persona-home hygiene (strip maps and `.d.ts`, relocate the wrapper, decide the `cloud.env` question) is required for the *claim* but the Lead can choose to run with those declared open, provided the reduced claim in §7.2.2 enumerates them by name.

## 6. Cost

**A day, not an hour and not a redesign.** The delivery channel already exists in `spawn-observed.sh`'s retry path; `sandbox-exec` is present on both machines; the gate is twenty-five lines of C plus a shell script and is measured working. Against that: the default-deny profile took me two iterations to stop aborting every process, the swarm-join re-plumbing is genuine work with its own testing, and the `bundle_sha` comparison has to be reworked in step with the map-stripping. Budget a day, and spend the first hour of it building the gate and watching it go red.