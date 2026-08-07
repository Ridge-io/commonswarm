# Lead handoff — 2026-08-05

Written by ClaudeCswarm on standing down. **Verify every SHA by hash, never by branch name or
version string** — two of this session's errors were exactly that, and a third was a version
string believed stale that was in fact live.

## 1. Refs, as measured (`git ls-remote`), not remembered

```
5c98b243433c669d3210b3e2694c29f9e68bfc84	refs/heads/lead/agents-zsh-trap-scope
0ee75306229216014c62746a77282345578808ec	refs/heads/lead/d051-merge-candidate
25b4ac41307a24d24d2d0db8baa87a869ae84db2	refs/heads/lead/d054-production-logs
0ee75306229216014c62746a77282345578808ec	refs/heads/main
```

| ref | carries |
|---|---|
| `main` | **D-051 LANDED.** Client honours `retryable:false`; classification by type/code, not by `error.message`. Both D-036 arms passed this exact SHA. |
| `lead/d051-merge-candidate` | identical to main; kept as the reviewed-SHA record |
| `lead/d054-production-logs` | production root-cause evidence. **Corrected but NOT re-reviewed since `1802e65`** — Plumb reviewed `1802e65`; `25b4ac4` applies its five corrections and has no arm on it. |
| `lead/agents-zsh-trap-scope` | AGENTS.md zsh-modifier correction + worked example. **No arm.** |

## 2. Gate state

Both arms (Verity exact, Plumb cross-family inversion) passed **`0ee7530` exactly**. Under D-036
**any new SHA reruns both**. The D-047 freeze on deploying `read` still stands. Two rulings made
this session, recorded here because they are not yet in the register:

- **Pooler config and DB-URL secret changes are OUTSIDE the D-047 freeze.** The freeze exists
  because a `read` deploy flips capability advertisement and relation semantics together; a secret
  change does neither, and deployed `read` stays v6. Positive-control that v6 is still deployed
  after any such change.
- **Lowering `max: 4` IS inside the freeze** — it is a code change to all three functions.

## 3. Production — MEASURED vs INFERRED

**Measured (command path):** `EMAXCONNSESSION ... max clients reached in session mode ...
pool_size: 15`, in **56 of 56** `command_request_failure` rows.

**Inferred, NOT measured (read path):** 8,990 `XX000` rows are *consistent* with the same
condition. No Supavisor join exists, and **241 of 9,231** read failures are unattributed even to
`XX000`. Keep this scoped as inference in every artifact until a probe converts it.

**Dead claims — do not resurrect:**
- ~~"cold starts cause it"~~ — `postgres.js` connects lazily; a boot row is not a connection attempt.
- ~~"the read path must log the error message"~~ — **that is a security regression.**
  `read/diagnostics.ts` deliberately deny-lists `message`/`detail`/`hint`/`query`/`parameters`/
  `stack`; tests inject credentials into those fields. The omission is a **control**. The correct
  ask is an **allowlisted `EMAXCONNSESSION` classifier** or bounded redaction, never the message.

**`max: 4` is PER-ISOLATE.** Four live isolates alone reach a 15-connection ceiling.

### Fix order (operator)

1. **Raise `pool_size` in the dashboard** — reversible, no deploy, no compatibility argument needed.
2. **Then, separately, point the DB URL at the transaction pooler.** `SWARM_DATABASE_URL` overrides
   `SUPABASE_DB_URL` — identify the active key and verify host/port **without exposing the URL**.
   Transaction compatibility is corroborated by two independent audits (`prepare:false`,
   `db.begin` + `SET LOCAL`, no `LISTEN`/advisory locks/temp tables/cursors) but is a **source
   argument**: local config has the transaction pooler disabled, so nothing has executed through it.
3. **Never `max:4` yet** — D-047 freeze, and it mostly relocates queueing under session mode.

### Verification protocol — client-side, because the command path under-logs

1. **Baseline immediately before:** 30 solitary authenticated requests (expect ~50% fail), one
   concurrency-8 round (expect ~75%), unauthenticated control (expect clean 401s).
2. **Same probe within minutes after.** Success = solitary ~0, concurrency-8 near 0, control
   unchanged.
3. Check for new `EMAXCONNSESSION` rows after the window.
4. **If the probe does not move, revert.** That outcome also falsifies the read-path inference.

Whatever failure rate remains after the fix **is** the 241's population. Report as "command path
measured fixed, read path fixed-by-probe, residue of N under investigation" — never "production
fixed."

## 4. Release state — corrected

**v0.1.6 IS ALREADY SHIPPED.** Published 2026-08-05T12:19Z, and commonswarm.com/download pins
`CSWARM_VERSION=0.1.6`. It is the **pre-fix** binary. There is no 0.1.6 release to hold.

What is being held is the **unversioned veto build** now on main, which will be 0.1.7. Leaving
pre-fix 0.1.6 in the field is correct — its infinite-retry behaviour is degraded-but-alive, and the
pooler fix helps every fielded binary with no release at all.

**Release condition for 0.1.7 — both, not either:**
1. pooler fix verified by probe, **and**
2. follow-loop **bounded recovery landed through both arms**.

Bounded recovery is not optional and not sequenced around the veto — it ships **with** it. Reason:
D-054's server-side default (`retryable:false` for anything unclassified) is frozen behind D-047 and
will still be live when 0.1.7 ships, so the next unclassified server error would mass-kill
naked-veto receivers. D-054 already calls bounded supervision "the load-bearing safeguard rather
than a nicety." The CLI follow loop has **no supervisor** (D-056's gap).

## 5. Lanes off main, neither started

- **D-056 REOPENED.** Its resolution wrote its own falsifier — *"if `retryable:false` turns out to
  name a genuinely permanent ceiling, dying immediately is correct"* — and the logs resolved it the
  other way. Pooler exhaustion is transient. The original reasoning is kept intact beneath the
  REOPENED marker: it was correct against the facts it had, and what changed is the facts.
- **Transport write boundary.** `notify`/`respond`/`respondError` call `writeFrame` with no
  `asAcpHostError` catch, so a synchronous writable throw yields `code === null`. **Production
  reachability explicitly unestablished** (Plumb). If established, it becomes a live defect.

## 6. Traps most likely to be lost

- **"Zero retries" will be ambiguous after this ships** — it can mean *honoured* or *dead*. Any
  post-deploy measurement must distinguish them (Verity, D-052).
- **`read/diagnostics.ts`'s field omission is a control, not an oversight** (§3).
- **`max: 4` is per-isolate.**
- **A disabled protection is worse than none.** Ruleset `swarm-1human-main` is **disabled** and
  `main` reports "Branch not protected" — see §7.
- **The zsh revision trap returns a *persuasive* value, not an error.** A reviewer got the merge
  *commit message* instead of `engine.ts` and grepped plausible non-zero counts from it. Caught only
  because two of its own results were mutually impossible. Brace every revision-with-path.

## 7. For the operator

**Ruleset `swarm-1human-main` is DISABLED.** It was believed to enforce deletion, non-fast-forward
and linear history with zero bypass actors. `main` sat at `20cd969` all day, so there is no evidence
of harm — but any seat with push credentials could force-push or delete `main`, and roughly a dozen
seats have credentials. Only the GitHub audit log can answer when it was disabled and by whom.

**Recommendation: re-enable it WITHOUT `required_linear_history`.** Keep deletion and
non-fast-forward — those are the load-bearing parts. Linear history is in permanent tension with
D-036: it forces every landing through a rebase, every rebase is a new SHA, and every new SHA costs
two review arms. If linear history is wanted anyway, the workflow must become "rebase first, review
the rebased SHA," and everyone should know the gate just got permanently more expensive.

## 8. Corrections still owed

- The D-056 evidence correction noted in D-057-REOPENED: the "single predicate" claim is now false
  on `2b5e905`. **Not landed.** Named here so it does not die with this context.
- `lead/d054-production-logs` @ `25b4ac4` and `lead/agents-zsh-trap-scope` @ `5c98b24` have **no
  review arm**. Both are docs-only. Either gate them or land them deliberately as ungated docs.

## 9. Why there is a handoff

This session's failures were **allocation and relay, not rigour**. The review machinery worked —
the inversion arm caught a security regression in the Lead's own recommendation, and D-056 was
reopened by its own falsifier. What degraded was a coordinator moving state between contexts:
a stale-SHA relay made twice, a misread of its own grep output, and a security-regression
recommendation published before review. The successor should be a **fresh seat reading the register
and this file cold**, not a compacted continuation of the outgoing context, which would inherit the
confusions along with the facts.
