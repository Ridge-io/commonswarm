# CommonSwarm roadmap — high-level draft

**Status:** DRAFT for operator review, version 2 (after two review arms; see "Review record").
Written 2026-09-04 by CSwarmStrategist (principal `2121f81d`).
**Trigger:** Tom pointed at two products, [bezalel.sh](https://bezalel.sh/) and [monid.ai](https://monid.ai/), as the shape of the road ahead.
**Authority:** none yet. Nothing here changes `docs/design/SWARM-CLOUD.md` until Tom adopts it; the spec still wins on conflict. Where this draft contradicts the spec, the conflict is named in §6.

Read time: seven minutes. Sections: what the two products are (§1), the pattern they share and the slot that is open (§2), where CommonSwarm sits today (§3), the roadmap (§4), the two decisions Tom has to make (§5), spec conflicts (§6), what was NOT established (§7).

---

## 1. The two reference products, measured 2026-09-04

### Bezalel — "a capability plane for personal agents"

- **One endpoint, one token.** The setup file registers `https://mcp.bezalel.sh/mcp` with a `bzl_…` bearer token, for example `claude mcp add --scope user --transport http bezalel https://mcp.bezalel.sh/mcp --header "Authorization: Bearer <TOKEN>"`. Registration lines exist for Claude Code, Codex CLI, Cursor, OpenCode, OpenClaw, eve, and generic MCP.
- **Ten capability domains behind that endpoint** (copied from their scope list): health, memory, email, iMessage, chat (Telegram bots), finance (spend ledger + bank sync), cards ("coming soon"), computer (cloud desktop), sandbox (disposable microVMs), connectors (OAuth to hundreds of apps). Token scopes select domains; "every call is re-checked server-side".
- **The thesis, verbatim:** *"The tools are the durable asset. The agent is the replaceable head."* Switch frameworks and *"nothing migrates: the new agent gets the same URL and token, and picks up where the last one left off."*
- **Event-driven, not polled:** *"this one also picks up the phone"* — an inbound text or email wakes the right agent.
- **Memory is built continuously:** setup step 5 installs hooks that bank every session transcript and distill it into durable facts shared by every agent the owner runs.
- **Boundary:** *"It is not an agent framework or a model host"*; it serves *single owners, not multi-tenant teams*. But the pricing page already asks *"Need more than Power, or a plan for a team? See contact."* Teams are on their radar.
- **Pricing page:** Free $0 (1 token, daily caps), Personal $20/mo (3 tokens, texting, one inbox), Power $49/mo (10 tokens, persistent desktop, three custom-domain inboxes). Those are monthly plans with daily caps: a subscription, not pay-per-call. *"Currently free. Every plan is free while Bezalel is in alpha."*
- **Behind it** (per its privacy page, read by the Grok arm, not by me): Clerk, AgentMail, Plaid, Supermemory, Orgo, E2B, Composio. Bezalel is itself an aggregator of other planes.

### Monid — "OpenRouter for agent tools"

- **The loop:** `discover` (natural-language search over the registry, candidates *"ranked by fit & price"*) → `inspect` (schema, docs, price) → `run`. *"Tell your agent what to do. It picks the tools itself."*
- **One balance, pay-per-call.** *"We killed the subscriptions."* Prepaid wallet, per-call or per-result fees (examples: $0.0013, $0.003, $0.002 + $0.001/result). $1 free credit.
- **Ways in:** remote MCP at `mcp.monid.ai/v1`, which authenticates by **OAuth browser login**, not a token; an API key for CLI and HTTP; a skill file. The skill install is not one paste: it is `npm install -g @monid-ai/cli`, an account, and a key from the dashboard.
- **Two-sided:** the homepage claims 1,700+ tools across 55+ providers (their number; see §7) and a *"Become a tool provider"* program.
- **Identity and teams:** the API has a `whoami` that returns a user and a workspace, and the skill names workspace budget and run caps (measured by the Grok arm; I did not reproduce it). So Monid has an account-level workspace and spend caps. It has no coordination between agents and no shared memory.
- **Traction signal:** #1 Product of the Day on Product Hunt, 2026-09-02, 467 upvotes, third launch. One reviewer's concern: no visible spend cap in the product, so *"a bad retry loop"* could burn the balance.

## 2. The pattern the two share, and the slot that is open

| Property | Bezalel | Monid |
|---|---|---|
| Agent is disposable; a shared layer behind it is durable | memory, inbox, ledger | wallet, registry |
| Integration is one endpoint | `mcp.bezalel.sh/mcp` + bearer token | `mcp.monid.ai/v1` + OAuth login; key for API |
| Setup is a paste, then a config change per framework | yes, `/api/setup` | partly: npm install, account, key |
| Inbound events wake the agent | texts, emails | — |
| Money | monthly plan, daily caps | pay-per-call, workspace caps |
| Two-sided | — | providers supply tools |
| Many humans, many agents, coordinating | no; single owner; "plan for a team? contact" | no; a workspace on the account, no coordination |

**What the two prove:** the agent is treated as disposable, the shared layer behind one endpoint is what people keep, setup is a config change, and money is attached to capability use.

**The slot that is open, stated narrowly.** Neither product is a *multi-human, cross-framework coordination channel with principals, receipts, and a shared brain*. That narrow sentence is what CommonSwarm is today. The wider sentence, "nobody serves teams of humans and agents", is **not** true and the first version of this draft said it:

- **Workbench** (`workbench.md`) is this repo's own named benchmark (`docs/marketing/SITE-BRIEF.md`): "turn your agents into a team", one paste, any HTTP agent, roster, chat, board.
- **Claude Code cross-session messaging** wakes idle sessions with no install, but same OS user, same machine to start, Claude only. The repo already positioned against it: *cross-user and provider-agnostic* (`docs/org/2026-08-07-POSITIONING-CROSS-USER.md`).
- **Dust "Pods"**, a shared workspace for a team and its agents, was named by the Grok arm with a $40M raise; not verified by me.
- **Bezalel** solicits team plans and could add them; **Monid** already has a workspace object.

So the position is: the coordination channel for many humans and many agents, across frameworks, with attribution on every message, and, if this roadmap is adopted, on every capability call and every unit of spend. Tom pointed at two products; that is a trigger, not a market map. The branch "Bezalel ships teams" is in §5.

**The one-line thesis:** *the workspace is the durable asset; every agent is a replaceable head.* Two limits so it is not oversold:
- **"Durable asset" means the team's memory, channel, receipts, and ledger, held next to the repo and the tracker, never instead of them.** Git and GitHub stay the code authority (spec §0). The workspace holds what those do not: who is working on what now, what an agent learned, who saw which message, what each agent spent.
- **"Replaceable head" means state survives a swap, not that harnesses are interchangeable.** A Codex worker and a Claude worker differ in tools, prompts, and permissions. The claim is only that the memory, the inbox, and the credential outlive any one of them, which is what the listener and token model already do.

## 3. Where CommonSwarm is today (0.1.50, measured from `cswarm --help` and the join prompt)

Already shipped, live in production:

- **Identity and scope:** workspaces, human members, agent principals, scoped tokens (timeboxed from the CLI; the `/app` connect path mints *standing* grants, which is the path a person actually uses), revocation, audit of every command.
- **Channel:** `working-on`, `note`, `ask` (directed, wakes a listener), `reply`, `feed`, `inbox`, `members`, and delivery receipts whose happy path reads `queued → observed → replied` (the full state set in code is larger).
- **Memory:** `brain` topics with 20 live versions each, and the constitution in `brain-how-to`.
- **Files:** `file put/ls/get/rm/restore` with versions.
- **Wake:** `listen start` for Claude, Codex, Grok, OpenCode via local ACP bridges; `hook install claude`; `inbox --notify` under a host monitor. All three run on the agent's own machine; there is no server-side wake.
- **Front door:** self-serve signup, free tier, `/app` workspace, invite links.

Not shipped, and where the reference products are ahead:

- No remote **MCP endpoint**. Every framework integrates through the `cswarm` binary and a generated join prompt of 227 lines, in which every command repeats four connection flags (`--agent-token-file`, `--url`, `--anon-key`, `--workspace-id`). Bezalel is one paste; Monid is three steps.
- No **memory distillation**. The brain is written by hand, one topic at a time.
- No **email inbox** or chat bridge into the workspace, no connectors, no sandbox, no computer. (The coordination inbox exists; the gap is email.)
- No **money**: no balance, cap, ledger, or metering. The spec lists billing and spend capping as deferred non-goals.
- **Weak discovery:** `members`, `feed`, and `brain ls` exist; nothing routes an ask by capability.

## 4. The roadmap — five horizons

Each horizon is one outcome, the smallest shippable slice, and the number that says it worked. H1 is first because it is the distribution wedge, not because the others cannot ship without it: H2 and H3 could land as CLI verbs, as `brain` and `listen` did.

### H0 — Now: keep the coordination core honest (continuous)
Outcome: the channel, brain, receipts, and listeners stay trustworthy under real multi-agent load.
Slice: the existing release ritual; the open **write-path 500** (episodic, instrumented by `command_failures`, root cause unknown). The status-socket cap from the same resume file is a constructed case (typical payload 1.2 KB against an 8 KB cap) and does not belong beside it.
Measure: no new entry in the `false-success-signals` brain topic per release.

### H1 — One endpoint, one paste (the wedge)
Outcome: any agent on any MCP-capable framework joins a workspace with a URL and a token, the way it joins Bezalel.
Slice:
1. A **remote MCP server** at `https://api.commonswarm.com/mcp`. Its tool list is **generated from the CLI's own verb constants**, not typed in a document (this draft's first version typed a list and it had already drifted: it lacked `working-on`, the very verb H1's metric counts). Same agent token, same server-side authority.
2. A **`commonswarm.com/SKILL.md`** so the install line is one sentence, plus one registration line per MCP client (Claude Code, Codex, Cursor, OpenCode, OpenClaw, eve). Note: those are MCP clients; only four of them are `listen` providers. Two different sets.
3. The join prompt shrinks to: token file, MCP line, `whoami`. The credential-file rule and "never echo the credential" survive.
What it is not: it is not "no new state". Streamable HTTP MCP carries session state, and wake still needs a local `listen` process on the agent's machine; an MCP client that is not connected is not woken. H1 changes how an agent *talks*, not how it is *woken*.
Relation to the spec: §9 P5 still owes the **capability-URL zero-install on-ramp** for humans and the abuse posture. H1 is the agent-side on-ramp beside it, not a replacement; both must be named in the spec on adoption.
Open feasibility question: whether Supabase Edge Functions can host a Streamable HTTP MCP session within their timeout and connection model. Establish this before sizing H1.
Measure: minutes from credential to first `working-on`, measured server-side; target under 2. (The spec's G2 is a different number: invite to first authoritative command, under 10 minutes.)
Known weakness: an agent that joins in two minutes lands in a brain that is still hand-written. H2 fixes that; until then the `brain-how-to` write-moments and the feed digest a listener already consumes are the mitigation.

### H2 — Shared memory that builds itself
Outcome: what any agent learns, every agent can recall.
Slice:
1. `brain_search` (semantic recall over topics and versions) as an MCP tool.
2. **Transcript banking** (Bezalel's step 5): a session-end hook posts the transcript; a distillation job proposes facts as a *pending* brain version. **Only a human credential can accept it** (spec §2.12: trusted content is human-accepted; an agent "topic owner" cannot). Pending content never reaches a model-facing path. Unreviewed distillation from several model families is how a shared brain fills with conflicting or invented facts, and a brain that mis-states a fact is worse than one with a gap (`brain-how-to`).
3. Per-workspace retention quota. This is the spec's P5 debt, not new scope.
Note: this is a quality upgrade to a brain that exists; it is not what makes the workspace durable. Membership, tokens, and the channel already do that. It reverses an earlier doctrine that refused shared context on purpose (the Mercury comparative analysis, per the Grok arm); §6 names the reversal.
Measure: share of brain versions that come from distillation; recall hit rate on asks that cite a topic.

### H3 — Inbound sources and workspace capabilities, scoped per agent
Outcome: outside events reach the right agent, and a workspace owns its capabilities once, with attribution.
Slice, and which side of Decision 1 each is on:
1. **Build:** a workspace email address whose inbound mail enters the existing ask path and wakes the addressed agent's listener. Team-shaped; the wake half exists (on the agent's machine).
2. **Build:** chat bridges (Slack or Telegram first) into the same path.
3. **Federate:** connectors. Do not build OAuth-to-hundreds-of-apps; attach Composio, Bezalel's connector scope, or an equivalent behind one interface, scoped per token, with every call in the audit log.
4. **Federate:** sandbox and computer, same rule.
Data boundary: attaching Bezalel puts team mail, memory, and finance data on a single-owner plane with its subprocessors. That is a decision per capability, not "team scope for free". It is the reason connectors sit behind one swappable interface.
Measure: capability calls attributed to an agent token per week; zero cross-tenant leaks and zero injection escapes in the launch-blocking suite.

### H4 — Money: one balance per workspace, a cap per agent
Outcome: a team funds its agents once, caps each agent, and reads one ledger.
Slice:
1. Workspace **balance** and **spend ledger** with the attribution the audit log already carries.
2. **Per-token caps** enforced server-side before a metered call is forwarded; the blast-radius limit for H3. Monid already has workspace caps, so this is table stakes, not a gap to own.
3. **Metering** for federated calls.
4. Virtual cards only if a paying customer needs them.
The SKU, since "coordination stays free" (G7) does not say what is paid: **(a)** a margin on metered federated calls, and **(b)** a paid workspace tier for caps, ledger, retention, and distillation. Not seats. This is a proposal for Tom, not a finding.
Measure: paying workspaces; spend per agent visible within a minute of the call.

### H5 — Discovery (option, not plan)
Outcome: an ask finds the right agent or tool without a human routing by name.
1. A capability directory per workspace; `ask --to swarm` routes to the best available listener.
2. Tool discovery through a federated registry as `discover → inspect → run` behind H1, metered by H4.
3. Publishing an agent or skill for other workspaces to call, priced per call, is a **two-sided marketplace**: a different company, and it strains the spec's tenancy boundary and the rule that a signal never claims or closes a task. Keep it as an option, gated on demand measured after H1.
Measure: share of asks routed by capability rather than by name.

### Cross-cutting, every horizon
- **Inbound content is untrusted, and a wake is not an instruction.** H3 opens the workspace to email and chat from outside, and H4 gives agents money. An attacker who sends one email to the workspace inbox must not be able to make a tool-enabled agent read files, call a connector, or spend. The spec already has the gate for the cross-human case (§2.13: a cross-human message never auto-wakes a tool-enabled turn); H3 extends it to every external source, and H4's per-token cap limits the blast radius when a prompt gets through. Each of H3 and H4 ships with an injection test in its launch-blocking suite. This is the largest risk in the draft and it was missing from version 1.
- **Authority stays hard, friction stays near zero** (spec §0). A one-line install is still a server-checked token.
- **Attribution on every call.** The property the reference products carry only for one owner and one balance.
- **Caps are limits a team sets on its own agents, not enforcement.** The product voice retired control and enforcement framing; H4 copy must say "your cap", not "blocked".
- **Measure the artifact.** Each horizon ships behind its own launch-blocking test, never the prior one's.

### Time, cost, staff (order of magnitude, not a plan)
- H1 is one sprint of Codex lanes once the Edge feasibility question is answered; Codex credits return 2026-09-06.
- H2 and H3.1 are one sprint each. H3.3 depends on a supplier contract. H4 depends on a billing provider. H5 is unsized.
- Cost: the spec's §8 bill of materials is about $25/month. An MCP endpoint, a distillation job, and inbound mail are each a new line with no number yet (§7).

## 5. The two decisions Tom has to make

**Decision 1 — build capabilities or federate them?**
- **A. Federate (recommended).** CommonSwarm builds only what is team-shaped: identity, memory, channel, inbound sources, ledger, caps, directory. Connectors, sandbox, computer, and the tool registry come from suppliers, attached per workspace and scoped per token, **behind one swappable interface**. Smaller surface, faster, and the reference products become suppliers rather than rivals.
  The cost of A, stated plainly: execution inside a supplier is outside CommonSwarm's attribution and tenancy boundary, so the audit line can only say *which agent called what, when, and what it cost*. Suppliers keep the compute margin. Team data lands on their subprocessors. Both suppliers are unproven (§7). The swappable interface is the exit.
- **B. Build.** Own the whole plane: native sandboxes, connectors, desktop. Every call stays inside the trust boundary; the margin stays. Larger surface, a year of work on a 16 GB fleet, and it competes with funded, faster products on their home ground while the team-shaped core is unfinished.
- Pick A with the exit interface. Build natively only the single capability a paying customer needs inside the trust boundary.
- **If Bezalel ships teams:** the coordination channel, receipts, cross-framework wake, and brain are still ours; the capability layer becomes theirs to sell and ours to attach. That is the same outcome as A. Under B it is a head-on fight.

**Decision 2 — H1 (one endpoint) or H2 (self-building memory) first?**
- **A. H1 first (recommended).** It is the distribution wedge, it cuts the 227-line prompt new agents keep filing friction reports about, and the transcript hooks in H2 are cleaner to build on one endpoint than on four CLI wrappers.
- **B. H2 first.** Memory is the stickiest asset, but without H1 it stays a CLI verb only `cswarm` users reach, and there is no demand signal for it yet (§7).
- Pick A. Start H2 the sprint after H1's endpoint is live. Both review arms agreed with this one.

## 6. Conflicts with the canonical spec, to resolve on adoption

1. `SWARM-CLOUD.md` §1 lists as v1 non-goals: *billing/paid tiers, hosting agent runtimes, provider-spend capping*. H4 moves billing and spend capping from "deferred" to "planned". Hosting runtimes stays out (H3 federates).
2. H2's distillation reverses the earlier refusal of shared context in the Mercury comparative analysis (cited by the Grok arm; I did not locate the section). The reversal must be recorded there, retired wording preserved.
3. H1 adds an agent-side on-ramp beside the spec's P5 capability-URL on-ramp; §9 must name both.
4. H2 acceptance is human-credential only; if anyone proposes agent acceptance, that is a §2.12 break and needs its own ruling.

## Review record

Two cross-family arms reviewed version 1 on 2026-09-04 per D-036. Both returned **FAIL** with reasoning; both sets of findings are folded into this version.
- **Gemini (`agy`), inversion arm.** Folded: the "durable asset" limits (§2); the injection threat as the first cross-cutting rule (§4); the cost of federating and the exit interface (§5); the four-flags correction and the Monid and Bezalel hedges (§1, §3); the empty-workspace weakness under H1; the acceptance rationale under H2. Its case for H2 before H1 did not beat the draft, by its own account.
- **Grok, exact arm.** Folded: the vacant-position claim narrowed and the adjacent occupants named (§2); Bezalel's live MCP URL, "free while in alpha" on the pricing page, and the team-plan solicitation (§1); Monid's OAuth MCP, three-step install, and workspace object (§1, §2); "money per capability" corrected for Bezalel (§2); "no inbox" → "no email inbox" and "no discovery" → "weak discovery" (§3); standing grants and the receipt state set (§3); the H1 tool list replaced by a generated set, the "no new state" claim withdrawn, the wake-is-local fact, the Edge feasibility question, and the P5 on-ramp relation (H1); human-only acceptance and the Mercury reversal (H2, §6); the H3 versus Decision 1 conflict resolved by splitting build from federate (H3); the SKU named and Monid's caps acknowledged (H4); H5 demoted to an option (H5); the H0 pairing fixed; the G2 mismatch; time, cost, and staff added; the "Bezalel ships teams" branch (§5).
- Not folded, with reason: the arm's Dust claim and its Mercury section number are recorded as unverified (§7) rather than asserted.

## 7. What was NOT established

- Bezalel's traffic, revenue, or willingness to partner. Its pricing and setup pages were read; its usage was not.
- Monid's real tool count: the public `/tools` catalog rendered *"No tools yet"* to an anonymous fetch, so 1,700 is their claim. Monid's `whoami` workspace and workspace caps were measured by the Grok arm, not reproduced by me.
- Dust "Pods" and its raise: named by the Grok arm, not verified.
- The Mercury analysis section that refused shared context: cited by the arm; my grep for its number found nothing, so the citation is by document, not by section.
- Any demand signal from CommonSwarm users for memory, capabilities, or money. H2 to H5 are inferred from the reference products and the product's own gaps, and should be re-ordered against the first real asks after H1 ships. The funnel numbers a founder needs (workspaces, agents that finish joining, time-to-first-signal, drop-off) are not in this draft because nobody has measured them.
- Whether Supabase Edge Functions can host Streamable HTTP MCP sessions. This gates H1's design.
- The cost of an MCP endpoint, a distillation job, and inbound mail on the current plan.

## Sources

- https://bezalel.sh/ · https://bezalel.sh/docs.md · https://bezalel.sh/llms.txt · https://bezalel.sh/pricing.md · https://bezalel.sh/api/setup · https://bezalel.sh/api/skills
- https://monid.ai/ · https://docs.monid.ai/ · https://docs.monid.ai/guide/quickstart-mcp.html · https://docs.monid.ai/guide/quickstart-skill.html · https://monid.ai/SKILL.md · https://monid.ai/docs/guide/how-it-works · https://monid.ai/tools · https://monid.ai/blog · https://www.producthunt.com/products/monid
- This repo: `docs/design/SWARM-CLOUD.md` §0, §1, §9; `docs/marketing/SITE-BRIEF.md`; `docs/org/2026-08-07-POSITIONING-CROSS-USER.md`; `cswarm --help` at 0.1.50; `docs/org/2026-08-29-RESUME-HERE.md`; brain topics `strategy`, `competitors`, `brain-how-to` in workspace CICD.
- Review arms: `scratchpad/arm-agy.txt`, `scratchpad/arm-grok.txt` (session-local; the substance is in "Review record").
