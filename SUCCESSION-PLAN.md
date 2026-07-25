# cloud-swarm — Lead succession & build plan

**Read this first if you are a new Lead.** This is the durable baton-pass for the
cloud-swarm build. It is version-controlled so every Lead updates it before
rotating out. If you are picking this up, you are the current Lead — adopt the
succession protocol below for yourself.

---

## 0. The succession protocol (do this for yourself too)

The operator's standing rule: **when your context reaches ~60% utilization or
more, rotate out.** To rotate:

1. Get the current phase to a **clean, committed, green checkpoint** (never hand
   off mid-file or on red tests).
2. **Update this file** — status, what's done, what's next, any in-flight work
   (background reviews, dispatched agents) with how to collect their results.
3. Commit it. Then spawn / designate a **fresh Lead** and point it at this file,
   or tell the operator you've hit the rotation point and P<n> is a clean
   checkpoint for the next Lead to resume from.
4. The successor Lead **inherits this same protocol.**

Rotate at a **phase boundary** whenever possible — it's the cleanest resume point.

**New Lead, first actions (do these before picking up the phase):**
1. **Enable remote connection** — run **`/remote-control`** so the operator can
   supervise and drive this long-running autonomous build remotely (operator
   directive). Confirm it's active.
2. Read this whole file + `docs/design/SWARM-CLOUD.md` §0 (ethos) and the current
   phase's spec section.
3. Check for in-flight background workers (see §4 status) and collect their results
   before starting new work.
4. Re-read §1 — **you orchestrate, you do not hand-code.**

---

## 0c. WORKER ROTATION HYGIENE (operator directive, 2026-07-24)

The §0 rotation rule applies to **workers too, not just the Lead.** Watch each long-lived
worker's context window and **compaction-cycle count**, and rotate it out for a fresh agent
before it degrades.

**Why it matters:** every compaction loses fidelity, and a worker can look perfectly healthy —
reporting precisely, catching real spec bugs — while its early context is heavily summarized.
The failure mode is handing the *most detail-dense* work to the *most degraded* context.

**Measure, do not guess.** For a Codex worker the transcript is
`~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl` (the swarm task record prints the sessions
dir). Find the live one by grepping for the current task slug, then check size, line count, and
`grep -ci compacted`.

**Observed datum:** Mason was rotated at **14 compactions / 11 MB / 5,416 events / ~24 h
continuous** — while still performing well. Treat roughly **≥10 compactions or ≥12 h
continuous** as due.

**Rotate at a task boundary, or at the very start of a slice.** Cost is near-zero before
implementation begins and climbs steeply once the worker is mid-file.

**Capture the outgoing worker's non-obvious knowledge first** — architectural seam analysis,
traps found while mapping the code — as a durable on-disk handoff note for its successor, then
stand it down. Do not discard mapping work merely because the agent is rotating. Frame it to the
worker as hygiene, not judgement, and record what it contributed.

## 1. Model & delegation policy (operator directive)

- **THE LEAD DOES NOT HAND-CODE.** Fable credits are **dangerously low** and the Lead
  session burns them. Your job is orchestration: decompose, delegate, review,
  commit, coordinate — **never write/verify implementation code yourself.** Assign
  ALL coding to a **Codex CLI** worker or a **Kimi K3** agent and review their output.
  (A prior Lead violated this by hand-editing the core; do not repeat it.)
- **Lead role = Fable-class** (scarce; **reserved for Leads only**). You are the Lead.
- **Workhorse implementation → Codex CLI** (edits + runs tests):
  `codex exec -C <git-dir> -s workspace-write --skip-git-repo-check -m gpt-5.6-sol
  -c model_reasoning_effort=xhigh "<prompt>"`. For review-only use `-s read-only`.
  Always prepend the "do NOT invoke any skill/SKILL.md" override, or Codex gets
  hijacked by gstack skills. Give a precise spec + "get to green (tsc + tests)".
- **Fable-class *reasoning/review* work → Kimi K3** (fable-adjacent), NOT Fable:
  spec/design authoring, adversarial correctness/security review, hard reasoning —
  `opencode run --pure -m openrouter/moonshotai/kimi-k3 --dir <repo> "<prompt>"`.
- **Coordinate via the swarm** (stable `~/Developer/Ridge.io/swarm` CLI): track work
  as swarm tasks, spawn/assign workers, review with evidence. The Lead reviews and
  integrates; workers implement.
- **Provisioning / anything you'd ask the operator to do** (create Supabase project,
  GitHub App, OAuth grants, DNS, deploys, entering credentials) → **delegate to the
  OpenClaw and Hermes A2A agents** (they act with the operator's authority; they are
  registered A2A agents reachable via the swarm). Do NOT enter credentials yourself.
- **Dispatch hygiene:** never `nohup ... &` inside a `run_in_background` Bash call —
  it orphans the child. Let the tool own backgrounding. Codex needs a git-repo
  workdir (`--skip-git-repo-check` if not). Strip ANSI from opencode logs
  (`sed 's/\x1b\[[0-9;]*m//g'`). **`swarm send` to Mason[codex] MUST use `--now`** —
  the default single-Enter queue leaves the message unsubmitted in his composer
  (observed 2026-07-24: two briefs sat undelivered ~2h; `--now` landed instantly).
  Verify delivery with `swarm read Mason` (composer shows "Working…"), not just "Message sent".

## 0b. CURRENT TARGET (operator, 2026-07-23): drive to the FIRST REAL DOGFOOD

**The near-term goal is not "finish P1" — it is the first moment the operator can
drive a fleet through the cloud-authoritative command path end to end.** Build to that,
stop, let it be used, then plan P2+ from what it teaches. The operator has authorized
**rotating to a fresh Lead whenever context gets tight** — do it at a clean green
boundary, update this file first, `swarm spawn -s cloud-swarm --agent claude --name Lead`.

**Dogfood = ALL of these exist and are proven working together:**
1. schema APPLIES on hosted Supabase (see build-state below — currently FAILING)
2. `handle_command()` Edge Function wrapping the pure `decide()` — DOES NOT EXIST
3. PKCE login + a CLI client that sends real commands — DOES NOT EXIST
4. the §9 launch-gate tests proven GREEN against the real database — NOT RUN
Until all four, there is nothing to dogfood; do not stage a fake one (hand-poking the
DB with psql is theater, not a dogfood — it teaches nothing about whether the feel is right).

### P1 BUILD STATE (update this every slice)
- **RUNTIME NOW AVAILABLE:** OrbStack/Docker 29.4.0 installed + running; local Supabase
  stack works (`supabase start` / `supabase db reset` apply cleanly). The §9 suite is
  unblocked. Apply migrations via the normal CLI — the earlier "CLI can't apply" theory
  was WRONG; it was the segfault (below) all along.
- **SLICE 1 — schema: DONE + VERIFIED ON REAL POSTGRES (commit 30538b9).** Applies
  from-scratch + idempotent; 24 tables / 9 read views / 24 RLS / 24 swarm_command
  policies / owner=swarm_admin / 0 anon-auth policies / events+audit_log append-only /
  2 cron. Evidence: `docs/evidence/p1-schema-apply.md`. **Landmine learned:** NEVER
  `GRANT <role> TO current_user` — it SIGSEGVs PG16 (crash presents as a dropped
  connection on every transport; only the local runtime surfaced it). Use
  `DO $$ BEGIN EXECUTE format('GRANT <role> TO %I', current_user); END $$;`.
- **SLICE 2 — command API: DONE + VERIFIED (commit `d825fb2` on main; Mason[codex]
  built, Lead2 verified by re-execution 2026-07-23).** The `command` Deno Edge Function
  (`supabase/functions/command/index.ts`, 1582 lines) holds ONE Postgres tx as
  `swarm_command`, runs the §3.2 15-step order, and calls the UNMODIFIED
  `applyCommand()`/`decide()`/`reduceTask()` for the 8 P0 task commands. The core is
  consumed as `supabase/functions/_shared/protocol.js` — an **esbuild bundle generated
  from `src/protocol/index.ts`** (`npm run build:command-core`; regenerated by
  `pretest:p1-server`). Independent verification (evidence: `docs/evidence/p1-command-api.md`):
  src/protocol UNTOUCHED (empty diff); bundle byte-identical to fresh regen = **zero
  drift**; `tsc` clean; P0 `npm test` 38/38; `test:p1-server` **7/7 GREEN on the live
  local stack** (T-01/02/03/05/06/10/11 + unknown-task pin; T-10 = 50 race iters, one
  winner); I1–I5 asserted via frozen-core fold. Scope per decisions #62–#65.
  **DEFERRED to slice 2b:** T-04 grant double-spend + T-07 revoke-mid-flight tests;
  §3.4 workspace-authority commands (currently seeded via service_role fixtures); rate
  limiting (§6). **Slice 3:** real PKCE login + CLI client. **Still open for dogfood:**
  hosted-Supabase apply of the command fn (item #1 — local-stack verified only).
  Build-order that produced this: `docs/design/P1-SLICE2-BRIEF.md`.
- **SLICE 3 — login + CLI (IN FLIGHT; operator-chosen next, 2026-07-23; Mason[codex]
  holds `p1-login-cli` lease).** `swarm login` = PKCE + GitHub OAuth via GoTrue, loopback
  `127.0.0.1:<random port>/callback`, `state` verified both paths; refresh token in OS
  keychain (headless fallback 0600-in-0700 + loud warning, hard refusal below); a THIN
  CLI sending the 8 P0 commands to `POST /commands` (slice-2 wire + decision #64 response),
  accepting a login JWT OR a seeded `swm_agt_` token; logout/devices → `revoke_device`.
  **DEFERRED:** all §8 local-first cache/outbox/replay (thin client only for first
  dogfood); §3.4 workspace commands (fixture-seeded — see the "fixture bridge" in the
  brief). Env-parametrized `--url`/anon-key: develop on LOCAL, dogfood on HOSTED.
  Build-order: `docs/design/P1-SLICE3-BRIEF.md`.
- **TRACK B — hosted provisioning (operator-chosen dogfood target = HOSTED
  `ukezjcnxjvkpkeezxaew`; Lead-driven via Anvil/Forge, NOT Mason).** Needed for the real
  dogfood, runs parallel to slice 3. Steps, each **independently verified** (landmine §3):
  (1) apply the P1 schema migration to hosted (Anvil: `supabase link` + `db push`; verify
  via `gh`/`psql`/REST that 24 tables exist); (2) deploy the `command` Edge Function to
  hosted (`supabase functions deploy command`); (3) ADD redirect allowlist entry
  `http://127.0.0.1:*/callback` (currently EMPTY — gap #6; path segment mandatory, `*`
  won't cross `/`); (4) stand up the **GitHub OAuth provider** in hosted Auth (create a
  GitHub OAuth app; client id/secret → Supabase Auth; secrets → 1Password only). Then
  hand Mason the hosted URL + anon key. **NOT STARTED as of this checkpoint.**

### (historical build state below)
- **Slice 1 — schema.** Migration `supabase/migrations/20260723000001_p1_schema.sql`
  (751 lines) written + committed (`e3b0ccd`), independently audited (24 tables, 24
  swarm_command-only policies, append-only triggers, no anon/authenticated grant on
  authority tables). **FIRST REAL APPLY FAILED** at statement 2:
  `must be able to SET ROLE "swarm_admin"` — hosted Supabase runs migrations as
  non-superuser `postgres`, which cannot `SET ROLE`/`OWNER TO`/`AUTHORIZATION` a role
  it isn't a member of. Fix in flight (Codex): `GRANT <role> TO current_user` after
  each `CREATE ROLE`, full idempotency, and — importantly — a ONE-PASS enumeration of
  ALL other hosted-Supabase incompatibilities (pg_cron/`CREATE EXTENSION`, event
  triggers, `ALTER SYSTEM`, `auth.*` ownership) so we don't burn one apply-cycle per
  failure. **The design must NOT be weakened to pass** — owner-pinned views (§2.3) need
  owner-evaluated predicates; do not let everything fall to `postgres` ownership.
  Apply route: **Anvil** runs `npx supabase link --project-ref ukezjcnxjvkpkeezxaew`
  (password from 1Password) then `npx supabase db push`; on failure capture the exact
  error and STOP, do not let the agent self-fix. `supabase/.temp/` holds link state
  (gitignored, no secret) — verified.
- **Slice 2 — command API.** `handle_command()` per §3: TS orchestrator in a `command`
  Edge Function, one Postgres transaction, calls unmodified `decide()`. NOT STARTED.
- **Slice 3 — login + CLI.** PKCE loopback (`http://127.0.0.1:*/callback`; the
  allowlist entry must be ADDED to the project — currently empty), keychain refresh,
  a CLI that sends commands. NOT STARTED.
- **Gate — §9 tests** green against the real DB. NOT RUN. Needs a container runtime
  eventually (`supabase start` + Edge Functions) — not available on this machine yet;
  operator will need OrbStack/Docker or we run the suite against the remote dev project.

### ★ 2026-07-23 LATE: THE §0b DOGFOOD IS ACHIEVED + VERIFIED (commit `ca836f6`)
All four dogfood items are DONE — see `docs/evidence/p1-first-dogfood.md` (read it; it
also records the fabricated-Anvil-readback catch and the Track B landmines: aws-0 pooler
host from the Management API, 6543-needs-prepare:false, transient op-session drops, where
every credential lives in 1Password). Real human GitHub PKCE login (gap#6 wildcard proven
at port 53493), seeded workspace, agent-token cradle-to-grave vs hosted with replay +
domain pin, verified at the event_id level via canary re-query. **Slice-3 final acceptance LANDED** (keychain fix `7736258` verified: tsc clean, P0 38/38,
CLI 13/13, clean hosted login/refresh/logout re-proof; task `p1-login-cli` closed merged,
decision #76).

### ROTATION 2026-07-24 (Lead2 → successor). OPERATOR DIRECTIVE: "rotate and continue."
State at handoff: HEAD `7736258` on main, tree clean, everything pushed; all tasks closed;
Mason [codex] idle+warm with full slice 1–3 context. **YOUR TASK: SLICE 2b** — make the
authority real by replacing the fixture bridge:
1. **§3.4 workspace-authority commands** via `decideWorkspace` (new pure module, same
   wrap-don't-fork pattern as `decide()`): priority order = `create_workspace` (operator-
   allowlisted), `create_agent_principal`, `mint_agent_token` (§2.3 denylist + TTL caps —
   this retires the seed script's token minting), `invite_member`/`accept_invitation`
   (atomic consumption), `revoke_agent_token`/`revoke_agent_principal`. Repo
   mapping/landing authority can trail (P2-adjacent).
2. **Remaining launch-gate tests**: T-04 (grant double-spend), T-07 (revoke-mid-flight,
   needs the test hooks), T-08/09/12; then T-13–T-25 as capacity allows. The §9.0
   invariants harness already exists in `tests/p1-server/`.
3. **Rate limiting** (§6, step 4½) + `rate_buckets`; **gap#15 auth-admin module** +
   device endpoints (retires decision #69's deferral).
Start a fresh swarm task per sub-slice; Mason implements, you orchestrate + verify.
(c) operator personally driving the CLI (the felt dogfood) remains QUEUED — solicit their
impressions when they do and fold into P2/P3 scoping; (d) plan P2+ from what the dogfood
teaches (§0b).

### ROTATION 2026-07-24 ~10:45 (Lead3 → Lead4). Goal achieved; operator: "move on to next stage."
Lead3 rotating at the achieved-goal boundary (context deep in the rotation zone). State:
HEAD is the evidence commit + this baton, tree clean, all pushed. **IN FLIGHT: Mason holds
`ux-connect-polish`** (bugs #1–#6 + Kimi 2b-2 FIX-1/3/4/5 + decision #81 pending-command_id,
scope fully pinned in swarm messages + this file) — collect his checkpoint, verify by
execution (tsc + 66/66 + 14/14 + 10/10), review diff, land, then **redeploy hosted**
(`npx supabase functions deploy command` from this machine — linked + authed). **YOUR MAIN
TASK: P2-connect-UX** (previous section) — one-command join, agent-skill layer, read
surface, narrated output. Read §1c feedback FIRST; it governs everything. Then 2b
remainder per §1b. Kimi review logs: scratchpad/kimi-2b1-review.log (FIX(7), folded),
kimi-2b2-review.log (FIX(5) minor: 1/3/4/5 in Mason's task, FIX-2 = rate-limit slice).
Landmines all in §1/§3 + evidence docs; the new one from today: Anvil free-text readbacks
misalign columns — demand strict single-JSON output with exact fields.

### LEAD4 ACTIVE (2026-07-24 ~10:50, baton accepted at HEAD b7a222c).
Lead2 + Lead3 both stood down; Lead4 is sole current Lead. **FIRST ACTION DONE:** collected
Mason's `ux-connect-polish` checkpoint (#001) and **LANDED it** — commit `87e41cf` on main
(+evidence `c662200`, `docs/evidence/ux-connect-polish.md`), task closed merged.
- **Independent verify (Lead4's own execution):** tsc clean; core 66/66; CLI 16/16; server
  11/11 on live local stack; `git diff --check` clean; core-bundle regen = **zero drift**.
- **Hosted redeployed:** `command` Edge fn now **version 4** (ACTIVE 15:53:04 UTC); endpoint
  canary returns the function's own structured JSON (register_device path executes). Deploy
  done BEFORE any new login (register_device moved server-side — Mason's landmine, honored).
- Shipped: bugs #1–#6 + Kimi FIX-1 (device revoked_at + register_device), FIX-3 (invite
  stdin), FIX-4/decision #81 (client pending command_id sidecar), FIX-5 (display_name strip).
- **Residual:** `coswarm --version` standalone flag not wired (version shows in --help header) —
  minor, folded into P2 CLI UX.
- **OPEN FIRST-ACTION (operator):** `/remote-control` — I cannot self-invoke the slash
  command; surfaced to operator to enable remote supervision.
- **★ P2-1 DONE + LANDED + HOSTED (`a823ab3`, evidence `80a1095`,
  `docs/evidence/p2-connect-accept-link.md`, task `p2-connect-accept-link` closed merged).**
  `coswarm accept <invite-link>` collapses the invitee's 4 commands into ONE with
  plain-language narration per step. Hosted `command` fn at **v5** (ACTIVE 18:17:10 UTC),
  deployed BEFORE relinking the CLI (old invite responses lack the label adjunct). Lead4
  independent verify at both checkpoints: tsc, core 66/66, CLI 37/37, server 11/11, zero
  drift, diff-check clean. **Live hosted proof the phishing gate works in the shipped
  binary:** a link with `url=https://evil.example.com` piped to `accept --link-stdin --json`
  → *"unrecognized Cloud host evil.example.com; non-interactive mode refuses before login"*.
  - **Decision #82 — the verb is `accept`, NOT `join`.** `SWARM-CLOUD.md:696` locks "members
    accept invites; agents join swarms"; §7 hardened that split. The baton's colloquial
    "`coswarm join`" was unavailable — this WIDENS `coswarm accept`. Legacy bare `swm_inv_`
    and `--invitation-token-stdin` unchanged + principal-free. **Future Leads: do not
    reintroduce a human `join` verb.**
  - **Decision #83 — optional `--name`, link mode only.** Own live principal → reuse; held by
    another member's live principal OR any revoked row → ONE uniform "already taken", never
    silently renamed (`UNIQUE (workspace_id, name)` is per-WORKSPACE not per-owner,
    `migration:181`). Auto-names may be suffixed (cap 5); user-chosen never. Rejected
    redirect-to-`principal create` (reintroduces friction AFTER membership commits).
  - **METHOD NOTE — the review loop paid for itself four times.** Sable[grok] as a *visible
    swarm tab* (operator directive: reviewers are cmux tabs, never headless one-shots) ran
    brief v1 → **NO-GO** (3 BLOCKING/5 MAJOR incl. the OAuth-phishing vector), v2 →
    **CONDITIONAL GO** (4 MAJOR incl. R1, a false-success path introduced *while fixing*
    round 1), v2.1 → **GO**, implementation → **GO**, fix pass → **GO** (M1, a violation of
    our own §2.4 convergence promise). Every finding was verified against live code before
    folding. Design brief `docs/design/P2-CONNECT-UX-BRIEF.md` v2.1 is the durable artifact.
  - **LANDMINE:** headless `opencode run` for Kimi **hung silently ~2h** with zero output and
    zero credit burn (stream stalled, no timeout). The operator caught it, not us. Reviewers
    must be visible tabs so progress is observable.
- **★ PRODUCT BUG FOUND BY THE HARNESS BEFORE IT EVER RAN (2026-07-24) — MAJOR, user-facing.**
  `src/cloud/auth.ts:410` — `discoverSoleWorkspace` persists a default workspace **only when the
  identity has EXACTLY ONE live membership** (`body.length !== 1 → return null`). Therefore **any
  human who belongs to two or more workspaces cannot invite anyone after a logout**, because
  `invite` needs `--workspace-id` and that flag is the one the operator's felt-dogfood already
  called undiscoverable (**bug #3**). The sole-membership auto-default was a reasonable v1
  heuristic; with additive invites and real multi-tenancy it is now a **trap**. This is not a
  test-harness artifact — a second *real* collaboration triggers it identically.
  - Found by Mason while on read-only stand-down; severity confirmed by Sable.
  - **It currently BLOCKS the uxtest harness at round 1**, not just R2+: identity A already holds
    a live membership from the morning dogfood, and the additive per-round reset adds another, so
    the preflight projected-count gate (current + 1 when unreset) correctly refuses to run.
  - **Rejected fix (do not resurrect):** injecting `SWARM_CLOUD_WORKSPACE_ID` invisibly for test
    rounds. It buys passing rounds on a faked premise and makes the harness lie in the flattering
    direction — secretly supplying the very thing the user could not discover. A visible
    "colleague pastes the project id" variant is allowed **only** as an explicitly labeled
    secondary scenario, never R1's main path.
  - **Report rule:** a round that dies at invite with a null default and count > 1 is classified
    **product: multi-workspace selection**, NOT connect-link UX.
- **NEXT: P2-2 — `coswarm status` read surface + WORKSPACE LIST/SELECT** (members + agents +
  tasks + leases, one screen, plain words). The finding above **expands this slice**: workspace
  visibility and selection are now **load-bearing, not nice-to-have**, because listing is the only
  way a multi-workspace human discovers what to pass. Sable's minimal options — **(A)**
  `coswarm workspaces` / `status --workspaces` plus `coswarm use <id|name>`; **(B)** on invite with
  a null default and n>1, interactive select on a TTY and a JSON list under `--json` for agents;
  **(C)** login re-writes the last-used default when it is still live (partial comfort only, does
  not help a cold multi-member after a credential wipe). **A+B together are what §1c asks for.**
  Doing P2-2 also unblocks the harness as a side effect, so there is no real sequencing conflict.
  This is the other half of the felt feedback ("I flew blind").
  - **NON-INTERACTIVE CONTRACT for option B (pinned before the brief is written — Sable).** B puts
    a prompt in the invite path, and P2-1 just hardened agent mode to never hang, so the same
    discipline is mandatory. **Hard rule: never block on a TTY prompt when stdin is non-TTY,
    `--json` is set, or the process is otherwise non-interactive.**
    1. **Resolution order** for `invite` and every workspace-scoped command: explicit
       `--workspace-id` → profile default (if still a live membership) → exactly one live
       membership → if n>1 **and** interactive TTY, optional picker → if n>1 **and**
       non-interactive, **fail closed** with a structured error.
    2. **Non-interactive failure body** (and `--json` stdout): a deterministic machine-readable
       list of `{workspace_id, name, role}` plus one plain-language line pointing at
       `coswarm workspaces` / `coswarm use <id|name>`. No hang, no half-rendered prompt.
    3. **Agents select out-of-band:** list → `coswarm use …` → invite. Do **not** invent a second
       silent env default; `use` is the explicit, inspectable selector.
    4. The interactive picker is a **human convenience only**; tests must cover both the TTY pick
       and the non-interactive fail+list.
    5. Mirror the origin-pin discipline — an unknown multi-member state must never wait forever in
       agent mode.
  - **`coswarm use <id|name>` SELECTION CONTRACT (pinned — Sable).** Workspace names are
    attacker-influencable display strings (we already sanitize them on the accept path, FIX-5
    class), so name-based selection is only safe under strict rules:
    - **Never** slug aliases, prefix matching, or "closest name" resolution. Those are
      confusable-name attacks whose failure mode is **silent wrong-tenant selection** — the worst
      class of multi-workspace bug.
    - An **ambiguous name fails** and lists the collisions; the stored default is left unchanged.
      Selection by **id always works**, including when names collide.
    - `coswarm workspaces` (and any `status` section) shows **name AND full id on every row** —
      never name-only — so a user always has an unambiguous copy-paste target.
    - Required tests: use-by-id; use-by-unique-name; ambiguous name → fail + list, default
      unchanged; id works when names collide; foreign/unknown id → fail with **no profile write**;
      confusable names that sanitize to the same string → treated as ambiguous when both are live;
      `--json` shapes for list and for use-errors (deterministic, no prompt); non-TTY never blocks.
  Then P2-3 agent-skill layer (the §1c endgame: the user's own agent drives coswarm), P2-4 invite
  page + `https://` link form. Same loop: brief → Sable adversarial review → Mason implements
  → Lead verifies by own execution → land → redeploy. Mason + Sable both warm.
- **★ DECISION #84 (operator, 2026-07-24): OPTION A — fix the product, do NOT revoke.** Faced with
  (A) do the expanded P2-2 multi-workspace fix now vs (B) authorize a narrow destructive revoke of
  today's test memberships to get a uxtest pilot round sooner, the operator chose **A**. So: the
  `auth.ts:410` multi-workspace bug is fixed as a real product change, no destructive hosted write
  is authorized, additive-only reset stands, and **the uxtest harness stays blocked until the fix
  lands** — at which point it unblocks as a side effect. Rationale worth preserving: the bug is
  user-facing (any second real collaboration hits it), so fixing it serves users rather than
  merely serving our test rig.
- **OPERATOR ACTION OUTSTANDING:** drive `coswarm accept --link-stdin` as a second human with
  a **distinct verified email** (lesson #5) — the real test of whether P2-1 *feels* simpler.
  Solicit impressions and fold into P2-2+ scoping (§1c is a living calibration datum).

### LEAD3 ACTIVE (2026-07-24, baton accepted at HEAD 7bf5f6f). Slice-2b decomposition:
Lead2 stood down; Lead3 is current Lead. Sub-slices (each: build→green→Kimi K3 review→commit):
- **2b-1 (IN FLIGHT — Mason holds `p1-slice2b-core`):** pure `decideWorkspace` core. Three new
  sibling modules `src/protocol/workspace-{events,commands,reducer}.ts` + index export, mirroring
  the P0 pure pattern. Commands: create_workspace, invite_member, revoke_invitation,
  accept_invitation, remove_member, change_role, create_agent_principal, revoke_agent_principal,
  mint_agent_token, revoke_agent_token (§3.4 table, P1-COMMAND-API.md:399). Unit tests in
  `tests/protocol-workspace.test.ts`. Pure/no-I/O; token material+hashing + atomic invite
  consumption are 2b-2's job. Deferred here: renew_worker_token, repo mapping, landing authority,
  issue/revoke_grant, register/revoke_device.
- **2b-2 (NEXT):** wire decideWorkspace into the `command` Edge Function (projection loader,
  routing, atomic invite consumption under head lock, token material/hash on I/O side); **retire
  `src/cloud/seed.ts` fixture minting**; local integration tests.
- **2b-3:** launch-gate tests T-04 (adds issue_grant/revoke_grant + grant-consumption), T-07
  (needs test hooks), T-08, T-09, T-12.
- **2b-4:** rate limiting §6 + `rate_buckets`; gap#15 auth-admin module + device endpoints.
OPEN FIRST-ACTION: `/remote-control` (operator-supervised remote drive) — I cannot self-invoke
the slash command; surfaced to operator to enable.
- **RENAME (operator-ordered, landed `981db90`):** CLI is now **`coswarm`** (single bin;
  `swarm`/`swarm-cloud` bins killed; keychain `io.ridge.coswarm`, storage key `coswarm-<profile>-auth`,
  headless dir `~/.coswarm/credentials.d` — did NOT touch swarm.* schema, swarm_command/swarm_admin,
  swm_agt_, or spec branding). npm-linked globally. Renamed inside the zero-credential window.
- **TODAY'S GOAL (operator, 2026-07-24 AM): two humans connect their agents cross-internet
  via hosted coswarm, ASAP.** 2b-2 re-scoped to the CONNECT LOOP only: Edge-fn wiring +
  CLI verbs for invite_member / accept_invitation / create_agent_principal /
  mint_agent_token; deploy hosted; live 2-human E2E. Deferred to after: remove/change_role
  + revoke wiring, rate limiting, devices, T-04..12, create_workspace wiring.
- **★ 2026-07-24 ~10:31: TODAY'S GOAL ACHIEVED — TWO HUMANS' AGENTS CONNECTED ACROSS
  THE INTERNET VIA HOSTED COSWARM.** Full governed chain, operator-driven, verified at
  the event level: see `docs/evidence/p1-two-human-connect.md` (uids, seqs, event ids,
  7 field lessons, residual notes). Human A `d37e2ff2` (mini) invited; human B
  `919ce195` (M1 Max, distinct-email GitHub) accepted invitation `345ad183` (seq 7/8);
  B's principal `laptop-agent` `5103ae10` minted the FIRST governed agent token on
  hosted and ACQUIRED A's task `first-connect` (seq 12 `LeaseAcquired`, triple-stamped).
  E2E gate LIFTED post-achievement → Mason begins ux-connect-polish (bugs #1–#6 +
  Kimi 2b-2 FIX-1/3/4/5, decisions #81). Then 2b remainder: revoke wiring (+ fixture
  token cleanup #79d, epoch-binding enforcement), rate limiting §6 (Kimi FIX-2),
  T-04..12, auth-admin/devices.
- **STATE 2026-07-24 ~10:00: CONNECT LOOP LIVE ON HOSTED.** 2b-1 landed `10d6d0a`
  (Kimi FIX(7) all folded + pinned, 66/66); 2b-2 wiring landed `8b4bc1a` (Lead-verified
  66/66 + CLI 14/14 + server 10/10 on live local stack); migration
  `20260724000001_connect_loop.sql` APPLIED to hosted; Edge fn DEPLOYED to hosted
  (canary good). Tasks p1-slice2b-core + p1-slice2b-connect closed merged. **Method
  deviation, recorded:** 2b-2 committed+deployed on Lead review + test pinning BEFORE the
  Kimi verdict (operator ASAP directive); Kimi fast-follow review in flight
  (`scratchpad/kimi-2b2-review.log`) — findings = immediate fix pass + redeploy.
  **AWAITING:** operator leg-1 (coswarm login + invite), human-#2 designation, Kimi
  verdict. **QUEUED after E2E:** revoke fixture-era seeded null-bound agent tokens (#79d);
  fold operator CLI-feel impressions into P2/P3 scoping (§1c).
- **Decision #78:** invitationMatchesIdentity oracle DELETED (contradicted decision #13 —
  acceptance ignores email; forwarded capability links valid for any verified holder BY
  DESIGN). consumed_by binds from ctx actor only. Forwarded-invite is a positive test.
- **Decision #79:** projection WorkspaceAgentToken.task_id/epoch loosened to nullable
  (must represent legacy null-bound seed rows); mint command/event stays required (#77).
  Fixture-era seeded tokens get revoked once connect-loop is proven on hosted.
- **Decision #80 (connect-loop wiring, a–f):** invites hardwired role=member, TTL default
  24h cap 7d; normalized email stored on swarm.users at login bootstrap (best-effort
  invite-time check; real guard = accept-time user_id); agent_runs row created at MINT
  time server-side (same tx, bound to principal + authenticated device from stored login
  profile) — principal create returns principal_id only; default mint scopes = the 8 P0
  task commands, no --scope flag; raw token/invite material is a fresh-response-only
  adjunct (never StoredResponse/ledger/audit/events; replay omits it; lost delivery →
  mint anew); accept failures are outwardly UNIFORM (unknown-hash = audit-only 403;
  valid-hash expired/consumed/revoked commit internal domain rejection but return
  identical status+body — no-enumeration).
- **Decision #77 (2b-1 interfaces):** accept_invitation carries `{token_hash}` ONLY (no
  invitation_id — client must not steer row selection); remove/change_role take optional
  `landing_authority_successor_user_id` + injected `landingAuthorityChangeResolved` oracle
  (unresolved → domain 'landing_authority_unresolved'); mint_agent_token REQUIRES
  run_id/task_id/epoch (no broader binding offered in P1), ttl_ms default 1h / hard cap 8h;
  §2.3 denylist is INTRINSIC (hardcoded in pure module), humanRights(actor) is injected.

## 0d. ROTATION 2026-07-24 ~20:00 (Lead4 -> Lead5). READ THIS FIRST.

Lead4 rotating at a clean boundary: everything landed and pushed, tree clean, HEAD `a62823a`,
round 1 blocked only on a **human action on the laptop** (below). Nothing is mid-file.

### What shipped under Lead4
- **ux-connect-polish** (`87e41cf`) + hosted fn **v4** — felt-dogfood bugs #1-6 + Kimi minors.
- **P2-1 `coswarm accept <invite-link>`** (`a823ab3`, evidence `80a1095`) + hosted **v5**. One command
  collapses login->accept->principal. Decision **#82**: the verb is `accept`, NOT `join` —
  `SWARM-CLOUD.md:696` locks "members accept invites; agents join swarms". Decision **#83**: optional
  `--name`, link-mode only. Live proof the origin pin works in the shipped binary: a link with
  `url=https://evil.example.com` is refused **before login**.
- **P2-2 `coswarm status` / `workspaces` / `use`** (`053e972`, evidence `10bf782`) + hosted migration
  `20260724000002`. Fixes the **MAJOR** multi-workspace bug (`auth.ts:410`) the harness found before
  it ever ran a round.
- **★ Second root cause of bug #3, found at deploy time:** hosted PostgREST never exposed
  `swarm_read`, so every CLI read returned 406 and `discoverSoleWorkspace` swallowed it — workspace
  discovery had been failing **invisibly on hosted since slice 3**. Fixed by
  `PATCH /v1/projects/{ref}/postgrest`. **Never `supabase config push`** — see §3 landmine.
- **uxtest cross-machine UX harness** (`9d4fde0` + 6 hardening commits through `a62823a`).

### The harness: ONE human action away from round 1
State: preflight passes all gates; fresh hosted workspace **`uxtest-r1-92cb361a`** seeded (additive);
both machines on identical bundle `f12b47b8...`; Human1 logged out; **Dana** (launcher) live on the
laptop in cmux. Blocked on the **GUI-ORIGIN RULE** — run this **inside Dana's laptop cmux tab**:

```bash
UXTEST_HOME_ROOT=/Users/tom/uxtest \
  /Users/tom/Developer/Ridge.io/cloud-swarm/uxtest/scripts/serve-human2-gui.sh launcher
```

Then: rerun `preflight.sh 1` -> Dana drains its queued inbox instruction and does the Human2 logout
(`coswarm logout`, local scope only — **never `--all-devices`**, it would revoke identity A) ->
`launch-human2.sh 1` (spawns virgin `Dana-r1`) -> `channel-up.sh 1` -> `launch-human1.sh 1` ->
round runs -> `collect-round.sh 1` -> write `rounds/1/REPORT.md` with the **mandatory §7.7 validity
header**.

### Credentials + identities (already in place, verified)
- `~/.config/uxtest/cloud.env` — `DATABASE_URL` (0600 in 0700). Provided by **Anvil** (the Hermes
  A2A agent on the mini, registered in cloud-swarm). **Lead4 verified it three ways** — file shape,
  URI parse (session-mode pooler on **5432**; the landmine warns 6543 needs `prepare:false`), and a
  live connection. **Never print the value; source the file.**
- `~/.config/uxtest/round.env` — `UXTEST_HUMAN1_UID`, `UXTEST_HUMAN2_EMAIL`, `UXTEST_OAUTH_CONSENT`.
- Identity **A** (mini, owner): `d37e2ff2-2efb-4bdc-b8fb-176ce4bfccbc` / `tom@ridge.io`.
  Identity **B** (laptop, member): `919ce195-4e19-4c89-852b-8f09a4b556d9` /
  `tom.langridge@mediafire.com`. Distinct verified emails — field lesson #5.

### Fleet
- **Quill [codex]** — implementation worker, fresh (replaced Mason at 14 compactions / ~24h; see
  **§0c worker rotation hygiene**, which applies to workers too, not just the Lead). Warm, idle.
- **Sable [grok]** — adversarial reviewer, in a **visible cmux tab** (operator directive: reviewers
  are tabs, never headless one-shots — a headless Kimi run hung ~2h with zero output). Warm. It has
  caught a phishing vector, a false-success path, an unbuildable rule of mine, and a wall-clock
  cheat. **Route every brief through it before implementation.**
- **Atlas [claude]** — research. Delivered `docs/research/AGENT-ORCHESTRATION-UX.md`. **IN FLIGHT:**
  `docs/research/ACP-AND-BUZZ.md` (operator asked "can we do ACP how Buzz does it?"). Collect it.
- **Dana [cmux/claude-code, laptop]** — Human2 launcher, spawns virgin `Dana-r<n>` per round and
  stays out of rounds. Reachable **only** via A2A (18791), never SSH.
- **Anvil [a2a]** — Hermes provisioning agent, holds 1Password. Demand **strict single-JSON**
  replies and verify independently in both directions.

### Operator asks still open
1. The GUI command above (only a human/GUI agent can run it).
2. Drive `coswarm accept --link-stdin` personally as a second human — the felt test of whether P2-1
   is actually simpler (§1c is a living calibration datum, not a one-time note).
3. Read `docs/research/AGENT-ORCHESTRATION-UX.md`; Atlas's sharpest finding is that **nothing** in
   ~100 orchestrators scores well on multi-human AND visibility simultaneously — that intersection
   is our gap, and it is not a UI gap.

## 1b. Governing steer (operator, 2026-07-23) — READ THIS BEFORE SCOPING ANYTHING

**Swarm is primarily about coordination — keep it that way** (the Workbench.md
posture). P1/P2 authority machinery is **scaffolding for** the coordination payoff at
P3 (advisory reservations, messages, board), **not the product**. Build each phase to
the *minimum that unblocks coordination*, not the maximum the spec permits. When a
choice is genuinely ambiguous, prefer the smaller thing that reaches dogfooded
coordination sooner. Resist the pull toward building a general-purpose authority
platform — that is how this drifts into infrastructure nobody asked for. (Applied
already: SPEC GAPS #18 defers snapshot bootstrap to P3, #3 defers claim kinds to P2 —
both real, neither is coordination.)

## 1c. Product vision steer (operator, 2026-07-24, verbatim-adjacent) — governs P2+ scoping

The operator articulated WHY they want this product. Record kept here so every future
Lead scopes against it (it strengthens and extends §1b):

**Why (differentiators):** multiple subscriptions, not API fees (each human brings their
own agents/subscriptions — matches §2.10 per-human-coordinator topology); model inversion
(cross-model adversarial review) + model fusion (cross-model planning/consensus) as a
product capability, not just our build method; frontier harnesses; visibility of each
agent's work; full-swarm on-the-fly tuning/steering while the operator is looking.

**Wants:** human vibing (agents handle tasks/tracking); coordination with project
collaborators; agent-to-agent messaging; org-structure understanding / communications
routing; work visibility (tasks/goals/areas of focus); shared knowledge; "run the
business together"; **map the surface areas and work areas (related repos, related
infrastructure)** — the infrastructure-surface mapping is genuinely NEW vs the spec
(repo mapping §2.11 covers repos only); park as a P3+ design question.

**Interface ruling:** CLI is the NOW interface, not the endgame (Devin-Desktop-like app
or web UI later — collaborators are CLI-native today, so CLI first). **Near-term north
star: nail HUMAN-DRIVEN swarm-to-swarm project coordination with exceptionally great
onboarding + CLI UX.** Appendix C (operator UX spec) is elevated accordingly.

**★ FELT-DOGFOOD FEEDBACK (operator, 2026-07-24, immediately after driving the two-human
connect — THE §1c calibration datum; every P2+ scope decision answers to this):**
1. "**A lot of steps** — I'd like it much simpler. Driving this process **via an agent**
   would help a lot, via skills or something — I don't really want the end user to need
   to do much via terminal."
2. "I **didn't really know what I was doing or why** — I don't understand why there were
   multiple steps; it all felt very technical."
Lead3 reading: (1) = Appendix C §1.c ("connect your agents — the crux") + §2.10
coordinator-as-driving-interface, now operator-confirmed: the END USER's own agent should
drive login/accept/principal/mint; the human states intent ("join Tom's swarm"). (2) =
comprehension-before-commitment (Appendix C invite-page principle) must extend to EVERY
command's output: say what just happened and why in plain language, or collapse the step
entirely. Steps that can't explain themselves shouldn't exist as user-facing steps.

**NEXT PHASE (P2-connect-UX, scoped from the feedback — successor Lead executes):**
1. **`coswarm join <invite-link>` — ONE command** collapsing login→accept→principal
   (auto-named from hostname/user)→ready; each internal step narrates itself in one
   plain-language line. Mint stays automatic at first agent work (already server-side).
2. **Agent-skill layer:** a distributable skill (SKILL.md pattern) so the user's OWN
   coding agent (Claude Code/Codex/any) drives coswarm — the human says "join <link>" /
   "what's happening in the workspace" in their agent chat; the agent runs the CLI.
   This is the §1c "multiple subscriptions" model made real and the endgame for
   "end user shouldn't need the terminal."
3. **Read surface:** `coswarm status` (members+agents+tasks+leases, one screen, plain
   words) — comprehension requires visibility; the operator flew blind today.
4. Invite link carries the workspace context (no --workspace-id anywhere user-facing);
   invite PAGE (even a minimal hosted one) tells the invitee what/who/why in 30s.
DEFER still: rate limiting (before any external collaborator), revoke wiring, T-sweep —
sequence per successor's judgment against §1b (smallest thing that reaches coordination).

**Sequencing implication (Lead3 reading):** slice 2b stays (invite/accept/principals/
tokens ARE the swarm-to-swarm onboarding substrate). After 2b, P2 scoping should target
the minimum two-human coordination loop E2E — second human onboards via invite page →
accept → both see membership/tasks/messages — ahead of deeper authority machinery
(remaining T-13–T-25 sweep, artifact plane, knowledge plane trail behind that loop).

## 2. Method

Build **phase by phase**, each phase: **build → test (green) → model-inversion
review (Kimi K3) → integrate findings → commit** (evidence-gated completion; a
"done" claim needs the artifact — passing tests, a commit SHA). Use **ultracode /
the Workflow tool** for larger phases (fan-out implementers + adversarial
verifiers) — the operator has opted in for this project. Externalize state
continuously (this file + commits) — assume your session can die at any moment.

## 3. Ground facts

- **Repo:** `/Users/yulanbot/Developer/Ridge.io/cloud-swarm` → **remote is
  `Ridge-io/cloud-swarm` (private)**. Note the hyphen: `Ridge-io` is the **org** (team
  plan, where the PromptEden repos live); `Ridgeio` is a free **user** account where
  private-repo rulesets are impossible (403 "Upgrade to GitHub Pro"). The repo was
  created under `Ridgeio` by mistake and transferred; **never target `Ridgeio`.**
- **Ruleset (active):** `swarm-1human-main` (id 19616931) on `refs/heads/main` —
  `deletion`, `non_fast_forward`, `required_linear_history`. `bypass_actors: []`.
- **LANDING POLICY — operator directive, 2026-07-23 (overrides the spec's stricter
  reading):** **the Lead MAY merge PRs and MAY push directly to `main`.** A
  `pull_request` rule was briefly applied and has been **removed**: requiring a PR to
  land your own reviewed work is friction on a *reversible* act (a squash merge is
  `git revert`-able), and §0 says user-facing friction on a reversible act is a bug.
  Do **not** re-impose human-only landing, PR-required, or similar ceremony on the
  Lead. What stays hard is what is genuinely irreversible: **force-push, branch
  deletion, and non-linear history remain blocked** — that is the §0 line, correctly
  drawn. Treat this as standing policy, not a one-off exception.
  (§3's required pre-landing check is a P2 deliverable and does not exist yet.)
- **GitHub App (P0-github, done):** `Swarm Coordination` / slug `swarm-coordination`,
  owned by `Ridge-io`. App ID **4375227**, Client ID `Iv23liD2OXYNeF59mab1`,
  Installation ID **148509807**. Permissions are **read-only** on exactly five scopes
  (checks, statuses, contents, metadata, pull_requests); 0 write. Webhook **disabled**
  (no endpoint until P1). Installed on **`cloud-swarm` only** — not on any PromptEden
  repo. **No private key has been generated yet** — generate it at P1 when the webhook
  needs to authenticate, and have Anvil store it in 1Password (never on disk).
- **Supabase (P1 provisioning):** project `cloud-swarm-dev`, ref
  **`ukezjcnxjvkpkeezxaew`**, region `us-east-1`, org **`ChartingAlpha`** (the paid org —
  the `*-Free*` orgs are junk parking orgs, per operator; do not use them). Costs
  ~$10/mo per-project compute (Micro rate), operator-approved. Secrets live in the
  1Password item **`Supabase — cloud-swarm-dev`** — never in the repo, never in a
  model-visible file. (An earlier ref `pgbblnyljguyfckhdnid` was created in the junk
  `ChartingAlpha-Free2` org and has been **deleted**; it was empty. Ignore it if you
  see it referenced anywhere.)
- **★ ERROR CLASS: testing output that contains more than the thing you meant to test
  (2026-07-24).** Four separate incidents in one day, all the same shape — a probe whose output
  carried extra material, read as if it carried only the signal:
  1. `git show --name-only <sha> | grep docs/research` → matched the **commit message**, which said
     "docs/research/ deliberately excluded". Read as a file-path violation. Use
     `git show --name-only --format=""` when you want paths only.
  2. `command -v cmux` under **non-interactive SSH** → "not found" on a machine where the binary
     exists at `/Applications/cmux.app/Contents/Resources/bin/cmux`. Both Lead and a laptop agent
     made this call in opposite directions. A non-login PATH is not evidence of absence.
  3. A hosted REST read returning **`406` (schema not exposed)** was swallowed by
     `if (!response.ok) return null` and surfaced as *"no workspaces"* — an infrastructure fault
     wearing the costume of empty data.
  4. `grep "not a version signal"` missed the doc line because **markdown bold** (`**not**`) broke
     the literal match — concluding a fix was missing when it was present.
  **The rule:** before believing a negative result, confirm the probe could have produced a
  positive one. Prefer path-only / value-only output modes, absolute paths over `PATH` lookups,
  distinguishing HTTP status classes from empty payloads, and matching on structure rather than
  prose. A grep that can match your own commentary is not a test.
- **★ NEVER run `supabase config push` against hosted (landmine, 2026-07-24).**
  `supabase/config.toml` carries **scaffold defaults** — `site_url = "http://127.0.0.1:3000"` and
  `additional_redirect_urls = ["https://127.0.0.1:3000"]` — while hosted holds the hard-won real
  values: `uri_allow_list = http://127.0.0.1:*/callback` (gap #6, proven at port 53493 in the first
  dogfood) and an enabled GitHub provider. A blanket config push **overwrites the allowlist with
  the scaffold default and breaks PKCE login entirely.** Change hosted config **one setting at a
  time** via the Management API, then re-verify `uri_allow_list` and `external_github_enabled`.
- **★ Hosted PostgREST must expose `swarm_read`, and it silently didn't (2026-07-24).** Every CLI
  read through `accept-profile: swarm_read` was returning `406 PGRST106` on hosted, and
  `discoverSoleWorkspace` swallows it (`if (!response.ok) return null`) — so workspace-default
  discovery had been **failing invisibly on hosted since slice 3**. This was the *second* root
  cause of bug #3 alongside the sole-membership heuristic; fixing only the heuristic would have
  shipped a still-broken hosted experience whose symptom looked identical. Fixed by
  `PATCH /v1/projects/{ref}/postgrest` → `db_schema: public,graphql_public,swarm_read`. Anon stays
  denied via the P1 `REVOKE ALL ... FROM anon` (`:789`); `authenticated` holds USAGE+SELECT
  (`:785-786`). **Lesson: a client that treats every non-ok response as "no data" hides
  infrastructure faults as empty state — when a hosted read returns nothing, prove the schema is
  exposed before believing the data is absent.**
- **VERIFY EVERY PROVISIONING AGENT'S SELF-REPORT — it is unreliable in BOTH
  directions.** Observed 2026-07-23: Forge reported a bare "PASS" for work that needed
  checking, and Anvil reported an unrelated garbled result for a task it had actually
  completed correctly (I nearly recorded a real success as a failure). Confirm with an
  independent read — `gh api`, `curl` the project URL, `git remote -v`, `npm test` —
  before believing either a success or a failure claim.
- **Why a separate repo:** the in-use local `swarm` CLI (coordinating the live
  PromptEden program) builds and runs from **its own working tree**
  (`~/Developer/Ridge.io/swarm`, `dist/index.js`); a broken build there (`rm -rf dist
  && tsc`) would kill the live tool. cloud-swarm is forked so cloud work can never do
  that. **Never build or churn the swarm repo's working tree to serve cloud work.**
- **SaaS domain:** `b9rk.com` (invite/board URLs → `swarm.b9rk.com` or similar; wire
  into the spec's `swarm.<domain>` placeholders when P5/hosting is designed).
- **Spec (canonical):** `docs/design/SWARM-CLOUD.md` — multi-model-reviewed; the §0
  design ethos (*friction is justified only by irreversibility*; smooth UX +
  invisible-but-hard authority) is the interpretive frame. The "It just works
  refactor — review ledger" (R1–R16) records the last review round.
- **Memory:** `~/.claude/projects/-Users-yulanbot-Developer-Ridge-io/memory/` —
  `swarm-cloud-spec.md` (spec status), `tom-operator-visibility-constraint.md`,
  `prompteden-swarm-program.md`. Update `swarm-cloud-spec.md` as you go.

## 4. Phase status

- **P0-local — COMPLETE (built → reviewed → integrated → green → committed).**
  `src/protocol/` = reducer-complete §2.2 authority core (events, reducer,
  commands=`decide()`, idempotency, upcasters), pure/no-I/O. The Kimi K3
  model-inversion review returned **FIX(5)** (1 blocking §2.2 fidelity break + 4
  majors + minors); a **Codex CLI** worker integrated all 12 findings and the Lead
  verified independently — **`tsc --noEmit` clean, `npm test` 38/38 pass** (26 + 12
  new), committed `86b9d5c`. The review lives at
  `scratchpad/kimi-p0-review.log`; the integration report at
  `scratchpad/codex-p0-integrate.log`. **Nothing left on P0-local.**
- **P0-github — MOSTLY COMPLETE.** Done + independently verified: private org repo,
  the `swarm-1human-main` ruleset, and the read-only GitHub App (registered,
  installed, scoped to `cloud-swarm`) — see §3 for identifiers. **Deliberately not
  done:** (a) rulesets / doctrine-backstop on the **PromptEden** repos — the operator
  scoped these OUT; do not touch `Ridge-io/prompteden-aeo` or
  `Ridge-io/prompteden-marketing` without a fresh explicit instruction. (An open swarm
  task `repo-doctrine-backstop` still exists in the `default` swarm.) (b) per-epoch
  branch convention — needs real lease epochs from P1. (c) required pre-landing check
  — P2.
- **Recon findings on the PromptEden repos (2026-07-23, read-only, unactioned):**
  `prompteden-aeo` has ruleset "Require reliability tests on main" (Unit Tests, Real
  Postgres Tests) but **no** force-push/deletion protection; `prompteden-marketing`
  has classic protection (Build, Typecheck) with admin enforcement, linear history,
  force-push/deletion blocks and conversation resolution **all disabled**. AGENTS.md
  exists on both (126 / 38 lines); CLAUDE.md only on marketing (46 lines).
- **Provisioning agents (NOT swarm members — invoke directly):** **Forge** =
  `openclaw agent --agent forge --json --timeout N -m "<prompt>"` (workspace
  `~/Developer/Ridge.io`; `gh` authed as `Ridgeio` with `repo` scope; its browser is
  NOT logged into GitHub and its 1Password GitHub account lacks Ridge-io org-admin).
  **Anvil** = `anvil -z "<prompt>"` (Hermes; 1Password service account works). Extract
  Forge's reply with `python3 -c "import sys,json;d=json.load(sys.stdin);print(d['result']['payloads'][0]['text'])"`.
  For GitHub org-admin work neither agent suffices — use `browser-harness` against the
  operator's Chrome (logged in as `Ridgeio`, which HAS org-admin). **Always instruct
  provisioning agents to put secrets in 1Password and report only non-secret facts.**
- **P1 — Secure authority slice (needs provisioning):** PKCE login + keychain;
  tenancy + private-schema command API wrapping `decide()`; repo mapping + named
  landing authority; audit; revocation; rate limits; invite flow. **Provisioning
  (Supabase project, GitHub App) → OpenClaw/Hermes.** Wire the P0 `decide()` core
  behind the Supabase command function — that is the whole point of building it pure.
- **P2–P5:** per spec §9. P5 = public free-to-start SaaS on b9rk.com.

## 5. Queued design tasks (don't lose these)

- **Add the "Access plane" track to the spec** (operator approved). A key-less
  secrets broker + policy egress proxy so agents operate third-party services
  without holding raw keys. **Three tiers by reversibility** (same §0 principle):
  1. **Read proxy (fluid):** scoped read capability → swarm proxies the call with the
     real key held server-side (Sentry issues, PostHog). Raw key never touches the
     agent/model. Reversible → low friction.
  2. **Leased local secrets (medium):** short-lived scoped secret **injected into the
     collaborator's local process at runtime** (not written to `.env`); revoke
     centrally. Honest residual risk: a malicious local dep could read an injected
     secret — reduces sprawl, not perfect containment.
  3. **Brokered infra ops (hard):** prod/dev Supabase migration, deploy → the §2.10
     Swarm-mediated-apply gate (secret released only after a fresh human approval
     bound to the exact op + environment, audited). Irreversible → hard.
  **Non-negotiable invariant:** an **egress allowlist** — the proxy calls ONLY the
  real service endpoints, never arbitrary URLs, or it becomes an exfiltration channel
  (lethal-trifecta amplifier). Rides the SAME capability/token/tenancy/audit model —
  which is why it's a clean extension. **Sequence it AFTER the coordination core is
  dogfooded** (its own track, architected-for now; the §2.10 secret-custody is the seed).
  Slot as spec §2.14 or a new "Access plane" section + a §9 track, mirroring the SaaS track.
- Start the **dedicated cloud-swarm swarm** (operator wants a project-specific swarm
  with the Lead as lead) and register OpenClaw/Hermes for provisioning.

## 6. Guardrails (from memory / operator)

- Secrets never in model-visible files. Draft-PR-only CI (Actions budget). Never
  `git clean` / `git add .` at the **Ridge.io root** (zero-commit trap) — cloud-swarm
  is a separate repo and is safe. Nothing provisioned until the operator's intent is
  clear (now delegated to OpenClaw/Hermes). Agents visible in cmux; spawned
  permission-free by default on this trusted machine.
