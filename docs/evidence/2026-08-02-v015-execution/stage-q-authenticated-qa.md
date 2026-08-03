# Stage Q — authenticated production QA (in progress)

Target: https://commonswarm.com (production, currently v0.1.4).
Browser: controlled Chrome window, authorized by operator decision 7.
Session state at start: an existing signed-in session as **Ridgeio**.

## Public controls (re-measured at QA start)

`/`, `/start`, `/app`, `/invite` → 200. `/nope-qa-control` → 404 (negative control).
`/start` backend meta present (1), service-role credential marker **0**.

## What works

- `/app` dashboard loads and renders. Three workspaces listed (CommonSwarm Build, Dogfood Workspace,
  uxtest-r1-92cb361a).
- Feed renders six updates with correct per-signal attribution, including
  `Model not specified · owned by Ridgeio` — the owner-relation display path is working.
- Roster expands correctly: **Ridgeio · owner**, **Tom Langridge · member**.
- Workspace details expands with a workspace ID and a "Copy workspace ID" control.
- Mobile 390×844: **no horizontal scroll** (`scrollWidth` 390 == `clientWidth` 390). Workspaces
  become a horizontally scrollable strip; the feed reflows and reads well; Sign out reachable.

## QA-008 (new) — "Remove" control renders one letter per line

**Severity: MINOR, user-visible, on the live dashboard.**

In the members roster, the Remove button for a member renders as a vertical stack of single
characters — `R e m o v e` — instead of a horizontal label.

Measured, not eyeballed:

```
button.dashboard__text-button   width 21px   height 171px
parent li.dashboard__agent      display grid, width 247px
                                grid-template-columns: 189.594px 21.4062px
button computed overflow-wrap: break-word
```

The name span consumes 190px of a 247px grid, leaving ~21px for the action column; `overflow-wrap:
break-word` then breaks the word at every character.

**Not an artifact of instrumentation.** First observed after forcing `<details>` open via JS, so it
was re-checked from a fresh page load with an ordinary click on the summary element. It reproduces.

**Narrowest correction:** `white-space: nowrap` on `.dashboard__text-button`, so the label cannot
break and the `auto` column takes its intrinsic width. Alternatively size the grid explicitly
(`minmax(0, 1fr) auto`).

**Mobile note:** at 390×844 the same button measures 0×0 because the roster is not rendered in that
layout. Whether member management should be reachable on mobile is a product question, recorded here
rather than assumed to be a defect.

## Cold-browser signed-out state — PASS, and a security-positive result

Driven in a **fresh browser context** (separate cookie jar) so the operator's live session was never
disturbed — deliberately, rather than signing them out.

`/start` redirects to `/app`, and `/app` renders the signed-out state correctly:

```
document.cookie                 -> empty
mentions "Ridgeio"              -> false
mentions "Langridge"            -> false
"Sign out" present              -> false
```

**An unauthenticated browser sees no other user's data.** That is the isolation property that
matters most on this page, and it holds.

Both sign-in methods are offered: magic link ("No password. The link returns you to this page.") and
"Sign in with GitHub". The legal footer is honest about the deferred-legal decision — Terms and
Privacy are labelled *"drafts published for review (not yet in force)"* rather than presented as
binding.

## Accessibility and validation — PASS

| Check | Result |
|---|---|
| Email input | `type=email`, `required`, label "Email address", `autocomplete="email"` |
| Skip link | present (`Skip to content`) |
| Tab order | logical: skip link → brand → email → send-link → GitHub → Terms → Privacy |
| Images missing `alt` | 0 |
| Visible `<h1>` count | 1 |
| Empty submit | blocked: "Please fill out this field." |
| Invalid email | blocked: "Please include an '@' in the email address." |

Four `<h1>` elements exist in the DOM, but three belong to other SPA states and are hidden by
`display:none` on an ancestor section, which removes them from the accessibility tree. Checked
rather than assumed, because "multiple H1s" is a real smell when the hiding is only visual.

## COLD-BROWSER WEB SIGN-IN — **PASS**. The previously-unproven leg is now proven.

The production feed carried this, five days old, in the operators' own words:

> "Next unproven leg is the WEB sign-in at /start — cswarm login only exercised the loopback redirect
> arm, not the commonswarm.com one."

**That leg now works end to end.** Measured, in a browser context that started with no session:

| Stage | Evidence |
|---|---|
| Before sign-in | `document.cookie` empty; no "Ridgeio"/"Langridge" text; no Sign out control |
| Operator completed GitHub OAuth (`tom@ridge.io`) | — |
| After | signed in as **Ridgeio**; all 3 workspaces load; feed renders |

**Session isolation confirmed**: the signed-in context holds `document.cookie` empty and its auth in
`localStorage` under `sb-<ref>-auth-token` — a separate browser context from the operator's original
tab, so this was a genuine cold sign-in and not a shared session. The operator's original session was
never disturbed; a fresh context was used specifically to avoid signing them out.

This is the single highest-risk item in the release closing: signup is open to strangers
(`SWARM_SELF_SERVE=1`) and sign-in has no fallback path if it breaks.

## Navigation and affordances — reachable

The agent roster opens from the header control (`aria-label="2 agents — view and manage agents"`) and
exposes **Add an agent**. The create-workspace, invite-link, copy-invite-link, and add-agent controls
all exist in the DOM behind SPA panels (`dashboard__gateway`, `dashboard__connect-view`,
`dashboard__invite-result`, `dashboard__roster-dialog`) rather than being absent — checked, because
"the button isn't there" and "the button is behind a panel" are different bugs.

Note for the create-workspace path: this account already holds **three** workspaces and the signup
copy advertises "up to three workspaces, no card". Whether creation is correctly gated at the limit,
or simply unreachable, is **not yet established** — it needs an account below the limit to
discriminate, so it is not concluded here either way.

Also still to run: workspace creation, add-own-agent with automatic prompt completion, live feed
update within five seconds, second-human invite consumption with pending-access clearing,
remove/revoke with history remaining attributable, and focused keyboard/accessibility controls.

## QA-009 — one root cause behind the visible layout breakage

The operator observed "a lot of little spacing issues and UI stuff". Measuring rather than
cataloguing impressions, the visible breakage traces to **one** structural cause, not many:

**`li.dashboard__agent` holds three children in a two-column grid.**

Measured in the roster dialog:

```
grid-template-columns: 76.7031px 277.297px     (2 columns)
grid-template-rows:    42.1094px 44px          (2 rows -- auto-created, not authored)
children: 3            avatar(32px) | copy(277px) | Remove button(77px)

avatar   x=502  y=391
copy     x=591  y=386
button   x=502  y=441   <- auto-placed onto row 2, column 1
row height 114px        <- against ~44px of actual content
```

The third child has no column, so the grid creates an implicit second row and the action lands
**underneath the avatar**, left of the name it belongs to. Every agent row costs ~70px of dead
vertical space and reads as broken alignment.

This is the same defect as QA-008 seen from the other side. In the sidebar the row is narrow, so the
starved action column made the label wrap character-by-character; in the dialog the row is wide, so
the action wraps to a second grid row instead. **One cause, two symptoms**, which is why fixing only
the sidebar symptom (`white-space: nowrap`) did not fix either fully.

**Correction:** give the row a third track — `grid-template-columns: auto minmax(0, 1fr) auto` — so
avatar, copy, and action occupy one row. Expected: row height 114px → ~44px, the action aligns
right, and the avatar column collapses from 76.7px (currently dictated by the button's width) to the
avatar's own 32px, which also pulls the name leftwards into alignment.

### Honest note on method

A broad automated sweep for "grid whose children exceed its column count" returned 12 hits. **Ten
were false positives** — single-column lists where multiple rows is simply correct vertical stacking
(`dashboard__workspace-list`, `dashboard__message-body`, and similar). Only `dashboard__agent`
(2 columns, 3 children) and the QA-008 tap target are real. Recorded because an inflated finding
count is its own kind of wrong, and a reader should know the detector was noisy rather than trusting
"12 layout issues found".

**Not established:** whether other spacing inconsistencies exist that this structural check cannot
see — kerning, rhythm, inconsistent scale steps, and hierarchy are judgement calls that a geometry
probe does not measure. A dedicated design pass would be a separate piece of work from this
correctness QA.

## QA-010 — **the teammate invite flow is broken in production today.** Severity: MAJOR

Attempting to create a teammate invite from a fully signed-in owner session fails with a user-facing
error:

> "CommonSwarm did not create the invitation (unauthenticated)."

This is the flow the product page advertises as *"Send one link. They connect their agent."*

### Measured, not inferred

| Probe | Result |
|---|---|
| Session identity | signed in as **Ridgeio** (owner), workspaces and feed load |
| Token claims (secret never printed) | `role: authenticated`, `aud: authenticated`, `sub` present, **not expired — 2,786 s remaining** |
| Reads via PostgREST (`/rest/v1/...`) | **200** — members, agents, signals, pending_invitations all succeed |
| Invite write → `/functions/v1/command` | **401 `{"error":"unauthenticated"}`** |
| Authorization header sent? | **yes** |

So: the same session that successfully reads every workspace resource is rejected by the `command`
edge function. Reads go to PostgREST and work; the write goes to the edge function and 401s.

The client is not at fault — `site/src/lib/commonswarm.ts:349-355` sends
`authorization: Bearer <session.access_token>` plus `apikey: <anon>`, which is correct.

### Where it fails, in the source we have

`supabase/functions/command/index.ts:6478-6494` takes the human path for any bearer not prefixed
`swm_agt_`, and requires **both** calls to succeed:

```ts
authClient.auth.getUser(credential)
authClient.auth.getClaims(credential)
...
if (error || claimsError || !data.user || !claimsData?.claims) -> 401 "unauthenticated"
```

A failure in **either** yields the same undifferentiated 401. `getClaims` is the newer API relied on
for D-035's fresh-auth AMR checks, and it depends on JWT signing-key configuration.

**Stated as uncertainty, not conclusion:** production runs command **v15** (the v0.1.4 deploy); the
lines above are from the undeployed tree. I have not read the deployed source, so I cannot say which
of the two calls fails, or whether the deployed code is identical. What is established is the
behaviour: a valid unexpired authenticated JWT is rejected.

### Why this matters for the release

1. **It is pre-existing, not caused by this release.** Our v0.1.5 changes are not deployed —
   production is v0.1.4. We did not break this.
2. **But the same code path ships in v0.1.5**, so unless something in the delta changes it, the
   release will ship the same defect.
3. Every *human-initiated* command shares this path — invite, remove member, revoke agent — so the
   blast radius is likely wider than invites alone. Not yet measured.
4. The error is also **misleading**: an empty-email submission returned the identical
   "unauthenticated" message, so the UI cannot distinguish a validation failure from an auth failure.

### Consequence for Stage Q

The second-human invite, pending-access clearing, and remove/revoke checks **cannot be exercised**
until this is resolved — the flow they depend on does not complete. They are blocked, not passed and
not skipped.
