# R1 validity blockers — the consolidated list

**As of 2026-07-25.** Three independent reasons a scored R1 round cannot currently produce a number
anyone should believe. Each measured, none inferred. **They do not share a fix.**

A successor should read this before scheduling a round. R1 has never completed one — so **nothing
false has shipped. That is timing, not design.**

---

## 1. Persona isolation was never in force

Full write-up: `2026-07-25-persona-isolation-never-in-force.md`. Recommendation and cost:
`2026-07-25-persona-isolation-recommendation.md`.

Compressed: a cmux tab inherits the **cmux app's** environment, not the spawning process's, so the
harness's PATH-shim instrumentation never reaches the persona. The tab's PATH contains
`/opt/homebrew/bin`, where `coswarm` is a **symlink into the live product repo**. And the preflight
check that asserts the shim is in force **cannot fail** — it constructs the PATH it then tests.

Confirmed on **both** machines, four surfaces on the mini and two spawn-created surfaces on the
laptop, each agent reading its own environment. **Both personas fail identically**, so the two
experiences remain comparable — the better of the two available outcomes.

**Cost to fix: a day.** No scored round before it lands.

## 2. Cleanliness was verified at the registry layer, and the machine is dirty

Full write-up: appended to the isolation finding.

Compressed: every clean-machine check reads the **swarm registry** — zero agents, cwds untouched,
reset cold. Those were true. A cmux **surface** is a different object that survives its agent's exit;
`swarm leave` does not close a tab and neither does killing the process. Five surfaces were found on
the laptop, **four of them orphaned spawn-created tabs.**

A round's pre-flight must sweep **surfaces**, not agents. ★ But not blindly — those same four
orphans were the only observable sample of a spawn-created persona environment in existence, and are
why blocker 1 could be measured on the second machine **without running a spawn**. *Sweep before a
round; preserve while diagnosing.*

## 3. ★ THE TWO MACHINES RUN THE HARNESS ON RUNTIMES TWO MAJOR VERSIONS APART, AND NOTHING CHECKS IT

**Found by the product lane, 2026-07-25. Measured, and re-derived by the Lead:**

```
mini    ~/uxtest/product/NODE_BIN  -> /opt/homebrew/bin/node                      v26.5.0
laptop  .../uxtest/product/NODE_BIN -> /Users/tom/.nvm/.../v24.14.1/bin/node      v24.14.1
```

**Cause is one line, present twice** — `uxtest/scripts/sync-machine2.sh:123` (local half) and `:161`
(remote half, inside the escaped heredoc):

```sh
command -v node >"$home_root/product/NODE_BIN"
```

★ **`NODE_BIN` IS NOT A PIN. IT IS A SNAPSHOT OF WHOEVER INSTALLED.** It records whatever `node`
resolved to *in the installing shell*. On the mini that is the sync script's own shell — homebrew,
v26.5.0. The laptop half runs through `remote_zsh`, which is `zsh -lic`, so it captures the **nvm**
node an interactive login shell loads — v24.14.1. **Nothing declares an intended version and nothing
compares the two files.**

**Why it matters for R1 specifically:** R1 compares two personas' first-run experience. If they run
the product on runtimes two majors apart, **a difference between them is not attributable to the
product.** Blockers 1 and 2 make a round *invalid*; this one makes it **incomparable**, which is a
different and equally disqualifying failure.

**Fix shape (not taken):** declare an intended version, pin it, and **compare the two `NODE_BIN`
files as a pre-flight gate with a real RED** — today's skew is the RED, available immediately, which
is the same build-order the isolation gate uses: *build the check, watch it fail on the current
system, then fix the thing.*

---

## ★ The shape all three share, worth naming once

Each is a check that **was pointed at the wrong object**, or was **absent where it was assumed
present**:

- isolation instrumentation aimed at the spawner's environment, not the persona's
- cleanliness aimed at the registry, not the surface
- runtime aimed at *whoever installed*, not at a declared version

★ And the same lane that found blocker 3 **corrected itself twice on the way**, both times caught by
the harness owner: it reported an update path that did exist, and it wrote *"the machine's PATH"*
after correcting someone else for exactly that phrase — **a machine does not have one PATH; it has
one per shell form**, which is precisely what produced blocker 3.
