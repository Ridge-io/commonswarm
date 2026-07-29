# Charter — Consumer Shape, final wave

**Advisor:** Lead6 (claude) · **Issued:** 2026-07-29 · **Register:** `docs/org/DEFECT-REGISTER.md`
**Operating model:** `docs/org/OPERATING-MODEL.md` — read §2 and §4 before writing a line.

---

## 0. The mission, restated

> A **stranger** — not the operator, not a friend — can **find, understand, install, sign up for,
> and use** CommonSwarm. Free tier, no card.

Every leg of that is now live and verified in production. **This wave is about the second half
of the sentence**, which has never been audited:

> Every surface a stranger touches must be **consumer-shaped** — warm, plain, obvious — and not
> **developer-shaped** — technical, terse, intimidating, or assuming a terminal.

The product is agent-to-agent chat. The people who need it most are the ones who do not write
code. A surface that only reads well to an engineer is a defect in this wave, even if every
word on it is true.

---

## 1. What is NOT in scope

Leave these alone. They are recorded and deliberately deferred:

- DMCA registration, attorney review, USPTO clearance — external filings, TODO.md items 4/7/10.
- `SWARM_CAPABILITY_URLS` — D-005, deferred with a ruling.
- D-016 archiving semantics — needs an operator product ruling, not code.
- Anything in `supabase/functions/**` or `src/protocol/**`. This wave does not touch the
  authority core.

---

## 2. The bar

Not "is it accurate". Accuracy is assumed; this repo has spent a day on it. The bar is:

1. **Would a smart non-programmer know what to do next, on every screen, without asking?**
2. **Does any string assume a terminal, a repo, an SSH key, or a mental model of agents?** If
   yes it is a finding, even when true.
3. **Is there a dead end?** Every error, empty state and refusal must name the next action.
4. **Does it look designed?** Not decorated — designed. Spacing, hierarchy, one obvious action
   per screen.
5. **No claim we have not measured.** The D-018 rule applies to copy as hard as to code: do not
   promise a behaviour nobody has verified.

---

## 3. Hard rules

1. **One writer per lane. Lanes are file-disjoint and listed below.** Do not edit a file
   another lane owns, even to fix something obvious — report it to Lead6 instead.
2. **Work in your own worktree.** `../swarm-worktrees/<yourname>-<lane>`. The shared checkout
   is Lead6's. Two agents collided in it today (D-013); do not be the third.
3. **Never `git checkout <file>` to undo a mutation.** It silently destroys uncommitted work —
   that is D-013 row four, learned the hard way. Copy the file aside and restore from the copy.
4. **Branch per lane, push, report the SHA with a `git ls-remote` line.** Never merge. Merging
   is Lead6's.
5. **Mutation proof at the PRODUCTION CALL SITE** (§4 of the operating model, and D-018). For
   copy: the observer must read the DEPLOYED or RENDERED output, not the constant it came from.
   A test comparing a constant to itself passed a full suite today — twice.
6. **Cross-family review is mandatory and you cannot review your own family.** Claude-authored
   work goes to a codex seat. Codex-authored work goes to Lead6 or another family.
7. **Never copy a credential anywhere.** Auth-blocked is a valid terminal state; report and stop.
8. **Report outcomes, not mechanisms.** If the command I gave you fails for an environmental
   reason, achieve the outcome another way and say what you did. Do not invent an identity or a
   channel to route around a broken one.

---

## 4. The lanes

### L1 — EMAIL. The most neglected surface we own.

**Owner:** codex seat (assigned by Lead6) · **Files:** `site/emails/**` (new),
`scripts/push-email-templates.sh` (new). Touch nothing under `site/src/`.

**The finding this lane exists for.** Measured 2026-07-29 against the production Supabase
project: `mailer_subjects_custom_contents` and `mailer_templates_custom_contents` report
`False` for **every** key. All thirteen templates are Supabase stock. The magic-link email —
the first thing a non-developer ever receives from CommonSwarm — is currently:

```html
<h2>Your sign-in link</h2>
<p>Follow the link below to sign in. This link expires shortly and can only be used once.</p>
<p><a href="{{ .ConfirmationURL }}">Sign in</a></p>
```

Unstyled, unbranded, no sender identity. `smtp_sender_name` and `smtp_admin_email` are both
`None`.

**Deliver:**

- Branded, responsive HTML for the templates a stranger can actually receive:
  **magic_link** and **invite** are the two that matter most; then **confirmation**,
  **email_change**, **recovery**, **reauthentication**. The six security-notification
  templates (`*_changed_notification`, `*_linked_notification`, mfa) get the same shell and
  plain copy — they are rare but they are the ones that scare people, so tone matters more
  there, not less.
- **Email HTML is not web HTML.** Tables, inline styles, no external CSS, no webfonts, ~600px,
  dark-mode-safe colours, alt text on any image, and a plaintext-readable fallback. Assume
  Gmail strips your `<style>` block, because it does.
- One obvious action per email. The link is a button, and the raw URL appears as text
  underneath, because some clients mangle buttons.
- Copy voice: plain and calm, per `AGENTS.md` "Writing for users". Say what happened, what is
  now true, what happens next. No jargon, no "verify your identity", no threat-shaped security
  language.
- A push script using the Management API `PATCH /v1/projects/{ref}/config/auth` with the
  `mailer_subjects_*` and `mailer_templates_*_content` fields. **Do not run it against
  production** — Lead6 does that. Make it idempotent and make it print a diff of what it would
  change first.

**Observer + mutation:** a test that renders each template and asserts the required structure
(single CTA, raw URL present, no external asset references, no unreplaced `{{ }}` outside the
known Supabase variables). Mutation: break one template's CTA and show exactly that template's
test red.

### L2 — LANDING + SIGN-UP COPY. The front door.

**Owner:** codex seat · **Files:** `site/src/pages/index.astro`,
`site/src/components/landing/**`, `site/src/pages/start.astro`, `site/src/components/start/**`.
Do **not** touch `site/src/layouts/Base.astro` — that is L4's.

Audit and rewrite every user-visible string against §2. Specific known suspects:

- The `/start` flow's panel copy — it is honest but written for someone who already understands
  workspaces, principals and agents.
- Error and refusal states. There are typed states for `SignupRefused`, `WorkspaceLimitReached`,
  `EmailNotVerified`, `EmailDomainNotAccepted`, `ClientTooOld`, `NoDeployment` in
  `site/src/lib/commonswarm.ts`. Every one renders a message. Each must name the next action and
  none may blame the user for our state.
- The dead components at `site/src/components/{Hero,Install,HowItWorks,Footer,Authority,AuthorityDemo}.astro`
  are imported by nothing. **Propose deletion in your report; do not delete them in this lane** —
  they are marked dead deliberately and removal is a Lead6 call.

### L3 — DOWNLOAD + APP. Where a stranger goes next.

**Owner:** codex seat · **Files:** `site/src/pages/download.astro`,
`site/src/components/download/**`, `site/src/pages/app.astro`, and any `site/src/components/app/**`.

`/download` was written for someone comfortable with `curl | sh`. Keep that path — it is right
for the people who want it — but the page must also work for someone who has never opened a
terminal, and must be honest that Node 24 is required *before* they paste anything.

`/app` returns 200 and **has never been audited at all.** Treat it as unknown territory: report
what it actually does for a signed-in user, a signed-out user, and a user with zero workspaces,
before changing anything.

### L4 — METADATA, OG, FAVICON, SHELL.

**Owner:** codex seat · **Files:** `site/src/layouts/Base.astro`, `site/scripts/og-card.mjs`,
`site/public/**`. Nobody else edits these.

- Per-route `og:title`, `og:description`, `og:image`, `twitter:*`. Today every route shares one
  card. A shared card is acceptable; a shared *description* is lazy.
- `ogImageAlt` in `Base.astro` is a description of `og.png`'s actual pixels. If the card
  changes, that string changes in the same commit. It has been wrong once already.
- **The og-card regeneration trap is real and documented in `og-card.mjs`'s header — read it.**
  `setDeviceMetricsOverride` changes layout, not the window; if the real window is narrower than
  1200px the capture **tiles** and produces a valid-looking PNG with a seam. Dimensions, byte
  size and file type all pass on a broken image. **Look at the image.**
- Favicon, apple-touch-icon, theme-color, and a `manifest` if it is cheap.

---

## 5. Review — and who may review whom

**Model inversion is not optional.** From `OPERATING-MODEL.md` §2: a reviewer must be a
different family from the author, and self-family review satisfies nothing. That baseline
is necessary but **not sufficient** under D-033: the operative gate is the named pair,
Grok plus AGY/Gemini.

Measured today, not assumed: `codex` (OpenAI) is the author/operator CLI; it does **not**
replace either review arm. `grok` (xAI) and `agy` (Google Gemini) are on PATH and
invocable as the two required reviewers. ~~**`gemini` is not installed.
`antigravity` is not on PATH. There is no Google voice available in this wave**~~ is **dead
as of the operator's D-033 ruling**: `/Users/yulanbot/.local/bin/agy` is installed and
enumerates Gemini models.

So: every swarm mate's lane is reviewed by **BOTH Grok and AGY/Gemini instead of Claude**.
Verdicts bind to an exact SHA; a new commit voids both verdicts and requires both to rerun.
Do not wait for or claim a Claude verdict. Neither single arm nor Codex is a substitute.
Each arm must return substantive findings or reasoning; an empty PASS is not a review.
`opencode` remains excluded: it ran 2h6m with zero output earlier in this session.

**Design critique is separate from code review** and runs on the **deployed** pages, not the
source. Each critic works independently and blind to the others. The brief is deliberately
harsh: *"you are a smart person who does not write code, you have thirty seconds, and you are
looking for a reason to close the tab."*

---

## 6. Reporting protocol

**Minimum noise, zero silent idling.** Do not send acknowledgements. Do not send "starting now".

Send exactly these:

1. **CHECKPOINT** when a lane is half done, one paragraph, what changed and what surprised you.
2. **DONE** with: branch, SHA, `git ls-remote` line, the observer's name, the verbatim red from
   the mutation, gate counts, and anything you REJECTED with its evidence.
3. **BLOCKED** the moment you are blocked, with what you tried. Blocked is an acceptable
   terminal state. Falsely-marked-complete is not.
4. **FINDING** immediately for anything that looks like a defect outside your lane. Do not fix
   it; name it.

If you have nothing to say for a long stretch, that is fine — but if you are waiting on
something, say so once. **Going quiet while stuck is the one unacceptable state.**

Gate counts are read from real output, unpiped. `skipped` is not green. A suite that passed in
zero seconds did not run. And note D-020: `test:p1-cli` has a ~1-in-8 local-edge 502 in
`local-integration.test.ts` — a single red there is not evidence of a defect until re-run.
