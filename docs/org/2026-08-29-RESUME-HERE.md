# RESUME HERE — 2026-08-29

Written for a successor reading this repo cold. Supersedes `2026-08-27-RESUME-HERE.md`, which
remains accurate for the v0.1.26–v0.1.31 arc.

Session covered: **v0.1.31 → v0.1.37**, nine releases, all live. Every one traces back to a
single operator question: *"are you getting my messages?"*

---

## 1. Refs by hash

| ref | what it is |
|---|---|
| `b9268e1` | **`main`** — v0.1.37 release. Latest. |
| `c99758b` | v0.1.36 — anon key removed from arrival notifications |
| `2003ba2` | v0.1.35 — `inbox --notify`, visible arrival |
| `5a30d21` | v0.1.34 — directed NOTES queued, not observed |
| `a0564f3` | v0.1.33 — `queued` outcome for routed ASKS |
| `744ddbd` | receipt function fix (`auth.uid()` 42501) |
| `f2ae0e5` | v0.1.32 — delivery receipts, `@` addressing, Cmd/Ctrl+Enter |
| `f254899` | `command_failures` diagnostic table |

Migrations applied to production: `20260827000001`, `20260827000002`, `20260828000001`,
`20260828000002`, `20260828000003`. Edge functions `read` and `command` redeployed.

---

## 2. LIVE and independently verified

- **`cswarm inbox --notify` under a host monitor INTERRUPTS a session.** Confirmed by the agent
  **Quill** — different model family, different machine, session genuinely mid-wait:
  *"INTERRUPTED. inbox --notify under a host monitor woke this Grok session mid-wait; I did not
  have to wait for a next prompt."* This is the only claim in the set verified by someone other
  than its author, and it is the one the author had previously called impossible.
- Delivery receipts: `queued` → `observed` → `replied`, verified in production with the PATH
  binary. Broadcast reports "nobody was addressed or woken". Cross-sender reads refused.
- `@` mentions address the message; Cmd/Ctrl+Enter sends; broadcast is labelled
  "no agent will be woken".
- `feed` states it shows broadcasts only and names `inbox`, on populated AND empty results.

---

## 3. ★ THE THREE LAYERS — do not conflate them

This distinction cost most of a night. It is the single most useful thing in this file.

| layer | what it does | what it does NOT do |
|---|---|---|
| `cswarm listen start` | durable delivery — claim, lease, ack, routing | renders nothing anywhere |
| `cswarm hook install claude` | surfaces to the model at its **next prompt**; marks `observed` | invisible to a human watching the terminal; does not interrupt |
| `cswarm inbox --notify` under a **host monitor** | **interrupts now, visibly** | wakes no worker; changes no delivery state |

**A UserPromptSubmit hook's stdout is injected into model context and is NEVER rendered as a
transcript line.** A human watching the terminal sees nothing, forever, no matter how well
delivery works. A **host monitor** — a background watcher whose stdout lines become notifications
— is what renders and what interrupts.

The maintainer had a screenshot of a monitor working on another agent, and still spent hours
telling the operator visible rendering was a host limitation. It was not. He had only ever armed
the hook.

This also resolves Quill's earlier finding, *"inbox --follow does not wake the model — a signal
nobody acts on is not observability."* `--follow` was never broken. **Nothing was watching it.**

---

## 4. ★ THE TRAP THAT CAUGHT ME THREE TIMES IN ONE SESSION

**Upgrading the binary does NOT upgrade a RUNNING process.** Restart the listener, the notify
watcher, and confirm the hook's binary after every single upgrade.

1. The hook runs bare `cswarm` from PATH — `~/.local/bin/cswarm` — which was **0.1.30 while
   0.1.33 was being shipped**. Three releases claimed and none installed for the author.
2. A fix was "verified end to end" using `node dist/cli.js` — the local build — **not the binary
   the hook executes**. `build-release.sh` bundles from source and does not refresh `dist/`.
3. The listener process ran 0.1.34 code while 0.1.37 was being released, because the process was
   never restarted after the upgrade.

Each time the proof was against the wrong artifact and each time it read as success. Check
`cswarm --version` from PATH, and restart long-lived processes, before believing any result.

---

## 5. Corrections to claims published this session

1. **"Observed" was asserted before the agent saw anything** — twice. v0.1.33 fixed routed
   *asks*; the sibling branch for *notes* was left making the identical false claim, and web-UI
   messages are notes, so the operator's actual path stayed broken for a release. Fixed in
   v0.1.34 by **enumerating all 13 ack-outcome branches** against the real event each asserts.
   This is the repo's own *sweep over claims, not lines* rule, broken one message after quoting
   it.
2. **A receipt migration shipped broken because it was reviewed by reading, never run against
   PostgreSQL.** `auth.uid()` inside a `SECURITY DEFINER` owned by `swarm_admin` raises
   SQLSTATE 42501; every other `auth.uid()` in the schema is in a view, which runs as the
   querying role. Verify migrations against a real local Postgres.
3. **"Visible rendering is a host limitation."** False. See §3.
4. **The write-500 was called "load-related"** on two runs separated by time. 22 later writes
   with heavier concurrency failed zero. It is **episodic**; rate-dependence is unestablished.

---

## 6. `feed` omits directed signals — it fooled two agents in one night

`cswarm feed` shows broadcasts. A directed signal is visible only to sender and recipient and
lands in the recipient's **inbox**. The maintainer searched `feed` for his own directed asks,
found nothing, and began investigating a delivery bug that did not exist. Hours later the agent
Quill did the same, concluded the CLI had falsely claimed a message was posted, and announced a
resend — both asks had landed. Duplicates were one message away.

Fixed in v0.1.37 (the empty result carries the guidance too — "no signals" is what fooled both).
Recorded because the *shape* recurs: **a surface that answers a different question than the one
being asked, and does not say which.**

---

## 7. Still OPEN

- **The write-path 500.** Episodic, root cause unknown. `command_failures` (`f254899`) is applied
  and will capture the SQLSTATE next episode — that is the instrument, not the fix.
- **grok `permission_canary_failed` on Quill's machine.** The version floor admits 1.0.5 and the
  canary passed on the maintainer's machine, so that result does not generalise. Needs
  `lastWorkerStderrTail` from a FRESH failure on ≥0.1.30; Quill's existing null predates their
  upgrade and proves nothing.
- **Mobile composer with the on-screen keyboard open.** The layout bug was real and fixed, but the
  keyboard case is unmodelled by the harness — needs a screenshot from a real device.
- **`--agent-token-file`.** The 0600 redirect closes the exposure; a first-class flag would make
  the safe form the obvious one.
- **`--renewal-horizon-days` is still a display value** the server ignores.

---

## 8. The pattern worth carrying forward

Nine releases, and every underlying defect had the same shape: **something reported success — or
reported nothing — while the truth was different, and the artifact read as if it worked.** A dead
listener that swallowed messages silently. Newlines stripped so markdown could never render. A
receipt claiming `observed` before anyone observed. A feed hiding exactly what was being looked
for. A green indicator the operator had to disbelieve.

None were caught by the 600+ test suite. All were caught by an operator refusing an answer that
sounded reasonable, and by agents dogfooding the product — Wren, Joist, LeadG, MrSentry, Quill.

**The most valuable single habit: check the claim against the artifact that actually runs.**
