# Codebase, release, and production state

Snapshot: **2026-07-31 08:57 CDT**  
Remote head at snapshot: `a21db3f59864c1142d6d270d2aa309f98b75ed07`

## 1. Product and business state

CommonSwarm is live, public, self-serve, and free. A stranger can visit
<https://commonswarm.com/app>, use email magic-link or GitHub sign-in, create up to the
configured free-tier workspace cap, connect an agent, and invite a teammate. There is no
billing or paid tier.

The business outcome being pursued is not “a task manager for agents.” It is a lightweight
shared channel that gives a person and their AI collaborators enough awareness to avoid
duplicating work. The current primitives shown to users are agents and immutable signals:
`working-on`, `note`, and `ask`, plus correlated replies. The deeper protocol code still has
task/lease/grant primitives, but the consumer workspace UI should not invent tasks or files
until those are intentionally made product primitives.

No trustworthy traffic, active-user, retention, revenue, or error-rate metric was available
for this snapshot. The site intentionally has no product analytics, and no Sentry/error
dashboard was inspected. GitHub release assets each showed one download at the moment of the
release query; that is artifact telemetry, not a customer count.

## 2. Repository topology and source-of-truth problem

There are two independent clones of the same remote:

| Clone | Branch/head | Relation to `origin/main` | Dirty state | Deployment inputs |
|---|---|---|---|---|
| `/Users/yulanbot/Developer/Ridge.io/cloud-swarm` | `main` at `af87f8a` | behind 8, ahead 0 | `.gitignore` adds `.gstack/` | `site/.env`, Vercel project link, and Supabase project link are present |
| `/Users/yulanbot/Developer/Ridge.io/cloud-swarm-source` | `main` at `a21db3f` | exact | `.gitignore` adds `.gstack/` | all three are absent |

The first clone is the current interactive workspace and the only immediately deploy-capable
clone, but it does not contain the v0.1.4 listener source. The second is the exact source tree
that matches remote `main`, but a site build there silently emits empty backend metadata and a
Vercel deploy can target the wrong project unless the ignored configuration is recreated.

This split is the highest operational risk after the legal gap. The recommended consolidation
is specified in `NEXT-EXECUTION-PLAN.md`; do not improvise a deploy before completing it.

### 2.1 The concrete regression a clone-A deploy would ship (F-1, added 2026-07-31)

The paragraph above is correct but abstract, and an abstract warning is one a future agent can
talk itself past. The measured specifics:

```
$ git diff --stat af87f8a a21db3f -- site/
 site/src/components/connect/agent-prompt.observer.test.ts | 32 ++++++++-------
 site/src/components/connect/agent-prompt.ts               | 33 ++++++++++++-----
 site/src/components/download/AfterInstall.astro           |  2 +-
 site/src/components/download/OtherWays.astro              |  2 +-
 site/src/lib/install.ts                                   |  2 +-
```

The three one-line changes are all the same edit: **`0.1.3` → `0.1.4`.**

| Surface | Production today | Clone A working tree |
|---|---|---|
| `/download` body copy | `cswarm 0.1.4` (×2, measured) | `cswarm 0.1.3` |
| pinned install command | `CSWARM_VERSION=0.1.4` | `CSWARM_VERSION=0.1.3` (`install.ts:36`) |

**Consequence:** deploying clone A as-is silently rolls the public install instructions back to
0.1.3 while the GitHub release, the installer, and the agent prompt all remain 0.1.4. A stranger
following the site would pin a CLI older than the agent prompt's stated minimum. Nothing would
fail; the deploy log would be green.

This is the D-023 shape exactly — *availability/version copy asserts a deployment state, lives
in git, and goes stale when the deployment moves.* The check that catches it is a paired grep on
the **built** output, never on the source you edited:

```sh
grep -c '0\.1\.4' dist/download/index.html                # positive control, must be >= 2
grep -c 'CSWARM_VERSION=0\.1\.3' dist/download/index.html # must be 0
```

## 3. Codebase layout

The root package is `cloud-swarm` version `0.1.4`, ESM, strict TypeScript, Node `>=24`.

| Area | Purpose | Current notes |
|---|---|---|
| `src/protocol/` | Pure reducer, events, commands, task/lease authority core | No I/O; single source for generated edge protocol bundle |
| `src/cloud/` | Auth, workspace, signal, invite, credential-renewal, listener, host, and storage clients | `signals.ts` carries host-neutral follow semantics; listener/host modules implement v0.1.4 |
| `src/cli.ts` | `cswarm` command surface | Includes login/invite/workspace/signal/inbox/reply/listen paths |
| `supabase/migrations/` | Private schema, RLS, self-serve, capability, renewal, invite lifecycle, agent receive | 12 local migrations; all 12 matched production in the linked-clone check |
| `supabase/functions/command/` | Mutating authority boundary | Active production v15 |
| `supabase/functions/read/` | Member/signal read boundary and agent inbox | Active production v6; supplies cursor and sender relation |
| `supabase/functions/capability/` | One-use capability/invite redemption | Active production v2 |
| `site/` | Astro 7 static build, client-side Supabase app, marketing/legal/download routes | 8 routes; hand-written CSS, no Tailwind |
| `tests/` | Pure, CLI/process, local integration, server, and UX-harness suites | Root `npm test` names literal files; paths outside that list can silently miss the gate |
| `docs/design/` | Canonical and product-specific specs | `SWARM-CLOUD.md` wins conflicts |
| `docs/evidence/` | Durable completion/release evidence | Committed on purpose; several candidate-status headers need reconciliation |

Current file counts measured for orientation, not as a quality metric: 42 files under `src`,
26 under `supabase`, 72 under `site/src`, 38 under `tests`, and 100 under `docs`.

### Site routes

- `/` — consumer landing page.
- `/start` — auth callback/onramp; currently redirects into `/app`.
- `/app` — signed-out auth, workspace creation, workspace channel, roster, invites, and agent
  connection.
- `/invite` — recipient onramp for a private teammate access link; honest empty-link state.
- `/download` — install and CLI guidance.
- `/terms`, `/privacy`, `/acceptable-use` — live but explicitly draft legal documents.
- `/install.sh` — copied from root `install.sh` at build time.

### Production migrations

The linked-clone `supabase migration list --linked` showed local/remote parity for all 12:

1. `20260723000001_p1_schema.sql`
2. `20260724000001_connect_loop.sql`
3. `20260724000002_status_workspaces.sql`
4. `20260724000003_signals.sql`
5. `20260727000001_capability_urls.sql`
6. `20260727000002_capability_urls_hardening.sql`
7. `20260728000001_spend_circuit_breaker.sql`
8. `20260728000002_worker_token_renewal.sql`
9. `20260728000003_pending_successor_first_use.sql`
10. `20260728000004_stranded_successor_accounting.sql`
11. `20260730000001_workspace_access_lifecycle.sql`
12. `20260730000002_agent_signal_receive.sql`

~~`AGENTS.md` and parts of `TODO.md` still say ten migrations in historical passages. The
production measurement above is the current fact.~~

★ **CORRECTED (F-8, 2026-07-31).** `AGENTS.md` carries **no migration count at all** — grep
returns only "migrations + Deno edge functions" (layout) and "a migration written is not a
migration applied" (doctrine). The stale "10 migrations" text is in **`TODO.md` only**
(lines 231 and 322), and in both places it is a *historical* statement about the 2026-07-28
deploy that was accurate when written.

Left in place because the failure mode matters more than the fact: **a reconciliation lane
acting on the original sentence would go looking for a defect in `AGENTS.md` that does not
exist, and might "correct" a correct file.** Twelve migrations is the current fact; `AGENTS.md`
never said otherwise.

## 4. What was built in this work cycle

### 4.1 Workspace-first consumer flow

The original signed-in flow looked like a checklist and contradicted itself: a signed-in user
saw “Sign in,” “workspace ready,” and “open dashboard,” but the dashboard did not offer a clear
way to add an agent. The product ruling in
`docs/design/2026-07-29-WORKSPACE-FIRST-DASHBOARD.md` replaced that mental model:

1. signed-in zero-workspace state;
2. create a workspace;
3. immediately open the empty workspace channel;
4. make **Add an agent** the obvious next action;
5. show the first signal in the same feed when the agent connects.

The first exact production deployment exposed a real selector bug: the outer dashboard panel
switcher hid the `AgentConnect` component's internal ready state. Commit `21c3328` narrowed the
selector and added a regression observer. A disposable production identity then completed the
full sign-in → workspace → agent prompt → first signal journey. Evidence:
`docs/evidence/2026-07-30-workspace-first-production-e2e.md`.

### 4.2 Teammate invitation and agent identity

User feedback distinguished two intentions behind **Add an agent**:

- “I run this agent.”
- “A teammate runs this agent.”

The teammate path now asks for the teammate's email and creates a private, one-use link that
expires after seven days. The recipient opens `/invite`, signs in, receives workspace access,
and then gets the prompt for an agent they control. The inviter never needs to send the long
live agent credential through text message. Pending access can be listed/cancelled; the agent
prompt auto-completes on first use and offers **Done**.

Agent records now carry a human-readable model label and owner relationship. Feed/roster rows
show model and owner so otherwise-similar agents do not blend together.

Primary implementation anchor: `02929c9` (`feat: add teammate agent invite flow`) plus the
later access/revocation integration on main. Product spec:
`docs/design/2026-07-30-REMOTE-TEAMMATE-AGENT-INVITE.md`.

### 4.3 Header roster and avatar consistency

The old left-rail agent list grew until **Add an agent** was below the fold; the mobile rail
could hide agent management entirely. The redesign:

- removes agents from the workspace rail;
- adds a header stack of at most three overlapping circular initial avatars plus live count;
- opens a searchable, scrollable native dialog/bottom sheet;
- places **Add an agent** before the roster;
- uses the same circular avatar geometry everywhere, varying color and initials only;
- shows name, model, owner, role, and permission-aware remove action;
- preserves keyboard, Escape, backdrop, focus restoration, and mobile behavior;
- refreshes the roster once when a new principal first appears in the live feed without
  creating a polling storm for revoked historical principals.

Relevant main commits: `3d3c438`, `f943e16`, `65271ed`, `4ac26f1`. Visual and test evidence
is under `docs/evidence/2026-07-30-header-agent-roster/`. That evidence document still calls
the change a candidate; the commits are now on main and production, so its status header is
stale even though its measured implementation details remain useful.

### 4.4 Near-real-time feed

User dogfood showed that new round-robin messages did not appear until the manual refresh
button was pressed. The shipped web behavior uses focused two-second polling, pauses while the
page is hidden, resumes on focus/visibility, avoids concurrent refresh storms, preserves the
last readable feed on transient failures, and supports older-page loading. It is “near real
time,” not WebSocket realtime.

This solves the visible browser problem. It does not solve agent wake by itself; an idle model
process still needs a host integration or listener.

The earlier “two messages” observation was not an arbitrary small character limit. The agent
had emitted two separate signals—a `Question` and a `Note`/round-robin status—and immutable
signals render separately. The product should continue to make signal type and correlation
clear; it should not silently merge independent events.

### 4.5 Agent receive: v0.1.2

Tag `v0.1.2` (`b2326b5`) added direct agent-addressed ask/note signals, correlated replies,
and CLI inbox/reply surfaces. It established that agents could poll or block for messages, but
an idle host still had to run the command or be externally resumed.

Evidence: `docs/evidence/2026-07-30-agent-receive-v0.1.2-production.md`.

### 4.6 Host-neutral resilient stream: v0.1.3

Tag `v0.1.3` (`c0f3391`) added:

```sh
cswarm inbox --kind ask --follow --ndjson
```

The stream emits a readiness frame after the first authenticated arm, walks a backlog with an
ascending keyset cursor, deduplicates signal IDs in-process, retries transport/429/5xx with
bounded jitter and `Retry-After`, supports cancellation, and emits machine-readable NDJSON.
It is host-neutral: a CLI, ACP adapter, app server, or supervising process can consume it.

This release fixed the terminal-poll integration problem for hosts that can keep a foreground
process and react to stdout. It did not itself resume a dormant model.

Evidence: `docs/evidence/2026-07-30-v0.1.3-release.md`.

### 4.7 Detached Grok listener: v0.1.4

Tag `v0.1.4` (`4cc29e6`) is the first release that receives a direct ask after the setup turn
and delivers it to a model without cmux or terminal keystroke injection:

```sh
cswarm listen start --agent-token-stdin \
  --workspace-id <uuid> --cwd <absolute-directory>
cswarm listen status --workspace-id <uuid> --principal-id <uuid>
cswarm listen stop --workspace-id <uuid> --principal-id <uuid>
```

The measured provider is Grok CLI `0.2.117`, ACP protocol v1. Startup returns ready only after:

1. the credential is accepted;
2. the read edge proves the `sender_owner_relation` and lossless-cursor capabilities;
3. Grok passes a forced-deny permission canary;
4. the detached supervisor holds the one-listener control socket.

Security/behavior contract:

- Credentials enter through stdin only and are absent from child argv/environment/status/logs.
- The running listener asks the credential session for the current bearer before every read and
  reply post, allowing secure rotation inside the existing 30-day authorized horizon.
- Same-owner asks go to one persistent worker. Tools are denied by default; local
  `--permissions allow` is explicit opt-in.
- Cross-owner and unknown asks go to a new strict sandbox, empty MCP/tool capability set,
  context-free model turn, and clean temporary home.
- The server, not the client, classifies sender ownership from authenticated identities.
- The listener persists the exact normalized reply plus deterministic command ID before first
  post. A lost response replays the same effect without prompting the model again.
- Attempts are bounded, expired asks stop, malformed input is quarantined, and terminal states
  suppress loops.
- The NDJSON log is mode 0600 and metadata-only.

The production canary created a disposable Dogfood agent, started the exact release listener,
rotated its short credential, received a same-owner ask, prompted Grok once, posted one
correlated reply, then stopped about 2.5 seconds after root-lineage revocation with
`credential_stopped`. Disposable principal and successor state were removed.

Exact evidence: `docs/evidence/2026-07-30-v0.1.4-agent-listener-release.md`.

## 5. Git and release state

### Main history at the receive boundary

Newest first:

| Commit | Meaning |
|---|---|
| `a21db3f` | committed v0.1.4 release/production evidence; current remote main |
| `4cc29e6` | v0.1.4 tag; classify read revocation as credential stop |
| `5dc9745` | durable Grok receiver |
| `f253fc4` | persisted idempotent ask replies |
| `a6a3cb1` | measured Grok ACP host subprocess core |
| `55f445e` | follow cursor wire and sender-relation parsing alignment |
| `7c0f7c5` | lossless cursor, tolerant parse, honest renewal copy |
| `24ec0f9` | server-proven sender relation and ascending cursor |
| `af87f8a` | v0.1.3 production receive evidence; stale clone head |
| `c0f3391` | v0.1.3 tag review fixes |
| `1ea5a62` | v0.1.3 release version |
| `2a70d52` | resilient follow/NDJSON receive stream |
| `d85ce99` | v0.1.2 production evidence |
| `b2326b5` | v0.1.2 tag, direct receive/reply |

### GitHub release

GitHub release <https://github.com/Ridge-io/cloud-swarm/releases/tag/v0.1.4> was queried at
this snapshot:

- final, not draft, not prerelease;
- published `2026-07-31T04:51:35Z`;
- target commit exactly `4cc29e690a8452ef9fa502cf9ea2159ae6d7caa3`;
- `cswarm`: 1,261,735 bytes;
- `cswarm.sha256`: 73 bytes;
- binary digest/checksum:
  `ebd4df650f066470dd128225b05e716befccf73f5e35599daa3cf9c48790c270`.

The public installer was previously tested in an isolated target with
`CSWARM_VERSION=0.1.4` and produced `cswarm 0.1.4 (protocol 0.1.0)`.

## 6. Last measured code gates

These gates were run on the exact v0.1.4 release commit and are documented in the release
evidence. They were **not rerun in this dossier pass**; repository inspection and production
probes were read-only.

| Gate | Exact-release result |
|---|---|
| `npm test` | 195 pass, 0 fail |
| `npm run check:tests` | pass |
| `npm run build` | pass |
| `npm run check:edge` | pass |
| `npm run test:p1-cli` | 137 pass, 0 fail |
| `npm run test:p1-server` | 41 pass, 0 fail |
| clean `site` build | 8 routes |
| `npm --prefix site test` | 57 pass, 0 fail |
| release bundle outside repo package tree | `cswarm 0.1.4 (protocol 0.1.0)` |

The detached-process test starts two concurrent listeners, proves one winner, handles
same-owner and cross-owner asks, verifies allow/deny decisions, and checks that no CommonSwarm
credential enters child argv/environment/status/logs.

Important gate traps:

- Root `npm test` is a literal list. A new test can exist and typecheck without ever running.

  ★ **CREDIT WHERE DUE (F-7, added 2026-07-31) — this trap is now instrumented.** Enumerated
  on the exact release tree: **37 test files, 0 orphans.** There is a meta-gate,
  `tests/p1-cli/test-gate-coverage.test.ts`, which walks the `tests/` tree, parses
  `package.json` scripts, and asserts every test file is reachable by some script — and it is
  itself named in the literal `test` list, so it runs. All nine test files added by v0.1.4 are
  reachable, including `tests/support/agent-receive-cli.test.ts`, the very directory that
  swallowed the six D-025 observers.

  The historical warning stays because the trap is structural and the meta-gate can itself be
  bypassed by a new *directory* convention. But the correct action today is **"confirm
  `test-gate-coverage` still passes"**, not "audit every test by hand." A lane spent
  re-solving this is a lane wasted.

- `test:p1-cli` touches the local stack through its integration member and needs an exclusive DB
  slot.
- Edge functions are outside root `tsc`; `npm run check:edge` is mandatory.
- `_shared/protocol.js` is generated; edit `src/protocol/`, then run
  `npm run build:command-core`.
- There is no CI, lint, formatter, or automatic deploy.

## 7. Production deployment state

### Vercel

Current inspected deployment:

| Field | Value |
|---|---|
| Project | `ridgedotio/coswarm-site` |
| Deployment | `dpl_FLsNC8Cu549rfCh8fSShPo3zX3AM` |
| Target/status | production / Ready |
| Created | 2026-07-30 23:52:18 CDT |
| Public aliases | `commonswarm.com`, `www.commonswarm.com`, `coswarm-site.vercel.app` |

The underlying Vercel project intentionally retains the old `coswarm-site` name. The custom
domain is the product URL. Renaming the Vercel project is cosmetic/operator work and can move
aliases; it is not a product priority.

### Supabase

Production project: `ukezjcnxjvkpkeezxaew`.

| Function | Version/status | Deployed hash |
|---|---|---|
| `command` | v15 / ACTIVE | `86531de877a19f415faa8091398515dd27d7feb07d2cd0016723dfd3c412c7b6` |
| `read` | v6 / ACTIVE | `846b4de6f6fa3fda951b8868f40f35c5a00e5d51ccabae5ebaf8070a7ab28ac7` |
| `capability` | v2 / ACTIVE | `bb3d7bedeb65dc7df7052a9c8d7933b09974c8dc326ed095277878a166796e7f` |

Anonymous public-key probes returned:

- `command` with `{}`: HTTP 400 `invalid_request`;
- `read` with `{}`: HTTP 401 `unauthenticated`;
- `capability` without a token: HTTP 404 `not_found`;
- a nonexistent function: gateway-style HTTP 404, a useful negative control.

The capability endpoint deliberately hides missing/invalid capabilities as not found.

### Public route probes at this snapshot

| Route | HTTP |
|---|---:|
| `/` | 200 |
| `/start` | 200 |
| `/app` | 200 |
| `/invite` | 200 |
| `/download` | 200 |
| `/terms` | 200 |
| `/privacy` | 200 |
| `/acceptable-use` | 200 |
| `/install.sh` | 200 |
| `/nope.sh` | 404 control |

Additional controls:

- `/start` contains a non-empty `commonswarm:url` pointing at the production Supabase origin.
- `/start` contains zero service-role JWT markers.
- `/download` contains `cswarm 0.1.4` twice.
- Deployed `/app` JavaScript contains `cswarm listen start` and `0.1.4 or newer` guidance.
- Deployed `/app` HTML includes the teammate invite, **Done**, **Back to the channel**,
  auto-close copy, circular header roster dialog, model field, and pending-access UI.
- The retired “Clear this prompt” phrase is absent.

## 8. Current customer-facing issues

### P0 — Legal documents are explicitly nonbinding while signup is open

All three legal pages say:

> Draft — not yet in force.

The signed-out `/app` acknowledgement explicitly says the Terms and Privacy Policy are “drafts
published for review (not yet in force).” A user can nevertheless sign up and use the service.
The product therefore presents legal documents while simultaneously saying they do not take
effect. This is a trust and legal-operations gap. It requires operator/counsel action; this
dossier does not recommend silently removing the banner.

★ **ESCALATED (F-2, 2026-07-31) — the proposed effective date has already elapsed.**

Measured on the live pages, raw HTML, all three of `/terms`, `/privacy`, `/acceptable-use`:

```html
<span>Proposed effective <span class="mono lgl__date-val">27 July 2026</span></span>
<span>Last updated      <span class="mono lgl__date-val">29 July 2026</span></span>
```

**Today is 31 July 2026.** The pages propose an effective date **four days in the past** while
simultaneously declaring themselves not in force.

This is materially worse than "drafts are live." A reader on 26 July saw a document that had not
taken effect *yet* — coherent, if awkward. A reader today sees a document that says it should
have taken effect four days ago and also says it has not. That is self-contradictory on its
face, and **it degrades by one day every day it sits.** There is no steady state to wait in.

The practical consequence for planning: this is no longer an item that can be parked behind
"awaiting counsel." **Standing still is now an affirmatively wrong statement on a live public
page, not a neutral incomplete one.** The operator has three exits and must pick one — move the
proposed date forward, activate the documents, or change the copy to something that is true
while review is pending. Only the third is available to engineering without counsel, and even
that is a copy decision the operator should ratify.

This also means the existing draft-date guard (`docs/evidence/2026-07-30-legal-draft-date-guard.md`)
is necessary but not sufficient: it guards the *placeholder*, not the *staleness*. A guard that
fails when a proposed effective date is in the past belongs in the Phase 1 observer set.

### P0 — Legal/privacy copy does not match the live product

Observed mismatches:

1. Terms and Privacy say sign-in is GitHub. `/app` offers email magic links first and GitHub
   second.
2. Privacy says every page is static and the website loads nothing from a third party. The
   static Astro shell runs a Supabase browser client and `/app` communicates directly with
   Supabase Auth/PostgREST/edge functions. The statement needs precise scoping rather than a
   blanket claim.
3. Privacy lists GitHub, Supabase, and Vercel as the service providers in the data path, but
   custom SMTP through Resend is active for magic-link email. Review whether any other current
   operational provider belongs in the list.
4. Privacy tells users to delete `~/.CommonSwarm`; the CLI's actual config directory is
   `~/.cswarm`.
5. Privacy describes GitHub-derived user identity. Email magic-link accounts have different
   source facts and fallback display-name behavior.
6. Several legal passages speak broadly about tasks/coordination history while the current
   consumer UI presents agents/signals. Align the data inventory to what is actually stored,
   including legacy/protocol tables, without promising nonexistent user-facing controls.

Source anchors include `site/src/pages/terms.astro:111`,
`site/src/pages/privacy.astro:74,99,149-150,180-182,219`, and
`site/src/components/app/LiveDashboard.astro:98`.

### P1 — Most agent hosts still do not receive messages natively

The foreground NDJSON contract can integrate with any CLI/process host. The detached native
adapter only supports the measured Grok CLI. An idle Codex, Claude, Gemini, ChatGPT, Cowork, or
desktop session does not automatically wake because CommonSwarm has a message. This is the
largest remaining core-product gap.

### P1 — Delivery is at-least-once without durable acknowledgement

The v0.1.4 cursor is lossless and the listener's reply side effects are idempotent, but receipt
itself has only in-process ID memory. Restarting or running a second consumer can re-deliver an
ask. Agents/hosts must deduplicate by signal ID. There is no server-side unread count, claim
lease, ack, or exactly-once receipt.

### P1 — Signed-in current dashboard lacks a fresh independent walkthrough

Public routes and deployed source were checked. The browser QA tool verified signed-out pages on
desktop/mobile. Attempting to attach to the user's existing signed-in Chrome failed because the
browser-control transport reported the browser unavailable, even though Chrome and the extension
were running. No new Chrome window was opened without permission. Therefore the exact current
signed-in roster/invite/remove/live-update path was not independently replayed today.

The prior production workspace-first E2E, release canary, user screenshots, source observers,
and deployed asset inspection remain evidence, but they are not a substitute for the next fresh
walkthrough.

### P1 — Cross-owner production behavior lacks a two-human canary

Cross-owner isolation, clean home, strict sandbox, no tools, and context separation pass the
server/process suites. Production only exercised a same-owner ask because no credential for a
second human-owned agent was borrowed or minted. The real two-human journey remains open.

### P1 — Email magic-link return leg has incomplete current evidence

Custom SMTP is active at 30 messages/hour from the CommonSwarm sender, and production/Resend
previously recorded delivery. The current durable TODO still says inbox-visible receipt plus a
cold-browser magic-link return to a signed-in `/app` has not been established end to end. Treat
that as a verification gap until repeated with a disposable account.

### P1 — Deployment split-brain can cause a silent broken release

This is not visible to customers today, but it can produce the next customer incident. The
current source clone lacks the ignored site environment and project links; the deploy-capable
clone is stale. The Astro build succeeds with empty backend values, and Vercel can report a green
deployment to the wrong project. Consolidation is mandatory before another release.

### P2 — Agent credential lifetime copy is imprecise

The live AgentConnect form says each key “lasts a few hours.” The root bearer is currently one
hour; a running listener can rotate it inside a 30-day authorized horizon. Copy should explain
the user outcome (“the listener keeps itself connected for up to 30 days unless access is
revoked”) without exposing unnecessary implementation ceremony.

### P2 — Pending access can lag after consumption

Header-roster evidence explicitly notes that pending access status can remain stale until a full
workspace reopen. The unknown-agent roster refresh does not refetch access status. This should be
verified and then fixed with a bounded pending-access refresh on invite consumption/revocation.

### P2 — Documentation and task-state drift

Examples:

- `TODO.md` still describes v0.1.1 as the current release in one resolved section.
- `docs/design/2026-07-30-REMOTE-TEAMMATE-AGENT-INVITE.md` leaves implementation tasks
  unchecked even though the flow landed.
- Header-roster evidence says “candidate, not landed” though its commits are on main and live.
- `docs/org/CHARTER.md` still calls zero-terminal collaborator invitation open even though the
  web `/invite` onramp exists; whether the agent itself can run with zero terminal remains a
  separate host question.
- `docs/marketing/SITE-BRIEF.md` and older material contain stack/product phrasing that conflicts
  with current `AGENTS.md` and deployed behavior.
- `docs/org/DEFECT-REGISTER.md` has open/in-review statuses that need re-evaluation against the
  released tree rather than blindly carrying them forward.

This drift can misdirect agents and has already caused prior availability-copy incidents.

### P3 — Low-severity public-page polish

- Browser navigation produced font preload warnings for Inter and JetBrains Mono on some routes.
  No console errors were observed. Audit whether preloads are route-appropriate.
- The full-page `/download` capture appeared to have a large whitespace region. Full-page
  stitching/annotation can distort layout, so this is a visual follow-up, not a confirmed bug.
- Rich agent images/emoji could improve differentiation later. Current uniform circular
  initials/color treatment is intentional and should remain until a coherent image policy exists.

## 9. Operational/external blockers

- **Attorney review and legal activation:** no attorney review is recorded. The draft banner is
  intentionally mechanical and must not be removed casually.
- **Trademark search:** `TODO.md` says no USPTO/common-law check has been completed for
  “CommonSwarm.” This is external/operator work before broader public announcement.
- **DMCA designated-agent registration:** the document names an agent, but the Copyright Office
  filing is not recorded as complete. Do not claim §512 safe harbor until publicly verified.
- **Vercel project rename:** optional/cosmetic operator action; not blocking.
- **Host APIs:** ChatGPT/Cowork/desktop native wake may be impossible without provider-supported
  background/app protocols. CLI host adapters are the near-term win; do not promise desktop
  support before measuring a supported API.

## 10. What is established vs not established

### Established

- Public self-serve routes are live and correctly wired to production backend metadata.
- All 12 migrations match remote production.
- Production edge functions are active at the recorded versions/hashes.
- The v0.1.4 tag, assets, checksum, installer, and production onboarding agree.
- A real Grok listener received one same-owner ask, posted one correlated reply, rotated its
  short credential, and stopped on revocation.
- Cross-owner isolation and failure/idempotency cases pass exact-release server/process gates.
- Public pages render responsively at desktop and 390px mobile widths with no observed console
  errors.

### Not established in this snapshot

- Current active-user, retention, traffic, revenue, or incident-rate metrics.
- A fresh signed-in dashboard walkthrough on the exact current deployment.
- A live cross-owner production ask between two humans.
- Native wake in any host other than measured Grok CLI.
- Durable receipt acknowledgement or exactly-once delivery.
- A wall-clock 30-day listener run.
- Cold-browser email magic-link completion after current SMTP configuration.
- Attorney approval, DMCA registration, or trademark clearance.

## 11. Evidence index

- `docs/evidence/2026-07-30-workspace-first-production-e2e.md`
- `docs/evidence/2026-07-30-header-agent-roster/README.md` and screenshots
- `docs/evidence/2026-07-30-hosted-agent-revocation.md`
- `docs/evidence/2026-07-30-agent-receive-v0.1.2-production.md`
- `docs/evidence/2026-07-30-v0.1.3-release.md`
- `docs/evidence/2026-07-30-v0.1.4-agent-listener-release.md`
- `docs/evidence/2026-07-30-read-edge-diagnostics.md`
- `docs/evidence/2026-07-30-legal-draft-date-guard.md`
- `docs/design/2026-07-30-AGENT-RECEIVE-MVP.md`
- `docs/design/2026-07-30-REMOTE-TEAMMATE-AGENT-INVITE.md`
- `docs/design/2026-07-29-WORKSPACE-FIRST-DASHBOARD.md`
