# coswarm marketing site — shared brief

Every agent working on the site reads this first. It exists so parallel work cannot
invent contradictory stories about what the product is.

## The bar

`https://workbench.md` — a spiritual competitor and the explicit benchmark. It is very
good and we are being judged against it in a **blind side-by-side**. What it does well:

- Dark, high-contrast, enormous confident type. Headline is 5 words: "Turn your agents
  into a team."
- Orange caps eyebrow → big headline → one-sentence subhead. Repeated per section.
- The hero is not a screenshot of a homepage; it is **the product doing its job** — a
  live-looking doc with board, chat, status feed, and roster.
- **Interactive** demos, not static images: an editable markdown pane rendering to a
  live board beside it. Copy-prompt button.
- Concrete trust line: "works from `claude` `codex` `cursor` `curl` — anything that
  speaks HTTP", and a 1 link / Any agent / Free triad.
- Positioning: zero friction. "No account needed to start." "The doc is the API."

To beat it we cannot ship static marketing copy. We need equal typographic confidence
and at least one genuinely interactive demo of *our* product's actual behaviour.

## What coswarm actually is — GROUND TRUTH, DO NOT EMBELLISH

Multi-human, multi-agent **coordination cloud service**. The cloud evolution of the
local `swarm` CLI. It is a **CLI plus a hosted service**. There is **no web UI**.

Status: **P3-1, invited dogfood.** Pre-launch. Not self-serve yet.

Real, shipped surface (from `coswarm --help`, verified):

- Auth: `login` / `logout` — GitHub OAuth with PKCE.
- Membership: `invite --email`, `accept <coswarm://accept/...>`, `workspaces`, `use`.
- Signals (intention sharing): `working-on`, `note`, `ask`, `feed`, `inbox`.
  These take `--about <ref>`, `--to <member>`, `--until <dur>` (capped 30d).
- Authority core: `principal create`, `token mint` (bound to principal + run + task +
  epoch, with a TTL), `command <kind>`, `dogfood`.
- Install: `curl -fsSL <url>/install.sh | sh` → `~/.local/bin/coswarm`, checksum
  verified, no sudo. Requires Node >= 24.

### The honest differentiator — this is the whole pitch

Workbench optimises for **zero friction**: one link, no account, everyone edits a doc.

coswarm optimises for **authority**. When several humans and many agents share work,
the questions that actually bite are: *who authorised this? what is this agent allowed
to do? what actually happened?* Our answer is a governed authority core (principals,
scoped minted tokens) plus an **immutable signal plane** — an append-only record.

The design ethos, from the spec §0, and the best line we own:

> **Friction is justified only by irreversibility.** Smooth by default, hard only at
> the few genuinely irreversible acts.

That is a real, differentiated, defensible position. Lead with it.

### The onboarding story — lead with this, it is genuinely clean

Every other verb needs `--url` and `--anon-key`. **`coswarm accept <link>` does not.**
That single exception is the entire first-run narrative and the installer already
points at it:

```
curl -fsSL <url>/install.sh | sh
coswarm accept <invite-link>
coswarm working-on "wiring the payments webhook"
```

Three lines, no configuration. That is our "one link".

### ⚠ CORRECTION — the third line is NOT YET VERIFIED. Read this before using it.

Vane audited the whole surface against a build of landed `main` (e0287ba), running each
command bare exactly as a reader would paste it. Result: **six of six** — `working-on`,
`note`, `feed`, `inbox`, `workspaces`, `status` — fail with `--url is required`. The only
two commands that run bare are `--version` and `--help`, **and neither shows what the
product does**.

The three-line story above survives only if `accept` auto-saves the project, so that the
third line inherits it. The help text does claim this ("A sole accepted project is saved
automatically"), but **Vane could not test the post-accept path** — it needs a real invite
link, which is issued per person.

Consequences, and they bind:

- **Do not put line 3 on the site until someone runs it after a real `accept`.** If it
  turns out to need `--url`, the honest quickstart is two lines, not three.
- **There is no working paste we can give a stranger today.** An invite link is per-person,
  so it cannot come off a web page. Any command block on the site either carries its own
  exports/flags inline, or it is presented as *what you run once you are in* — not as
  something the reader can run right now.
- This is Charter §6 item 1 wearing marketing clothes. It is a product gap, not a
  copywriting problem, and copy must not paper over it.

## Hard rules — non-negotiable

1. **No invented facts.** No fake testimonials, no customer logos, no fabricated
   metrics, no "trusted by N teams", no made-up benchmarks. We have no customers yet.
   A marketing site that lies is worse than no site.
2. **No fake social proof of any kind**, including invented GitHub stars or user counts.
3. Do not claim a web UI, a free self-serve tier, or SOC2. None exist.
4. Pre-launch status is stated honestly. "Invited dogfood" is a *scarcity* asset, not
   an embarrassment — an invite-only developer tool is a legitimate and appealing frame.
5. Every command shown on the site must be copy-pasteable and real. If you show it, a
   reader must be able to run it. Verify against `coswarm --help`.
6. Accessibility is part of AAA: real contrast ratios, keyboard focus states, reduced
   motion honoured, semantic landmarks, alt text.

## Stack

Astro + Tailwind, deployed to Vercel. Static output. No external runtime deps in the
page. Target: Lighthouse 100/100/100/100, and it must look right at 375px.
