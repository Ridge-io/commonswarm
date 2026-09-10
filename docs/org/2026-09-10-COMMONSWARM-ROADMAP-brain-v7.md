<!-- Snapshot of CommonSwarm brain topic commonswarm-roadmap, version 7, taken 2026-09-10 by CSwarmStrategist (2121f81d). The brain topic is the live copy; this file is the repo record. The 2026-09-04 draft (docs/org/2026-09-04-ROADMAP-DRAFT.md) is version 2 of the same document and is kept. -->

# commonswarm-roadmap — what the two reference planes are, the slot CommonSwarm holds, and the proposed horizons

**What question does this answer:** what did we measure about bezalel.sh and monid.ai, what position does CommonSwarm hold relative to them, and what is the proposed roadmap and the two decisions waiting on Tom?

Verified as of: 2026-09-06 (v2: operator rulings added). Owner: CSwarmStrategist (principal 2121f81d). Full draft on `main`: `docs/org/2026-09-04-ROADMAP-DRAFT.md` (version 2, both D-036 arms folded). Status: DRAFT with two operator rulings (below); `docs/design/SWARM-CLOUD.md` still wins on conflict.

## The two products, one line each (measured 2026-09-04)
- **Bezalel** (`bezalel.sh`): a capability plane for ONE owner's agents. One MCP endpoint `https://mcp.bezalel.sh/mcp` + `bzl_` bearer token gives memory, email, iMessage, chat bots, finance, cards (soon), cloud computer, sandbox, connectors; inbound text/email wakes the agent; transcript-banking hooks build memory. Thesis: "The tools are the durable asset. The agent is the replaceable head." Pricing page $0/$20/$49 monthly with daily caps; "every plan is free while Bezalel is in alpha"; "a plan for a team? See contact." Built on Clerk, AgentMail, Plaid, Supermemory, Orgo, E2B, Composio.
- **Monid** (`monid.ai`): "OpenRouter for agent tools." discover → inspect → run over a registry; one prepaid balance, pay-per-call; MCP authenticates by OAuth browser login, API key for CLI/HTTP; install is npm + account + key, not one paste. Claims 1,700+ tools (public `/tools` rendered "No tools yet" anonymously). Has a workspace object and workspace budget caps on the API (Grok arm measured, not reproduced). #1 Product Hunt 2026-09-02.

## The slot, stated narrowly (the wide version is FALSE)
Neither is a multi-human, cross-framework coordination channel with principals, receipts, and a shared brain. That is CommonSwarm today. "Nobody serves teams of humans and agents" is false: Workbench (our named benchmark), Claude Code cross-session messaging (same-user, Claude-only), Dust Pods (unverified), Bezalel soliciting team plans, Monid's workspace object.

## Proposed horizons (H1 first is the recommendation)
H0 keep the core honest · H1 remote MCP endpoint + SKILL.md, tool list GENERATED from CLI verb constants · H2 brain search + human-accepted transcript distillation · H3 build email inbox + chat bridges into the ask path, FEDERATE connectors/sandbox/computer behind one swappable interface · H4 workspace balance, per-token caps, metering; SKU = margin on metered calls + paid tier · H5 discovery as an option gated on demand.
Cross-cutting: inbound content is untrusted and a wake is not an instruction (injection test ships with H3 and H4); caps are the team's limits, not enforcement.

## Operator rulings (Tom, 2026-09-06, in chat to CSwarmStrategist)
- **Push: approved.** The draft commit `b1bc496` is on `origin/main` (pushed 2026-09-06).
- **H1 (remote MCP endpoint + one-paste join): GO**, but **after** Assignment B, the spec for a proper fix of the edge-function (listener idle polling) system, which Tom routed to this seat. Order: Assignment B spec → H1.
- Decision 1 (federate vs build) was NOT ruled on; H1 does not depend on it. Still open.

## Assignment B (edge-function fix spec) — this seat's current task
Evidence: brain `edge-function-invocations-2026-09` (Finisher): 12 listeners × 2-second read+claim poll + 15 s heartbeat ≈ 1.1M invocations/day; fixes in order: raise poll constants, merge read+claim, push via Supabase Realtime with a 60 s fallback poll, server-side duplicate-listener guard. Spec branch `spec/push-delivery`, own worktree.

## Measured traps while producing this
- `agy --mode plan` never reads the file; it searches and returns no verdict. Inline the document in the prompt and run without `--mode plan`.
- The first version typed the H1 tool list and it had already drifted (no `working-on`). Enumerations the code enforces must be generated.
- Wake in CommonSwarm is LOCAL (listener on the agent's machine); an MCP endpoint changes how an agent talks, not how it is woken.

## Not established
Bezalel usage/partnership; Monid's real catalog; Dust; any demand signal from our own users; whether Supabase Edge Functions can host Streamable HTTP MCP; cost of the new lines.

## Design bar (Tom, 2026-09-06): "a system that works well, and is extremely cost efficient"
Works well = the durable row is the only truth; a lost push costs latency, never a delivery. Extremely cost efficient = idle cost must not grow with seats. Ladder measured/predicted per idle seat per day: today ≈ 53,800 edge calls → lane A ≈ 7,700 → spec B (Realtime wake + 5-min reconcile) ≈ 2,200 → + heartbeat on the socket ≈ 800 → + one cswarm daemon per machine (Tom's proposal): one Realtime connection per computer, not per seat; the model worker and the credential stay per seat (daemon routes, seat claims). Webhooks do not fit (laptops behind NAT); a self-run WebSocket server is rejected (Realtime is already in the plan). Measured on the mini: per seat ≈ 50 MB of duplicated plumbing (supervisor + bridge + watcher) beside a 65–140 MB model worker.

## Assignment B: DELIVERED 2026-09-06 (spec/push-delivery @ 93254bc reviewed, 8167227 head, pushed)
`docs/design/2026-09-06-PUSH-DELIVERY.md`, consensus-with-bounds: Opus PASS on 93254bc, Grok PASS on 82bbe7b, Gemini PASS on a793eaf (diffs between them are the stated bound and citations); Codex FAIL on 22e2bea folded, then out of credits. Seven rounds; every FAIL was a verified defect. Handed to CSwarmDevLead to lane (L0–L8, owners Grok/Gemini/Opus). Stated bound: a stored `until` shorter than the 5-min reconcile can expire after a dropped wake (explicit --until, or a thread reply clamped to a dying root).

## Next: H1 (one endpoint, one paste) — GO per Tom, after B
Feasibility research is on main: `docs/evidence/2026-09-06-h1-mcp-edge-feasibility.md` — feasible with caveats: the 2026-07-28 MCP spec made remote servers stateless (one tool call = one POST = one edge invocation), all six target clients send a static bearer header, use `responseMode: 'json'` (never hold a stream open past 150 s), return 401 without resource_metadata so clients do not start OAuth, option A (the `mcp` function forwards to `/command` and `/read` over HTTP) first. Next step: a hello-world stateless `mcp` function under `supabase functions serve`, connected from Claude Code, before the H1 spec is written.

## Push delivery IN PRODUCTION (0.1.59/0.1.60, 2026-09-06, measured by CSwarmDevLead)
Wake latency mean 526 ms (spec target < 1 s: met). Idle listener 70 → 43 edge calls per 10 min; audit rows ~220/min → a few/min fleet-wide. What remains of idle cost is ~90 % the activity heartbeat, so **successor 1 (presence on the wake socket) is now the top cost item on the roadmap**; successor 2 (one cswarm daemon per machine) follows it. Open from the ledger: one unexplained `channel_error` after a reconcile on 0.1.58 (watch on 0.1.59+); L2b (idempotency floor) deferred until `idempotency_keys` grows; spec §4.1 said 25 s watcher poll where the code says 60 s (fixed on main).

## Operator ruling (2026-09-06, relayed by CSwarmDevLead in ec256368): session-first delivery

**The ruling:** a signal must wake the EXISTING long-lived session and ask it to read the message. A headless worker answering in a seat's name breaks the point of CommonSwarm, which is interacting with the sessions that hold the context. Applied the same day: every Claude manager seat and Joist run `--route main` (no model started). The strategist seat's own worker listener, which had answered five signals in its name that day, is stopped and will not return (record: brain `listener-attended`).

**Roadmap items that follow, in order (owner: CSwarmStrategist; each gets a spec before a lane):**
1. **Route main becomes the product default; worker is an explicit opt-in.** `listen start` without `--route` means main; `--route worker` and `split` require the flag and are refused when a hook surface for that principal is live, because a live surface proves a session exists to wake. Cost side: a main-route listener starts no model, so it is also the cheaper seat.
2. **The main session is told what arrived and never has a stand-in answer for it.** The hook already surfaces arrivals; the remaining gap is any worker reply ever made in a seat's name: `listen status` and the hook must show "answered by worker at <time>" for the audit, and nothing else answers in a live seat's name.
3. **Grok worker seats** (CDReporter; MrSEO, MrAnalyst, MrMarketing, MrBenchmark on the operator's laptop) still answer headlessly. Per seat: does a live session exist to wake, and how is a Grok TUI woken (the Claude hook has no Grok twin today)? If no live session exists, the seat is a worker by design and says so in its declaration; if one does, it moves to main once a Grok wake path is measured.

**Relation to H1 and successor 2:** the one-daemon-per-machine idea (successor 2) is unchanged; a daemon wakes sessions, it does not answer for them. H1 (MCP endpoint) is unaffected.

## Durable option (2026-09-06): one owned server instead of Supabase + Vercel
The operator asked to keep the Levelsio-style Hetzner option durable. Analysis, stack, costs, vendor count, CI box, and GitHub plan in brain topic `hetzner-option`. Not decided; if taken, it is the shape of H1 (one server carrying the MCP endpoint and the command/read API), after identity lands.
