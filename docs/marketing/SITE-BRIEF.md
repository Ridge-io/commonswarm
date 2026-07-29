# CommonSwarm marketing site — shared brief

Every agent working on the site reads this first. It exists so parallel work cannot
invent contradictory stories about what the product is.

## ⚠ TWO AUDIENCES, TWO SURFACES (operator, 2026-07-26) — read this first

**Agents live in the CLI. Humans do not.** Every design conversation that has gone wrong here
went wrong by collapsing those into one audience.

> "Dashboard and download buttons are for the human operators to onboard. Web UI is more ideal
> for human users coordinating. It doesn't need to be complex — the only write operation is
> creating a new setup/area to work and onboard agents into. The rest is just for
> visualisations, which can be very simple now."

**A model panel rejected "a dashboard" unanimously**, on the grounds that it is a second write
surface competing with the CLI for truth. That objection is correct **and does not apply
here**, because the proposed UI has exactly **one** write operation. The panel argued against a
strawman and the Lead relayed it. Recorded because a unanimous cross-model "consensus" was
wrong, and the reason it was wrong is that nobody had told it there are two audiences.

**So the web UI is in scope, and its shape is:**

| surface | audience | operations |
|---|---|---|
| Web UI | **humans** | ONE write: create a workspace and onboard agents into it. Everything else read-only visualisation — who is on what, what changed. Keep it simple; it can be very plain and still be right. |
| CLI | **agents** | everything else |

**A download button is for the human**, and it is how a human gets software. The panel's
argument against it was about macOS Gatekeeper mechanics, which is a packaging question, not a
reason to make a human hunt for a terminal command.

**What the panel got right and still stands:** npm ahead of `curl | sh`; no signed `.pkg` yet;
reuse the existing GitHub OAuth + PKCE rather than inventing auth; and the finding that the
real wall today is that `resolveCloudTarget` has **no compiled-in default**, so a perfect
install still dead-ends on a Supabase error.

## ⚠ PRODUCT DIRECTION (operator, 2026-07-26)

> The setup and onboarding process needs to be **consumer shaped**. Simple web UI, download
> button, simple install. **Simple. Polished. Easy.** The website should convey that with
> clean, clear, simple wording — **less is more if it's simple, like an Apple product.**

This retires the invite-only, CLI-first onboarding story this file was written around, and it
is a **product** instruction before it is a copy instruction. The page cannot look simple
while describing a flow that is not.

What it implies, in order:

1. **A download button, not a `curl | sh`.** A pipe-to-shell is a developer-tolerated ritual,
   not a consumer one. The installer we built stays as the advanced path.
2. **A web UI.** There is none today. Onboarding currently cannot happen without a terminal,
   and no amount of copy fixes that.
3. **Self-serve, not per-person invite links.** An invite link cannot come off a public page —
   that constraint is what forced every awkward compromise in this brief.
4. **Copy: less is more.** Short lines. No jargon. The retired vocabulary table below is still
   right about what to avoid, and now the bar is higher: cut anything a non-expert would stop on.

**Name: CommonSwarm, decided (operator, 2026-07-27).** The binary and every typed command
are `cswarm`. This replaces the earlier `coswarm`, which collided with a competitor in the
same space — that is the whole reason for the change, and it is not open for relitigation.
The superseded line, kept dead so nobody re-derives it: ~~"Name: `coswarm`, decided."~~

**Domain: `commonswarm.com`, decided AND LIVE** (2026-07-29): Cloudflare DNS, apex + www
answer 200, mail delivers. Write copy against it; it is the public URL.
The superseded ruling, kept dead: ~~"NOT WIRED. DNS is parked and nothing serves it. Do
not write copy claiming the site is live there. The live URL today is
`https://coswarm-site.vercel.app`."~~ — dead since the repoint; the sweep caught this line
still forbidding the true claim.
`coswarm.dev` belongs to a live, unrelated product and must never be referenced; see the
hazard note in `site/astro.config.mjs`.

Everything below predates this and should be read as history unless it is about honesty rules,
which still bind: no invented facts, no fake social proof, every command real.

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

## What CommonSwarm actually is — GROUND TRUTH, DO NOT EMBELLISH

Multi-human, multi-agent **coordination cloud service**. The cloud evolution of the
local `swarm` CLI. It is a **CLI plus a hosted service plus a web front door** —
self-serve signup at `/start`, a dashboard at `/app` (workspace-first redesign chartered
2026-07-29). Two superseded claims, kept dead: ~~"There is no web UI."~~ and
~~"Status: P3-1, invited dogfood. Pre-launch. Not self-serve yet."~~

Status: **P3-1, open free tier.** Self-serve signup is LIVE (`SWARM_SELF_SERVE=1` in
production since 2026-07-28): a stranger creates their own workspace at
commonswarm.com/start — free, three workspaces, no card, no invitation.

Real, shipped surface (from `cswarm --help`, verified):

- Auth: `login` / `logout` — GitHub OAuth with PKCE.
- Membership: `invite --email`, `accept <cswarm://accept/...>`, `workspaces`, `use`.
- Signals (intention sharing): `working-on`, `note`, `ask`, `feed`, `inbox`.
  These take `--about <ref>`, `--to <member>`, `--until <dur>` (capped 30d).
- Authority core: `principal create`, `token mint` (bound to principal + run + task +
  epoch, with a TTL), `command <kind>`, `dogfood`.
- Install: `curl -fsSL <url>/install.sh | sh` → `~/.local/bin/cswarm`, checksum
  verified, no sudo. Requires Node >= 24.

### ⚠ THE DIFFERENTIATOR WAS WRONG. THIS SUPERSEDES IT. (2026-07-26)

**The retired framing, kept so nobody re-derives it:** "coswarm optimises for authority —
who authorised this, what is this agent allowed to do, what actually happened." I wrote
that, every seat inherited it because I told them to, and it produced a hero reading
"Every agent action, authorised and on the record" over a demo captioned "Ask the agent to
do something it was never granted. Watch the refusal get written down."

The operator's verdict, and it is correct: that reads as *"a super annoying system where
you can't do what you want and you get blocked at every pass. That's not the benefit."*
We built a beautiful advertisement for friction.

**THE ACTUAL BENEFIT: agent-to-agent communication, so collaborators are unblocked and
don't step on each other's toes.**

Pitch's one-line reframe is the test to apply to every sentence:

> OLD — *we know what your agents did.*
> NEW — **your agents know what each other are doing.**
>
> An audit trail is written for someone who arrives later to judge. A signal is written for
> the teammate working now. Our records were always addressed to peers, and we described
> them as evidence.

Same signal plane, same leases. The difference is **who the information is for**. A lease
is not a police officer — it is how builder-2 learns that scout is already in that file.

**Refusals are a failure mode to minimise, not a feature to demonstrate.** Every refusal a
real user meets is us failing to have coordinated smoothly.

#### Vocabulary — four seats are rewriting at once and the old words will leak back

| retired | use instead |
|---|---|
| authorised | announced |
| permission | heads-up |
| refusal | "someone's already there" |
| audit trail | shared feed |
| immutable record | written once so nobody loses it |
| governed | coordinated |
| lease | a claim, so the next agent routes around it |
| enforcement | awareness |
| scoped token | keep credentials out of the hero entirely |

Rule of thumb: **if a sentence would sound at home in a compliance datasheet, it is the old
story wearing new words.**

#### On the ethos line

"Friction is justified only by irreversibility" stays in the spec and in fleet decisions.
It does **not** go in a headline — it is a sentence about friction, and putting it in the
largest type on the site makes friction the subject. It is a builder's rule, not a pitch.

#### And it binds the product, not just the copy

Safeguards now carry the burden of proof. Assume the agent is intelligent and
well-intentioned; if an act is reversible, it should not be gated. Simpler is better.

### The onboarding story — lead with this, it is genuinely clean

Every other verb needs `--url` and `--anon-key`. **`cswarm accept <link>` does not.**
That single exception is the entire first-run narrative and the installer already
points at it:

```
curl -fsSL <url>/install.sh | sh
cswarm accept <invite-link>
cswarm working-on "wiring the payments webhook"
```

Three lines, no configuration. That is our "one link".

### ⚠ SETTLED — THE QUICKSTART IS TWO LINES. Line 3 is false. Do not relitigate.

Two seats established this independently, by different methods, and they agree:

- **Vane, by source trace.** `src/cli.ts:295-299` — `target()` is the sole resolver for
  every command and reads exactly two sources: the `--url` flag and `SWARM_CLOUD_URL`.
  Nothing reads disk.
- **Ledger, by execution against a real store.** `sha256("https://<ref>.supabase.co")[:24]`
  equals the profile filename exactly. The store holds two files, the profile schema has no
  url field, and grepping every file under `~/.coswarm` for a URL returns nothing — with a
  positive control proving the grep matches when a URL *is* present.
  (That measurement was taken before the rename; the config directory is now `~/.cswarm`.
  The path measured is left as written because that is what was measured.)

The URL is the **lookup key**, and a one-way hash cannot be reversed into the project you
logged into. The CLI must be told the URL every time **by construction, not by omission**.

**Open bound, recorded and non-blocking:** nobody has run a real `accept`. It could in
principle write an *additional* last-project pointer that neither seat's store ever held.
Three things argue against it — no url field in the schema, only two files and no config,
and the `--url` error offers env vars rather than "your saved project" — but it is not
proven. Copy sets at two lines regardless. The asymmetry decides it: being wrong this way
costs a slightly more modest quickstart; being wrong the other way ships a first command
that does not run.

The honest third line exists and is simply longer. Use this form on the site:

```
cswarm working-on "wiring the payments webhook" \
  --url https://<ref>.supabase.co --anon-key <key>
```

or export `SWARM_CLOUD_URL` and `SWARM_CLOUD_ANON_KEY` once. Both are copy-pasteable and
true. The flagless form is not.

A fix is in flight (Quill): a current-target pointer with precedence flag > env > stored.
**Until it lands and is tested, copy describes today's behaviour, not the fix.**

### The original draft below is kept for the record — its third line is FALSE

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
- ~~**There is no working paste we can give a stranger today.**~~ — **dead** (2026-07-29):
  `curl -fsSL https://commonswarm.com/install.sh | sh` works for any stranger, and
  commonswarm.com/start needs no per-person link. What survives of the old rule: an invite
  link is still per-person and still cannot come off a web page. Any command block on the
  site either carries its own exports/flags inline, or it is presented as *what you run
  once you are in* — not as
  something the reader can run right now.
- This is Charter §6 item 1 wearing marketing clothes. It is a product gap, not a
  copywriting problem, and copy must not paper over it.

## Hard rules — non-negotiable

1. **No invented facts.** No fake testimonials, no customer logos, no fabricated
   metrics, no "trusted by N teams", no made-up benchmarks. We have no customers yet.
   A marketing site that lies is worse than no site.
2. **No fake social proof of any kind**, including invented GitHub stars or user counts.
3. Do not claim SOC2 — it does not exist. The wider superseded rule — ~~"Do not claim a
   web UI, a free self-serve tier, or SOC2. None exist."~~ — is **dead** (2026-07-29): the
   web UI and the free self-serve tier both exist and are live, and this line spent a day
   actively blocking the D-023 fix. Claim them; they are true.
4. Availability is stated honestly, and today that means OPEN: signup is live, free,
   three workspaces, no card. The superseded framing — ~~"'Invited dogfood' is a
   *scarcity* asset"~~ — is **dead**: the product is not invite-only, and the codex
   consumer critique showed where that frame leads once it stops being true (D-023).
5. Every command shown on the site must be copy-pasteable and real. If you show it, a
   reader must be able to run it. Verify against `cswarm --help`.
6. Accessibility is part of AAA: real contrast ratios, keyboard focus states, reduced
   motion honoured, semantic landmarks, alt text.

## Stack

Astro + Tailwind, deployed to Vercel. Static output. No external runtime deps in the
page. Target: Lighthouse 100/100/100/100, and it must look right at 375px.

---

## Load-bearing coupling — read before editing any heading

The page is a **decision set**, not a list of independently-correct parts. Two elements are
only honest *in combination*, and changing either one alone silently breaks the page:

| heading | command shown | result |
|---|---|---|
| "What you run once you're invited" | carries `--url` / `--anon-key` | **honest** |
| "Getting started" | carries `--url` / `--anon-key` | **a broken promise** — implies a stranger can run it |
| "What you run once you're invited" | bare, no flags | needlessly grim, and false once the fix lands |

**The heading is load-bearing copy that looks like decoration.** That is precisely why it is
the element most likely to be "tidied" by someone improving the page, and why this note
exists. Pitch's rule: the heading and the command block should live in **one constant**, so
they cannot drift apart. The commands already share a single block in `HowItWorks.astro`
that feeds both display and clipboard — if the heading sits outside that block, it can drift.

### The gate for moving to the flagless form — stated as a command, not as prose

Run, with a stored login and no flags:

```
cswarm working-on "x"
```

- **prints `--url is required`** → keep the flag-carrying command *and* the "once you're
  invited" heading.
- **succeeds** → Quill's target persistence has landed; move to the bare command *and* the
  friendlier heading.

**Both lines move together or neither moves.** This exists to stop copy shipping ahead of
code.

### Why this section exists at all

Two rulings this session were each individually correct, individually reviewed, and unsafe
*in combination* — "fix the binding, drop the timer" plus "delete the binding fields", and
"delete the mint surface fields" plus "server generates run_id". Neither was findable by
reviewing either decision alone.

**Doctrine: when a decision set grows, someone must review the set, not the items.** Applies
to copy exactly as it applies to code.
