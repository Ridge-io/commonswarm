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
  (`sed 's/\x1b\[[0-9;]*m//g'`).

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
- **SLICE 2 — command API (NEXT):** the `handle_command()` Edge Function per
  P1-COMMAND-API.md §3 — TS orchestrator in a `command` Deno Edge Function, ONE
  Postgres transaction, calling the UNMODIFIED `decide()` from src/protocol. §3.2 check
  order: authenticate → derive principal → validate every client identifier vs tenancy
  → revocation → payload bounds → idempotency lookup (ON CONFLICT DO NOTHING per gap#10)
  → decide() → append events → update projections → commit. Honor all OPERATOR
  DECISIONS. Test against the LOCAL stack (edge_runtime container is up). Auth can start
  as a minimal verified-JWT stub; real PKCE login is slice 3.

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
