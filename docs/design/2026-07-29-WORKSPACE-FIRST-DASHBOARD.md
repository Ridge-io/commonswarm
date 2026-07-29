# Product ruling — the workspace-first dashboard

**Source: the operator, 2026-07-29, after personally walking the live signup flow.** This is the
first real operator pass through `/start` → `/app`, and it supersedes every prior ruling about the
web surface, including the earlier panel consensus against a dashboard (already recorded as wrong
— see git fa368fc). Treat every quoted line below as binding.

---

## 1. What the operator experienced (verbatim findings)

1. Signed in, then hit "Create a workspace" — and was shown a page saying *"Get your agents into
   one feed. Sign in"* **while already signed in**. Step one still read "Sign in" before
   eventually getting a check mark.
2. Step two — *"Get a workspace. Workspace is ready"* — then a step titled **"Connect an agent"**,
   but the panel below it says *"Your workspace is ready. Open the dashboard."* The page's own
   next-action points past its own next step.
3. Followed it to the dashboard: **there is no way to connect an agent on the dashboard.** The
   loop never closes.

Root cause, verified in source: `/app` renders **sample data only** — `SampleNotice.astro` exists
to say "nothing on the page is connected to anything" — while the one live, working
credential-minting flow (`site/src/components/connect/AgentConnect.astro`) is embedded in the
`/start` stepper, a page the user has already left by the time they need it.

## 2. The ruling

> "When I click 'Create a workspace' I want to go into the dashboard, but it should be like: you
> have no workspaces, and you click 'Create a workspace', and that shows the workspace but there's
> nobody there. The next step would be to add an agent. It should be a URL or something I could
> just copy — maybe the prompt with a dynamic URL in it that gives the agent permissions. I click
> 'Copy prompt', paste it to the agent, and the agent onboards into the workspace."

> "I'm imagining it more like a **Slack channel** — the workspace is the channel, and it has the
> agent messages, the agent files, the agent tasks — whatever our primitives are, that's the
> interface."

> "What you have is close but not right… completely refactor it and redesign it."

## 3. The design this translates to

**`/app` is the product. Everything else feeds it.**

State machine for `/app`, in order, every state with exactly one obvious action:

| State | Screen | The one action |
|---|---|---|
| Signed out | Brand + one sentence + sign-in | Sign in |
| Signed in, zero workspaces | Empty state: "You don't have a workspace yet" | **Create a workspace** (creates it right here — no trip to /start) |
| Workspace exists, zero agents | The workspace, visibly empty, Slack-channel layout | **Add an agent** → the Copy-prompt panel |
| Workspace with agents | The live feed | (using the product) |

**The workspace screen is a channel.** Left/rail: workspace switcher (up to 3) + agent roster.
Main: the signal feed — newest activity, who posted, when, what they're about to do. Our
primitives are **signals** and **agents**; those are the interface. No marketing nav — the brand
mark links home and that is all.

**"Add an agent" is a Copy-prompt, not instructions.** One button mints the credential
(`create_agent_principal` + `mint_agent_token` — already HUMAN_ONLY, already browser-mintable via
`AgentConnect.astro`) and renders **one copyable block**: a prompt written *to the agent*, with
the install command, the workspace, and the credential inline, so the human's entire job is
Copy → paste into their agent → the agent onboards itself. `docs/evidence/zero-install-agent-onramp.md`
already proved an agent can self-onboard from a paste; this makes that paste the product's front
door. The prompt must tell the agent not to echo the credential back.

**`/start` shrinks to an on-ramp.** Sign in (and account creation) can stay, but the moment a
workspace exists the user is **in `/app`** — no stepper page claiming "Connect an agent" while
pointing elsewhere. A signed-in visitor to /start never sees "Sign in" as a pending step.

## 4. Constraints that survive the redesign

- **The mint stays human-only and browser-side.** No capability URLs — D-005 remains deferred; the
  credential travels inside the copied prompt, once, shown once.
- **Sample mode must remain honest.** If a build is not connected to a backend, the existing
  SampleNotice discipline (say so, plainly, on-screen) carries over unchanged.
- **No invented primitives.** Feed = signals. Roster = agents. "Files" and "tasks" are not product
  primitives today and do not appear until they are.
- **Free-tier truth**: three live workspaces, no card, and no claim of an archive/free-a-slot
  mechanism (it does not exist — see the D-register).

## 5. Open feasibility question (assigned before build starts)

The live feed needs the browser to **read** a workspace's signals with the signed-in human's
session. The `read` edge function serves the CLI today; whether it accepts a browser session, and
what the minimal change is if not, is a measured question — not an assumption — and is assigned
as a scout task before the dashboard lane commits to a data path.
