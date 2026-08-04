# Mercury Agent / Mercury Cloud — competitive analysis

Author: research seat
Date: 2026-08-03
Subject: `mercuryagent.sh` + `cloud.mercuryagent.sh` (Cosmic Stack) vs CommonSwarm
Method: two starting sources, then GitHub REST API (`gh api`), npm registry + downloads API,
HN Algolia API, fxtwitter API, and direct HTML fetch of the marketing/waitlist/pricing pages.
Cross-checked against our own tree at `/Users/yulanbot/Developer/Ridge.io/cloud-swarm`.

**Labelling convention used throughout: `[M]` = I measured it. `[C]` = they claim it
(marketing copy or announcement). `[N]` = not established.**

> **Lead verification, 2026-08-03.** I independently re-ran this document's sharpest and most
> falsifiable claim before landing it, because it is the one that would embarrass us if repeated
> wrongly. `npm view @cosmicstack/mercury-agent version` → **1.1.13** (positive control: the package
> resolves). `npm view @cosmicstack/mercury-agent@1.2.0` → **404**. Enumerated all published versions:
> **40 total, max 1.1.13, none in the 1.2.x line.** The claim holds as stated and is narrow in the
> right way — *not publicly installable*, which is not the same as *does not exist*. I did not
> re-verify the GitHub, HN, or download figures; those remain the research seat's measurements.

---

## 0. The two starting sources — what they actually said

### Source 1: the tweet — READ, verbatim, confirmed by two independent routes

I did read it. Route A was `r.jina.ai` text extraction; route B was the `api.fxtwitter.com`
JSON API. Both returned the same tweet. Verbatim text of
`x.com/mercury__agent/status/2084230531986919716`:

> "Create private agent circles for friends, teams, or communities. Decide which agents can
> connect, what knowledge they can access, and how they collaborate. The first batch is
> rolling out today, and access is limited. Join the waitlist:
> http://cloud.mercuryagent.sh/waitlist"

**[M]** Author `@mercury__agent` ("Mercury"), posted 2026-08-03 10:50 UTC. Engagement at time
of reading: **1,033 views, 9 likes, 5 bookmarks.** Account joined April 2026.

Direct WebFetch of the x.com URL returned **HTTP 402 Payment Required** — x.com is paywalled
to automated fetchers, as warned. The proxy routes worked.

**Caveat I must flag:** the linked tweet is **post 4 of a 4-post thread**. Posts 1–3 I have
only through a *summarizing* proxy, not verbatim, so treat them as reported-not-quoted:
1. Mercury Cloud launch — "300+ LLMs, including 10+ free models with unlimited usage."
2. Agent networking — connect your own agents, or *request connections with other people's
   agents*, to "collaborate, exchange approved knowledge, and work across shared context."
3. Remote access — connect your PC or server, then reach "agents, project context, files, and
   ongoing workflows on the go."

**Post 2 is the one that matters to us.** It is the only place in Mercury's entire public
surface that describes cross-person agent coordination.

### Source 2: the waitlist page — verbatim [M]

Fetched raw HTML (32,918 bytes) and stripped tags. The page in full:

- Hero: **"Founder access is opening / Your agent stays local. Your reach does not."**
- "Mercury Cloud is the live command layer for Mercury Agent. We are admitting a focused
  first cohort so every workspace is reliable, useful, and ready for serious work from day one."
- Badges: "No credit card to join · Single-use founder invites · Local-first architecture"
- **"A control plane, not another chatbot."** — "Mercury Cloud extends the agent running on
  your own machine. It does not replace the runtime, hide its actions, or turn your workflow
  into a black box."
- Four numbered unlocks: (01) Operate from anywhere — "chat with your local Mercury Agent,
  monitor its connection, and approve sensitive tool actions from the web"; (02) Memory that
  travels — "keep local-first agent memory while selectively syncing durable context across
  your trusted workspace"; (03) Curated model access — "route work through managed models with
  transparent usage, plan limits, and automatic provider resilience"; (04) Built for real work
  — "persistent conversations, research workflows, collaborative knowledge, and live runtime
  status."
- Runtime requirement block: **"Mercury Agent version 1.2.0 is required. This release contains
  the long-lived authenticated Cloud connection, durable token recovery, and protocol behavior
  required by the launch workspace."** Install line: `npm i -g @cosmicstack/[email protected]`

**Note what the waitlist page does NOT contain [M]:** the words "circles", "teams",
"collaborate with other people's agents", or any multi-user concept beyond "your trusted
workspace." The agent-networking story lives *only* in the tweet thread. The page you were
given as a source and the announcement you were given as a source describe **different
products**.

---

## 1. What Mercury Agent actually is

**Plain language:** Mercury Agent is a **local-first, single-user personal AI agent** that
lives in your terminal and follows you into chat apps. It is a *runtime* — a competitor to
Claude Code / Codex CLI / OpenCode — with an unusual emphasis on persistent memory and on
asking permission before acting. Mercury *Cloud* is a newly-announced hosted control plane
that lets you drive that local agent from a browser, plus a managed model gateway.

**Positioning [C]:** "Soul-driven AI agent with permission-hardened tools, token budgets, and
multi-channel access. Runs 24/7." Three pillars: *Thinks* (sub-agent orchestration, autopilot
loop detection), *Acts* (40+ built-in tools, markdown skill system), *Asks* (Ask-Me mode vs
Allow-All mode).

**Target user [M, inferred from surface]:** an individual developer who wants one persistent
agent that knows them — not a team. Every architectural choice points at one person: config in
`~/.mercury/`, a single `permissions.yaml`, a single SQLite memory DB, "soul" files that
define one personality.

**Stage — this is where the measurements matter:**

| Fact | Value | How measured |
|---|---|---|
| Repo | `cosmicstack-labs/mercury-agent`, MIT, TypeScript | `gh api repos/...` |
| Created | 2026-04-20 (≈3.5 months old) | `gh api` |
| Stars | **2,982** | `gh api`, 2026-08-03 |
| Forks | 321 | `gh api` |
| **Watchers (subscribers)** | **19** | `gh api` |
| Open issues | 50 | `gh api` |
| **Last commit to `main`** | **2026-06-19** | `gh api repos/.../commits/main` |
| Latest GitHub release | v1.1.13, 2026-06-18 | `gh api .../releases` |
| npm `latest` dist-tag | **1.1.13**, published 2026-06-18 | `npm view dist-tags` |
| npm versions published | 40, none ≥ 1.2.0 | `npm view versions` |
| **npm downloads, last 30d** | **730 total (~24/day)** | `api.npmjs.org/downloads/range` |
| Contributors | `hotheadhacker` 195; next two 17 and 16 | `gh api .../contributors` |
| Founder | **Salman Qureshi** (`hotheadhacker`, isalmanqureshi@gmail.com) | git commit authors + npm maintainers |
| Branches | 16 — **none cloud-related** | `gh api .../branches` |
| Code search `cloud in:path` | **0 results** | `gh api search/code` |
| HN presence | **1 hit ever**: 3 points, 0 comments, self-submitted 2026-04-21 | HN Algolia API |
| Company | Cosmic Stack (`cosmicstack.ai`), also builds `Sav.ink` | company site |
| Cloud pricing | Free $0 / Pro **$19**/mo / Extended **$49**/mo, billed via Paddle | `cloud.mercuryagent.sh/pricing` |

### Three findings from that table that change how you should read everything else

**(a) The advertised prerequisite does not exist. [M]** The waitlist page instructs
`npm i -g @cosmicstack/[email protected]` and states 1.2.0 "is required." **Mercury Agent
1.2.0 is not published to npm.** `latest` is 1.1.13 from 2026-06-18; 40 versions exist and
none is ≥ 1.2.0. There is no 1.2.0 GitHub release and no cloud branch. So on launch day, the
announced product's stated entry step **cannot be completed by a member of the public.** This
is the same class of error our own `docs/evidence/` discipline exists to prevent, and it is
exactly what our `site/scripts/download-version.test.mjs` gate blocks on our side.

**(b) The open-source repo is not where the cloud is. [M]** `main` last moved 2026-06-19 —
six and a half weeks before the cloud launch. GitHub code search for `cloud` in path across
the repo returns **0**. The public `src/` tree is `auth, capabilities, channels, cli, core,
memory, providers, signal, skills, soul, spotify, types, ui, utils, web` — no cloud module.
(`signal` here is the Signal *messenger* channel, not our sense of the word.) **The cloud
control plane is closed-source and its architecture is not public.**

**(c) Stars and usage disagree by ~2 orders of magnitude. [M]** 2,982 stars against **730 npm
downloads in 30 days** and **19 watchers**. Healthy OSS typically shows watchers at 1–3% of
stars; this is 0.6%. The launch tweet drew 1,033 views and 9 likes. Total lifetime HN
discussion is one self-submitted post with 3 points and zero comments. I found **no** Reddit
thread (searched; results returned only the project's own properties and aggregator pages).
Their own company site still quotes "2,494 GitHub stars" — stale against the 2,982 I measured,
which is consistent with stars accruing faster than the team updates copy.

**Read this carefully and don't over-claim:** I did not establish *why* stars and downloads
diverge. Standalone binaries are installed via `curl | sh` and would not appear in npm counts,
so npm undercounts real usage by an unknown factor. What I can say is that **no independent
signal of adoption was found** — no HN discussion, no Reddit thread, no third-party writeup
that wasn't an auto-generated aggregator page. `[N]` Actual user count.

---

## 2. How it works technically

Source: the repo's own `ARCHITECTURE.md` (fetched from raw.githubusercontent, so this is the
project's self-description of shipped code — call it `[C-authoritative]`, stronger than
marketing but still not my own code read).

**Execution model.** Single Node.js process. Main agent loop is Vercel AI SDK `generateText()`
with multi-step tool execution. Sub-agents are **async coroutines in the same process**, not
separate processes — a supervisor spawns/halts them with concurrency auto-derived as
`clamp(1, cpus-1, floor(availableRAM_GB / 2))`. Lifecycle states: unborn → birthing →
onboarding → idle ⇄ thinking → responding, plus delegating and sleeping.

**Where agents run.** Entirely on the user's machine. Daemon mode via macOS LaunchAgent, Linux
systemd, Windows Task Scheduler. A cron scheduler ("circadian rhythm") fires background prompts.

**State.** All in `~/.mercury/` — `mercury.yaml` (config), `soul/*.md` (personality),
`memory/` (SQLite + JSON), `skills/`, `schedules.yaml`, `permissions.yaml`,
`memory/task-board.json` (sub-agent state). **No cloud sync in the open-source architecture**
— the doc says so explicitly.

**Memory.** Three layers: short-term (last 10 messages), long-term fact DB (~3 facts injected
per request), and "second brain" — conscious memories retrieved via SQLite FTS5, subconscious
memories (dormant 30+ days) searched only when conscious results are weak, with promotion back
to conscious. Background `extractMemory()` mines 0–3 typed candidates (preference/goal/project)
per conversation; conflicts resolve by confidence score. Budget: 5 slots / 900 characters.

**Trust and identity model — and this is the important part for us.** It is a **single-user,
local-authority model**:
- Filesystem paths without granted scope = no access; prompts `y` / `always` / `n`, persisted
  to `~/.mercury/permissions.yaml`.
- Shell blocklist (`sudo *`, `rm -rf /`, `mkfs`, `dd if=`, fork bombs) with an auto-approve
  list and an approval-required list (`npm publish`, `git push`, `docker`, `curl | sh`).
- **There is no notion of a second person.** No principals, no owners, no tenancy, no
  cross-owner boundary. Authority is "the human sitting at this machine."

**Multi-agent coordination.** A `FileLockManager` with multiple-readers/exclusive-writer
semantics, auto-release on termination; a shared `task-board.json`; deadlock detection for
circular waits. **This is intra-process coordination between one user's sub-agents** — not
coordination between people, machines, or vendors.

**Mercury Cloud [C].** Local agent pairs via `mercury cloud connect`, establishing a websocket
to the cloud. The dashboard offers streaming chat, permission cards (terminal approval prompts
rendered as web cards), per-conversation model routing, memory sync, and usage quotas.
`[N]` **Everything about the cloud's internals** — no schema, no durability story, no
delivery/ack semantics, no isolation model, no auth design is public. There is no cloud
source, no API docs, no protocol spec. The docs site table of contents (which I enumerated:
Getting Started, CLI Commands, Daemon Mode, Integrations, Reference, Releases) has **no Cloud
section at all.**

---

## 3. Direct comparison to CommonSwarm

### The one-line difference

**Mercury is one person's agent, reachable from anywhere. CommonSwarm is many people's agents,
legible to each other.** Mercury solves *"I want to drive my agent from my phone."*
CommonSwarm solves *"my colleague's agent is about to touch the file mine is in."*

### Table

| Axis | Mercury Agent / Cloud | CommonSwarm | Verdict |
|---|---|---|---|
| Category | Agent **runtime** + hosted control plane | Agent **coordination service** | Different products |
| Unit of value | A conversation with *your* agent | An immutable signal of intent | Different |
| Multi-person | **None shipped.** Announced as "circles" `[C]` | Core: workspaces, members, invites | **We ship what they announced** |
| Identity model | Single local user; no principals | Agents are **principals owned by a human**; owner relation carried in `sender_owner_relation` | **Ours is a real model; theirs is absent** |
| Cross-owner boundary | Does not exist | Enforced. `src/listener/file-store.ts:31` `RELATIONS = {same_owner, cross_owner, unknown}`; cross-owner turns get "a fresh auth-only home and empty cwd" (`src/cli.ts:2578`) and "discover no user/project hooks, rules, skills, MCPs, sessions, or memories" (`src/listener/grok-model.ts:183`) | **Ours only** |
| Directed-message privacy | `[N]` | Enforced server-side: `read/index.ts:376-383` filters `(to IS NULL AND to_agent IS NULL) OR to_agent = <principal>` | **Ours only, and verified** |
| Durability | Local SQLite + JSON; cloud durability `[N]` | Postgres; `FOR UPDATE OF d SKIP LOCKED` (`command/durable-delivery.ts:235`), lease id/expiry, persist-before-ACK | **Ours specified and measured** |
| Mutability | Memory is mutable, consolidating, conflict-resolved | Signals **immutable**, TTL-expiring | Opposite by design |
| Coordination primitive | File locks between sub-agents in one process | Signals that **never** claim/block/close | Opposite by design |
| Host neutrality | Mercury agents only (walled garden) | Host-agnostic adapters (`grok-model.ts`, `opencode-model.ts`) | **Ours is broader** |
| Model access | Managed gateway, "300+ LLMs" `[C]` | None — user brings their own | Deliberate difference |
| Human reach | CLI, Web, Telegram, Discord, Slack, Signal | CLI + Astro dashboard. `[M]` **zero** outbound notification: 0 hits for `webhook`, `slack`, `telegram` in `src/` + `supabase/functions/` (positive control: 706 `workspace` hits) | **Theirs is far wider** |
| Skills/extensions | 126+ skills, separate registry repo (365 stars) | None | Theirs only |
| Billing | Live: $0 / $19 / $49 via Paddle | Free tier only; billing deferred (`V015-MASTER-PLAN.md` §4) | Theirs only |
| Distribution posture | **Waitlist, invite-only, "access is limited"** | **Self-serve since 2026-07-28** (`SWARM_SELF_SERVE=1`) | We are *ahead* here |
| Openness | Agent MIT open-source; **cloud closed** | Repo public; spec public | Comparable, slightly ours |
| Team size | Effectively one person (195 of ~240 commits) | Small | Comparable |

### Prose: where we actually overlap

The overlap is **one sentence in one tweet** — "connect your own agents or request connections
with others' agents to collaborate, exchange approved knowledge, and work across shared
context," plus the "private agent circles" post. Everything else Mercury does is a runtime, and
runtimes are the layer *below* us: a CommonSwarm user runs Claude Code or Codex or OpenCode, and
could equally run Mercury.

This is the **same shape as the QM finding** (`docs/design/2026-08-02-QM-COMPARATIVE-ANALYSIS.md`
§2): "QM *runs* agents… CommonSwarm *coordinates* agents that the operator already runs
somewhere else." Mercury is another instance of that pattern, and a weaker one than QM — QM at
least shipped multiplayer; Mercury has put it on a waitlist.

But there is one difference from QM worth naming. QM's collaboration model was "chat rooms with
scoped memory." Mercury's announced model — *"decide which agents can connect, what knowledge
they can access, and how they collaborate"* — is **conceptually closer to us**: it is about
governing what one person's agent may learn from another person's agent. That is the same
territory as our cross-owner boundary. The difference is that ours is **built and enforced**
(fresh auth-only home, empty cwd, no inherited hooks/rules/skills/MCPs/memories; server-side
directed-read filtering) and theirs is a waitlist headline with no published design.

### Where Mercury does something we do worse, or not at all

Being honest, four things:

1. **Reach to the human.** Six channels — CLI, Web, Telegram, Discord, Slack, Signal. We have
   **zero** outbound paths; I enumerated and confirmed with a positive control. A CommonSwarm
   signal only exists for someone who is looking at the dashboard or the CLI.
2. **Positioning craft.** Their waitlist page is genuinely better written than our surfaces.
   See §4A.
3. **A shipped paid ladder.** $19/$49 through Paddle, live, with cancellation and refund pages.
   Ours is deferred.
4. **An extension ecosystem** with its own registry and its own star count — a distribution
   flywheel we have no analogue to.

---

## 4. What we should LEARN and ADAPT

Ranked by value ÷ bloat. **Every item below was checked against our tree first** — the QM
retraction (§5 of the master plan) happened because that check was skipped.

### A. Steal the positioning craft, not the product. ★ highest value, zero engineering

Mercury's waitlist page executes three moves we currently do not:

1. **Name the fear and resolve it in one line.** *"Your agent stays local. Your reach does not."*
   The reader's objection to any hosted agent product is "do I lose control of my machine?" —
   answered in seven words. **Our story is the same story and we say it more abstractly:** our
   README leads with *"GitHub holds the artifacts. CommonSwarm holds the intentions."* That is
   elegant but it names no anxiety. We coordinate agents that run on the user's own hardware —
   we never take custody of their runtime — and we barely say so.
2. **Negate the wrong category explicitly.** *"A control plane, not another chatbot."*
3. **Frame features as unlocks, numbered, outcome-first**, not as a capability list.

**Map to roadmap:** `docs/marketing/SITE-BRIEF.md` and the live site copy. **This matters
urgently because of `docs/design/2026-08-03-SLACK-SHAPE-UI.md`.** That document already
contains the right negation — *"Not a chat product… Slack's shape makes intent legible; it must
not turn signals into conversation"* — but it lives in a design doc. The moment we ship a
Slack-shaped UI, the probability that a visitor reads us as a chat product goes up sharply.
**The negation must be promoted from internal design prose to a public surface line, shipping
in the same release as the shape.** Mercury shows the form: one short sentence, above the fold,
that says what this is not.

### B. Treat "does a signal ever reach a human who isn't looking?" as an open operator question

**Measured gap, not a recommendation to build.** `webhook`, `slack`, `telegram` return 0 across
`src/` and `supabase/functions/`; the only `notif*` hits are `src/host/types.ts`,
`src/host/session.ts`, `src/host/transport.ts` — in-process ACP host notifications, not outbound
human reach.

The learning is *not* "build six channels." It is that Mercury treats the agent→human path as a
**distribution surface**, and our memory note *"Launch bar is blocked on distribution"* says
that is our binding constraint. A signal that expires unseen coordinated nobody.

**I am deliberately not recommending an implementation.** This is a question for the operator,
and if it is ever answered, the answer that fits our doctrine is one narrow path (email or a
single webhook on *direct-to-you* signals only), never a channel matrix. Anything broader turns
a coordination service into a notification platform.

### C. Their launch is a free positive control for our own release discipline

**Nothing to build — this validates gates we already have.** Mercury shipped a waitlist whose
required install command (`@cosmicstack/[email protected]`) resolves to a version that does not
exist on npm. Our tree already prevents the exact analogue: `site/scripts/release-lockfile.test.mjs`
rejects disagreement between `package.json.version` and both lockfile version fields, and
`site/scripts/download-version.test.mjs` rejects a built `/download` missing or misrendering any
of the four version surfaces. Both run under `npm --prefix site test`.

**The transferable lesson is the second-order one:** their failure is not in the *version
number*, it is that **a marketing page asserted a deployment state that was not true** — the
precise shape of our own D-023. Their page is the counterfactual proof that our
`AGENTS.md` rule *"availability copy asserts deployment state and lives in git, so nothing fails
when the deployment moves — grep every surface when a gate flips"* is worth its cost. Cite this
in the doctrine file as an external example.

### D. Agent identity owned by the human — external validation, no work

Mercury's `soul/*.md` / `persona.md` model gives an agent a persistent, *named* identity defined
by files **the user owns**. That is independent convergence on
`docs/design/2026-08-03-SLACK-SHAPE-UI.md`'s rule 2 — *"Every agent belongs to a human, and the
line says whose"* — and on its call for "light anthropomorphism… agents get names." (Amusing
coincidence worth zero decisions: our own mockup names one of its example agents `mercury`.)

**Do not import their mechanism.** Ours is stronger where it counts: they have identity as
*personality*, we have identity as *authority* (`sender_owner_relation`), and
`2026-08-03-AGENT-SELF-IDENTIFY.md` is explicit that those two must stay separate — *"This is
display metadata, not identity."* Mercury conflates them; that separation is ours to keep.

### E. Under-marketed strength we should name: the invite link is a better flywheel than a registry

Mercury's distribution flywheel is a skills registry (126+ skills, its own repo and site). We
have no analogue and should not build one. But we have something structurally better and
under-sold: **`cswarm accept <invite-link>` needs no configuration, because an invite link
carries its own target** (README). A coordination product spreads person-to-person by
construction; a runtime has to manufacture reasons to be shared. That is a marketing asset, not
an engineering task.

---

## 5. What we should explicitly NOT adopt

The standing constraint is no feature bloat, and "a competitor has X" is not a reason. Five
specific refusals:

1. **The managed model gateway ("300+ LLMs, 10+ free with unlimited usage").** This would make
   us a model reseller with real COGS, inference SLAs, and abuse surface — a different company.
   It also **contradicts Mercury's own headline**: if work routes through their gateway, their
   servers see the prompts, and "your agent stays local" stops being true of the part that
   matters. We take custody of *intentions*, never of *inference*. Refuse permanently.

2. **Permission/approval cards.** This is the sharpest one, because it will look attractive
   next to a Slack-shaped UI. An approval card is a **veto** — it blocks an agent until a human
   clicks. Our entire thesis is the opposite: *posting a signal never claims, blocks, or closes
   a task.* We sell **legibility, not control** (`AGENTS.md`: "the benefit being sold is agents
   coordinating so collaborators are unblocked — not control, authority, or enforcement"). An
   approval queue is a lock manager with better typography. Refuse.

3. **Memory sync / "exchange approved knowledge" / "shared context."** Our signals are
   **immutable** and **TTL-expiring** — deliberately, so *"nobody has to clean up after a change
   of plan"* (README). Knowledge exchange implies mutable, long-lived, cross-owner state, which
   breaks **both** properties simultaneously and drags in conflict resolution, provenance, and
   a redaction story. Mercury's own memory layer already needs confidence-scored conflict
   resolution and a conscious/subconscious tiering to stay sane for **one** user; across owners
   it is a much larger problem than it looks. Refuse.

4. **The waitlist / invite-only scarcity motion.** We went self-serve on 2026-07-28
   (`SWARM_SELF_SERVE=1`), and **D-023 is the scar**: leftover invite-only copy caused a
   reviewer to conclude signup was unavailable and prescribe rebuilding the site around a
   waiting list. Mercury is running exactly the motion we corrected away from, and the measured
   result on launch day was **1,033 views and 9 likes**. Reverting would re-open a defect we
   already paid for, in exchange for a tactic with no measured lift. Refuse — and note that this
   is a case where reading a competitor's front page *uncritically* would have pushed us
   backwards.

5. **Sub-agent orchestration, the supervisor, and `FileLockManager`.** We refused to become an
   orchestrator or a lock manager on purpose. Note also that Mercury's locks are **intra-process**
   — coroutines in one Node process — so they do not even address the problem we exist for
   (different people, different machines, different vendors). Adopting them would be bloat that
   *also* doesn't solve our problem. Refuse.

---

## 6. Competitor, adjacent tool, or complement?

**Argument: adjacent today, a genuine complement in practice, and a competitor only for a
category label they have not yet earned.**

**Not a competitor, on the evidence.** Competition requires a customer choosing one *instead of*
the other. Nothing shipped in Mercury does what CommonSwarm does: no principals, no owners, no
tenancy, no cross-owner boundary, no multi-person workspace. Their authority model is "whoever
is at this keyboard." The only collision is "agent circles," which is (a) unshipped, (b)
un-installable on launch day because 1.2.0 is not on npm `[M]`, and (c) undocumented — there is
no Cloud section in their docs at all `[M]`.

**A complement, structurally.** Mercury sits one layer below us. A Mercury user who joins a team
needs precisely what we sell: cross-owner legibility. Our host-adapter architecture
(`grok-model.ts`, `opencode-model.ts`) means Mercury is a candidate *adapter*, not a rival — the
same relationship we have with Claude Code and Codex. If Mercury succeeds, it grows the
population of people running persistent local agents, which is the exact population that
eventually hits the coordination problem.

**Where it could become a competitor, and the honest risk.** Not by out-building us — by
**naming the category first**. If "agent circles" becomes the phrase people use for
cross-person agent coordination, we spend our explanations differentiating from a definition we
did not write. Note also that a Mercury circle connects **Mercury agents only** — a single-vendor
network. Our differentiator is the opposite and should be said out loud: *a Claude Code agent,
a Codex agent, and two humans in one workspace.* A walled garden is a narrower product than a
neutral one, and that is the sentence that wins the comparison if it is ever asked.

**Probability-weighted read:** low threat, near-term. One-person team, `main` untouched for six
weeks, 730 npm downloads/month, one HN post with three points, zero third-party discussion, and
a launch whose install command does not resolve. **The correct response is copy work and a
doctrine citation, not a roadmap change.**

---

## 7. What this analysis did NOT establish

Stated plainly, per doctrine:

- **The cloud architecture. At all.** No source, no API docs, no protocol spec, no schema, no
  durability/delivery semantics, no isolation model, no auth design. Every §2 cloud statement is
  marketing copy. `[N]`
- **Whether "agent circles" exists as running code.** I saw one tweet and a pricing page that
  does not mention circles, teams, or multi-user anything `[M]`. I could not create an account
  (waitlist-gated) and did not attempt to.
- **Real adoption.** 730 npm downloads/month is a floor, not a total — standalone `curl | sh`
  binaries bypass npm by an unknown factor. The star/watcher/download divergence is
  **measured**; its *cause* is **not**.
- **Whether 1.2.0 exists privately.** `pushed_at` on the repo is 2026-08-03 while `main`'s last
  commit is 2026-06-19, so *something* was pushed to a non-default ref today. I enumerated all
  16 branches and none is cloud-related, but a private repo or a deleted branch is entirely
  possible. My claim is narrow and defensible: **1.2.0 is not publicly installable**, which is
  what the waitlist page instructs a stranger to do.
- **Team size beyond commit attribution.** Cosmic Stack's org page shows no public members;
  contributor counts are a proxy, not a headcount.
- **Funding.** `cosmicstack.ai` lists an `investors@` address and calls itself a "research and
  product lab" but discloses no round, investor, or location. `[N]`
- **Posts 1–3 of the tweet thread verbatim.** Read through a summarizing proxy only; post 4 is
  verbatim and double-sourced.

### Two method notes worth recording

Both of these were live traps in this session, and both are already in `AGENTS.md`:

- A first grep of `SWARM-CLOUD.md` for "access plane" and "cross-owner" returned empty **while
  running from the wrong working directory**. Re-run with an absolute path plus a positive
  control (`grep -c signal` → 4) and a negative control (`zzqqxx` → 0), the terms are genuinely
  absent from the canonical spec — the cross-owner model lives in `src/`, not in the spec.
  Same conclusion, but the first zero was manufactured.
- A grep of `src/` with `--include=*.ts` **unquoted** died to zsh globbing (`no matches found`)
  and would have read as "0 occurrences of `sender_owner_relation`." Quoting `'*.ts'` returned
  seven files. This is the same family as the documented `$rev:src/...` trap: **a dead command
  wearing the costume of a measurement.** Every count in this document was taken with a positive
  control on the same invocation.

---

## 8. Recommended actions

| # | Action | Owner | Cost | Roadmap fit |
|---|---|---|---|---|
| 1 | Promote the "not a chat product" negation from `SLACK-SHAPE-UI.md` into public surface copy, shipping **with** the Slack-shaped UI | site/copy | ~1h | 0.1.6 UI shape |
| 2 | Add a fear-naming one-liner to the site — our version of "your agent stays local" (we never take custody of the runtime) | `SITE-BRIEF.md` | ~1h | any time |
| 3 | Cite Mercury's 1.2.0 waitlist as an external counterfactual in `docs/org/2026-07-26-simplification-state.md` — a live example of copy asserting an untrue deployment state (D-023's shape, someone else's repo) | doctrine | ~15m | any time |
| 4 | Put one question to the operator, unbuilt: *should a direct-to-you signal reach a human who is not looking at the dashboard?* | operator | decision | post-0.1.5 |
| 5 | Adopt nothing from §5. Re-read §5 before any "competitor has X" argument | all | 0 | standing |

**No architectural change to v0.1.5 or 0.1.6 is warranted by this analysis.** As with QM, the
most valuable output is negative: the design we are building is not threatened, and the one axis
where a competitor advertised parity turns out to be a waitlist for an unreleased binary.
