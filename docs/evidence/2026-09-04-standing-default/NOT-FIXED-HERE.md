# Two things measured on the standing-grant lanes and deliberately NOT fixed

Written 2026-09-04 from `lane/standing-default-followup` (four commits on `e433fd9`). Every
line number below was resolved against the tree AS OF `e433fd9`, not against `origin/main` —
that lane inserted ~275 lines into `supabase/functions/command/index.ts`, which shifts every
citation past it. `tests/p1-cli/citation-drift.test.ts` now fails when any citation this lane
makes stops pointing at what it claims. Both are real, both were reached and read, and neither is a defect this lane
introduced. They are recorded so the next person does not re-derive them.

---

## 1. A new CLI against an old server cannot honestly say "the server is too old"

**Symptom.** `cswarm grant resume` against a deployment whose `command` function predates
`resume_renewal_grant` prints `command failed (HTTP 400): invalid_request`. The reader is told
their request was malformed when the truth is that the deployment does not know the verb.

**Why it was not fixed in the CLI.** The wire cannot distinguish the two. `{"error":
"invalid_request"}` at HTTP 400 is returned from roughly ten independent paths in
`supabase/functions/command/index.ts` — among them `:1234`, `:1259`, `:1261`, `:4184`, `:4203`,
`:4374`, `:4392`, and the per-command `invalid` results at `:4958` and `:5095`. An unknown
command kind and a genuinely malformed body produce the identical body and status.

A CLI-side fix would therefore have to infer "old server" from a generic 400 on a verb that
happens to be new. That is branching on a presentation-layer signal to decide a semantic
question, which is what **D-053** exists to forbid: classify with a named error class, a stable
code we assign, or our own state — never a caller's prose or a shared generic code.

**What a correct fix looks like** (a server change, so it belongs to a lane that owns the edge
and needs its own D-036 arms). Either:

- have the command function answer a distinguishable code for an unrecognised command kind —
  e.g. `{"error": "unknown_command_kind"}` — which the CLI can map to "this deployment is older
  than this cswarm; upgrade the deployment or use an older client"; or
- have the CLI preflight against `min_client_version` / a capability list before sending a verb
  it knows to be recent. The resume handler already reads `min_client_version` out of
  `swarm.config` (`index.ts:5656-5676`) and returns it on success, so the value is already on
  the wire — it is simply not consulted before the fact.

The first is smaller and is what makes the CLI's message honest for every future verb, not just
this one.

---

## 2. WITHDRAWN — the mint response and the grant row use the SAME instant

**This section previously claimed a defect. The claim was wrong. It is kept, with its reasoning,
because a withdrawn finding that vanishes gets re-filed by the next reader.**

### What was claimed

That for a timeboxed grant the horizon is computed twice from two different clocks — the stored
row from `token.issued_at` (`supabase/functions/command/index.ts:4066-4070`) and the accepted
response from a separate `now` (`:7803-7808`) — so the value a client is told could differ from
the value in the database.

### Why it was believed

A review arm reported it as "a data integrity mismatch ... violating the invariant that the
returned artifact must exactly match the stored row", and the two expressions do read
differently at a glance. It was written down without tracing where `token.issued_at` comes from.
That is the error: two identifiers that differ in spelling were treated as differing in value.

### What was actually measured

`token.issued_at` **is** `now`. The full chain, each link read on this tree:

1. `index.ts:7431-7434` — `now` is read ONCE per request, from a single
   `SELECT ... statement_timestamp()`.
2. `index.ts:7444-7453` — that same `now` is passed into `prepareWorkspaceCommand`.
3. `index.ts:2932-2934` — it becomes `ctx.now` on the `WorkspaceDecideCtx` verbatim.
4. `src/protocol/workspace-commands.ts:951-961` — the reducer emits `AgentTokenMinted` with
   `issued_at: ctx.now`.
5. `index.ts:3638-3641` — `projection` is `prepared.state` folded with those very events, so
   `projection.tokens[...].issued_at` is the event payload's value, not a database re-read.
6. `index.ts:3994` — `token` is that projection entry. Hence `token.issued_at === now`.
7. `index.ts:7710` and `:7740` are the only reassignments of `now`, and both are gated on
   `accept_invitation` and `renew_agent_token` respectively. **Neither is reachable on a mint.**

So `token.issued_at + renewal_horizon_ms` and `now + renewal_horizon_ms` are the same number.
The comment at `index.ts:4057-4060` — "Measured from the token's own issued_at rather than a
wall clock read here, so the grant and the credential it authorises start from the same
instant" — is describing exactly this, and it holds.

### What this means for the change

It strengthens it rather than qualifying it. `site/src/lib/agent-connect.ts` now reports the
horizon the server sent, and that value is provably the same instant as the one in
`swarm.renewal_grants.horizon_expires_at`. The retired code — `issuedAt + a 30-day constant the
page owned` — shared the row's BASIS while being free to be wrong about the LENGTH. The new code
is right about both.

**Nothing to fix, and nothing for a later lane to pick up.** Do not re-file this.

## Also not this lane's, and a note on how that was measured

The two site tests `the account menu paints in DOM order and stays on screen at phone widths`
and `the live feed header stays compact and the narrow composer stays in view` failed in every
run this lane made, after `rm -rf dist && npm run build`. They are real-Chrome geometry checks.

**They pass on an idle host.** The lead re-ran the suite quietly and measured **277/278 with 0
failures**; this lane, running alongside three others plus a local Supabase and two review arms,
measured **275/278 with those two failing**.

The instrument matters more than the result here. This lane concluded "not ours" from the fact
that the failing SET was identical to `e433fd9`'s own baseline — which was the right conclusion
reached with the wrong instrument, because BOTH runs were loaded. Identical failures on two
loaded runs is evidence of load, not evidence about the branch. AGENTS.md already records this
exact shape: a CI green on a loaded host is not the same test as a CI green on an idle one, and
timeouts with no assertion errors are a contention signature. The honest statement is: they are
timing-sensitive under load and pass when the host is quiet.
