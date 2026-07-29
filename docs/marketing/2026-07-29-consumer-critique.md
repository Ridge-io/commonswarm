# Consumer critique — codex (OpenAI), 2026-07-29

Cross-family critique of the **deployed** pages, briefed as *"a smart person who does not write
code, thirty seconds of patience, looking for a reason to close the tab."*

Verified against production by the advisor before being made binding. **One finding is a false
positive and one prescription rests on a premise we created — both are marked. Do not apply
either blindly.**

---

## The headline result

> **FIRST GUESS: "This is a command-line tool for software developers whose coding agents need to
> avoid editing the same files."**

That is the thesis failing. The product's whole claim is that people who do not write code should
be able to use agent-to-agent coordination. A reader given thirty seconds concluded it is a
developer tool. Everything below is detail; this is the finding.

---

## Confirmed against production, and binding

### 1. The home page says signup is off. It is on. ★ HIGHEST PRIORITY

Live copy: *"Free — three workspaces, no card. **Signup is not switched on for everyone yet, so
the flow is a preview.**"*

`SWARM_SELF_SERVE=1` has been set on the production project since 2026-07-28. Self-serve
workspace creation works; it was used to create the workspace this fleet coordinates in. **The
front page is telling every visitor they cannot have the thing they can have.**

This is D-002 exactly — *"the CLI told every operator renewal was unavailable while it worked"* —
recurring on the marketing surface. Availability copy asserts deployment state and lives in git,
so nothing fails when the deployment moves.

**Owner: L2 (Juniper).** Delete the claim. Replace with what is true: signup is open, free, three
projects, no card.

### 2. Internal engineering vocabulary on the consumer signup page

Measured occurrences on live `/start`: `SWARM_CLOUD_URL` ×2, `PUBLIC_SUPABASE_ANON_KEY` ×1,
"meta tags" ×1, "Workspace id" ×1.

A person who came to sign up is reading environment-variable names and HTML concepts. **Owner: L2.**

### 3. `/start` contains a self-declared dead end

Live copy: *"This step isn't on the page yet"* … *"the workspace above exists and is yours, and
this is the step that is missing."*

Honest, and a dead end. It walks someone into a flow it then admits it cannot finish. **Owner: L2.**

### 4. `/app` shows "Loading dashboard…" with no resolution path

Confirmed present on the live page. Whether it is a pre-hydration state or a stuck state, a person
who sees it has no explanation and no next action. **Owner: L3 (Lumen)** — and note Lumen has
already independently audited `/app`'s three states, which is the deeper version of this.

### 5. The home page demo is a terminal exercise inside a Git repo

`--about src/payments/webhook.ts`, `cswarm working-on`, "any agent that can run a shell command".
The one part of the page meant to *invite* someone is the part that proves the product is for
engineers. **Owner: L2**, and this is the substantive one — see the ruling below.

---

## ✗ FALSE POSITIVE — do not act on this one

The critique reported *"'We sent it to .' and 'Signed in as your GitHub account .'"* as blank
rendered states, and used them as a trust argument.

**They are not blank at runtime.** Both are JS-filled spans — `data-email-sent-address` is
populated by `start.astro` from the submitted address, deliberately, so a typo is catchable. The
critic read **static HTML** and saw empty elements.

This is worth keeping as a lesson about the instrument rather than the product: a critique run on
fetched HTML cannot see anything a client fills in. It is the same shape as D-022 from the other
direction — there, a source-level grep missed a defect that was live; here, a static read invented
a defect that is not.

**Both remaining lanes: do not "fix" these. Do check that they degrade sensibly with JS disabled.**

---

## ⚠ PRESCRIPTION REJECTED — and the reason matters

The critique repeatedly prescribes retreating to invitation-only language: *"CommonSwarm is
currently invitation-only"*, *"Self-serve signup is unavailable"*, *"Request early access"* as the
only primary action.

**Rejected. It is the wrong direction, and the critic was misled by our own stale copy** — finding
1 above. Told by the page that signup is not switched on, it reasonably concluded the product
cannot be signed up for, and optimised for that world.

Signup **works**. The correct fix is the opposite of the prescription: say so plainly and make it
the primary action. A confident, true "create your workspace, free, no card" beats a
waiting-list.

This is why a reviewer's prescription is binding *unless disproven with evidence* rather than
binding absolutely. The evidence here is `SWARM_SELF_SERVE=1` and a workspace that exists.

---

## The one thing, and my ruling on it

The critique's single highest-leverage change:

> Replace the homepage's coding-agent terminal demo with one ordinary workplace collision — two
> people or AI assistants starting the same customer email.

**Accepted in substance, rejected in scope.** Its own illustration is the argument:

> *"What are you working on? 'Preparing the customer launch email.' CommonSwarm shows that Maya is
> already drafting it, so you take the launch checklist instead."*

That is the product, in one sentence, with no vocabulary to learn. The current demo says the same
thing in `src/payments/webhook.ts`.

**But do not delete the technical demo.** The engineers who will actually adopt this first need to
see the real command, and "every command shown must be copy-pasteable and real" is a standing rule
of this site. **L2's job is to lead with the human example and let the terminal version follow**
for the reader who wants it — not to choose one audience over the other.

---

## What not to break

The critique named these as already clear, and they were hard-won: *"no card"*, the concrete
collision example, *"a signal announces; it never locks"*, the sample-data disclosure, and *"no
tracking on this page"*.

`"a signal announces. It never locks."` in particular is a load-bearing sentence documented in
four places, and it survived a harsh critic. Keep it — but it currently arrives **before** the
reader knows what a signal is, which is a placement problem, not a copy problem.
