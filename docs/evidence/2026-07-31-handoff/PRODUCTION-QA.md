# CommonSwarm production QA report

> **Current-state note, 2026-08-04 (D-044):** the local cross-owner isolation proof referenced
> below is historical. Cross-owner asks now reach the operator's existing worker and project context
> with sender/operator provenance; server-side workspace and signal isolation remains unchanged.

Target: <https://commonswarm.com>  
Snapshot: **2026-07-31, approximately 08:00–09:00 CDT**  
Deployment: `dpl_FLsNC8Cu549rfCh8fSShPo3zX3AM`, Vercel production, Ready  
Scope: public/signed-out pages, deployed source/assets, release/backend probes, prior durable
signed-in evidence. No production code or customer data was changed.

## 1. Executive result

The public product is reachable, responsive, visually coherent, and wired to the current backend
and v0.1.4 installer. The workspace-first story, email-first sign-in, teammate invite explanation,
current header roster, auto-completing agent prompt, and listener instructions are present in the
deployed artifact.

The release has one stop-the-line customer trust issue: the live Terms, Privacy Policy, and AUP say
they are drafts “not yet in force,” while open signup is active. The legal/privacy facts are also
behind the product: GitHub-only sign-in, all-static/no-third-party language, missing Resend, and the
wrong local CLI directory. These should be corrected and reviewed before broader promotion.

The current authenticated dashboard was not independently re-walked in this pass. Attaching the
browser-control plugin to the user's already-running Chrome failed at the transport layer. A new
Chrome window was not opened without permission. This is a QA evidence gap, not an observed product
failure.

## 2. Test environment

- Public browser QA: headless Chromium through the project QA browser.
- Viewports:
  - desktop: 1365×768;
  - mobile: 390×844.
- Existing Chrome inspection attempt:
  - Chrome 150 process was running;
  - the control extension was installed/enabled in selected Profile 1;
  - native host configuration appeared present;
  - the plugin twice returned “browser not available.”
- Source/deployment checks: `curl`, Vercel CLI, Supabase CLI, GitHub CLI, deployed JavaScript/HTML
  inspection.
- No credential, anon key, invite link, email address, or customer content is preserved here.

## 3. Route and control results

| Route | HTTP | Result |
|---|---:|---|
| `/` | 200 | Consumer landing page renders on desktop/mobile |
| `/start` | 200 | Browser onramp routes into `/app`; backend metadata is nonempty |
| `/app` | 200 | Signed-out email-first/GitHub auth surface; deployed workspace UI/assets present |
| `/invite` | 200 | Empty-link state is honest and explains CommonSwarm |
| `/download` | 200 | Current install page; contains `cswarm 0.1.4` |
| `/terms` | 200 | Renders, but explicitly draft/not in force |
| `/privacy` | 200 | Renders, but explicitly draft and factually stale |
| `/acceptable-use` | 200 | Renders, but explicitly draft/not in force |
| `/install.sh` | 200 | Installer reachable |
| `/nope.sh` | 404 | Negative control proves route probe discriminates |

Additional checks:

- `/start` meta contains `https://ukezjcnxjvkpkeezxaew.supabase.co`.
- `/start` contains zero service-role JWT markers.
- `/download` contains `cswarm 0.1.4` twice.
- Deployed `/app` assets contain `cswarm listen start` and `0.1.4 or newer`.
- Deployed `/app` includes:
  - teammate invite copy and seven-day one-use link;
  - **Done** and **Back to the channel**;
  - auto-close copy after the agent first connects;
  - model field and owner-aware agent UI;
  - header roster dialog with Add-first and filter;
  - pending-access section.
- “Clear this prompt” is absent.

Backend negative/positive controls through the public anon-key boundary:

| Endpoint | Probe | Result |
|---|---|---|
| `command` | empty JSON, no user auth | 400 `invalid_request` |
| `read` | empty JSON, no agent/user auth | 401 `unauthenticated` |
| `capability` | no capability token | 404 `not_found` |
| nonexistent function | same gateway | gateway-style 404 control |

## 4. Positive UX observations

### Homepage

- Leads with the shared-agent-feed outcome rather than authority/protocol jargon.
- Primary action is to open/create a workspace; install remains available without dominating the
  first-time consumer story.
- The visual system is consistent across desktop/mobile and resembles a consumer collaboration
  product rather than an internal admin console.

### Signed-out app

- Email magic link is the primary sign-in path; GitHub is a secondary button.
- The copy states free/no card and explains the next outcome.
- No console error was observed in public signed-out QA.

### Empty invite link

- Does not pretend an invite is valid.
- Explains that a private invite link is required and includes “What is CommonSwarm?” context for a
  recipient who has never used the product.

### Deployed workspace shell/source

- Agent list is out of the left rail and represented by a header stack/dialog.
- Agent avatars are uniform circles with initials/colors, avoiding mixed random shapes.
- **Add an agent** is first in the dialog and available in the empty channel.
- Model and owner metadata are part of the rendering contract.
- Feed loading/empty/error/load-older states are explicit.

## 5. Confirmed issues

### QA-001 — Legal documents say they are not in force while signup is open

Severity: **P0 trust/legal operations**  
Area: `/terms`, `/privacy`, `/acceptable-use`, `/app`

Steps:

1. Open <https://commonswarm.com/terms>.
2. Observe “Proposed effective 27 July 2026.”
3. Observe “Draft — not yet in force.”
4. Open `/app`.
5. Observe active email/GitHub signup and acknowledgement of drafts “not yet in force.”

Actual: customers can create/use accounts while the product explicitly says its legal documents
do not take effect.  
Expected: either reviewed/effective documents match the signup acknowledgement, or signup/legal
state is otherwise handled by an operator-approved policy.  
Owner/blocker: operator/counsel; not autonomous engineering.  
Evidence: `production-terms-draft.png`, live `/app` HTML.

★ **ESCALATED 2026-07-31 (F-2) — add step 2a: the proposed date is in the past.**

Re-measured on the live raw HTML of all three legal pages:

```html
<span>Proposed effective <span class="mono lgl__date-val">27 July 2026</span></span>
<span>Last updated      <span class="mono lgl__date-val">29 July 2026</span></span>
```

**Today is 31 July 2026.** The page proposes an effective date four days in the past while
declaring itself not in force.

This changes the finding's character, not just its urgency. As originally written, QA-001
describes a document awaiting activation — awkward but internally coherent. What is actually
deployed is a document that says it *should already be effective* and *is not* — **internally
contradictory, and worsening by one day per day.** There is no steady state to park in while
counsel is arranged.

Additional expected behavior: the existing draft-date guard
(`docs/evidence/2026-07-30-legal-draft-date-guard.md`) checks for an unresolved *placeholder*.
It does not check for a *stale* date and did not fire here. **A guard that fails the build when
a proposed effective date is in the past** belongs in the Phase 1 observer set — otherwise this
finding silently recurs the next time review slips.

Re-measurement note: a first grep appeared to show the date rendering empty. That was an
artifact of the nested `<span>` truncating the match, not a defect — the date renders correctly.
Recorded because the raw-HTML re-check is the step that distinguished the two.

### QA-002 — Terms and Privacy describe GitHub-only auth

Severity: **P0 factual/legal**  
Area: `/terms`, `/privacy`

Steps:

1. Open `/app`; observe “Email me a sign-in link” and “Sign in with GitHub.”
2. Open `/terms`; observe “You sign in with GitHub.”
3. Open `/privacy`; observe “Sign-in is GitHub OAuth” and GitHub-derived identity claims.

Actual: legal pages omit the primary email magic-link path.  
Expected: both current auth methods and their actual data fields/risks are described.  
Source anchors: `site/src/pages/terms.astro:111`, `site/src/pages/privacy.astro:74,99`.

### QA-003 — Privacy's static/no-third-party claim does not describe `/app`

Severity: **P0 factual/privacy**  
Area: `/privacy`

Steps:

1. Open `/privacy`.
2. Observe “This website sets no cookies, runs no analytics, and loads nothing from a third party”
   and “Every page is static.”
3. Inspect current app source/network contract: `/app` creates a Supabase browser client and uses
   Supabase Auth/PostgREST/edge functions.

Actual: wording is blanket/static while the interactive app communicates with the backend/auth
provider. This report does not claim the first-party site definitely sets a cookie; the exact
browser storage behavior still needs measurement.  
Expected: precise distinction between static hosting, interactive backend requests, browser
storage, and the genuine absence of advertising/product analytics.  
Source anchors: `site/src/pages/privacy.astro:149-150`, `site/src/lib/commonswarm.ts`.

### QA-004 — Privacy provider list omits active email delivery and local path is wrong

Severity: **P0 factual/privacy**  
Area: `/privacy`

Steps:

1. Read “Service providers”: GitHub, Supabase, Vercel.
2. Compare with current operator evidence: Resend custom SMTP is active for magic-link emails.
3. Read local-state removal instruction: `~/.CommonSwarm`.
4. Compare with CLI rename/current config directory: `~/.cswarm`.

Actual: provider/data-flow list and user deletion instruction are stale.  
Expected: complete verified provider inventory and correct local/keychain removal instructions.  
Source anchors: `site/src/pages/privacy.astro:180-182,219`, `TODO.md` custom SMTP section.

### QA-005 — Agent key lifetime copy is imprecise

Severity: **P2 copy/expectation**  
Area: `/app` → Add an agent

Steps:

1. Open the deployed AgentConnect form.
2. Read: “Each key lasts a few hours.”
3. Compare with v0.1.4: one-hour root bearer, secure rotation in a running listener, 30-day
   human-authorized horizon, immediate revocation.

Actual: copy undersells the long-lived user experience and is not numerically precise.  
Expected: explain that one-time setup can remain connected up to the configured horizon while
short credentials rotate automatically and access remains revocable.

### QA-006 — Pending access can remain stale after consumption

Severity: **P2 UX/state freshness**  
Area: signed-in workspace

Status: known from exact header-roster evidence; not freshly reproduced in this pass.

Actual contract: unknown-agent refresh updates roster/member identity but does not refetch pending
access; a consumed token can remain listed until a full workspace open.  
Expected: bounded single-flight refresh clears consumed/revoked pending access without adding a
second polling storm.  
Evidence: `docs/evidence/2026-07-30-header-agent-roster/README.md`, “Not established here.”

### QA-007 — Font preload warnings on route transitions

Severity: **P3 performance/polish**  
Area: public pages

Actual: browser reported Inter and JetBrains Mono were preloaded but not used promptly on some
transitions. No console errors were observed.  
Expected: preload only assets needed early on each route, or intentionally accept/document the
tradeoff.

## 6. Verification gaps, not confirmed bugs

### Authenticated dashboard current release

The exact current signed-in workspace was not controlled during this pass. The following remain to
be replayed together:

- workspace create;
- Add own agent vs teammate;
- auto-close/Done/Back after prompt consumption;
- header roster dialog and Add visibility;
- model/owner rendering;
- feed update without manual refresh;
- pending invite consumption/cancel;
- UI confirmation for agent removal;
- mobile signed-in layout.

Prior evidence supports each component separately, but fresh integrated proof is required.

### Cross-owner live turn

Server/process tests prove isolation. Production evidence only contains a same-owner Grok ask.
This is a security evidence gap, not an observed isolation failure.

### Email cold-browser return

Resend delivery was previously observed, but inbox receipt plus following the link in a cold
browser into signed-in `/app` remains unproven in current durable status.

### `/download` whitespace

The full-page screenshot appears to contain a large blank region. Full-page screenshot stitching
can exaggerate lazy/responsive sections. Recheck interactively before filing or changing layout.

## 7. Screenshot index

The QA browser stored these ignored local screenshots in the current-source clone:

- [Homepage, desktop](</Users/yulanbot/Developer/Ridge.io/cloud-swarm-source/.gstack/qa-reports/screenshots/production-home-desktop.png>)
- [Homepage, mobile](</Users/yulanbot/Developer/Ridge.io/cloud-swarm-source/.gstack/qa-reports/screenshots/production-home-mobile.png>)
- [App signed out, desktop](</Users/yulanbot/Developer/Ridge.io/cloud-swarm-source/.gstack/qa-reports/screenshots/production-app-desktop.png>)
- [App signed out, mobile](</Users/yulanbot/Developer/Ridge.io/cloud-swarm-source/.gstack/qa-reports/screenshots/production-app-mobile.png>)
- [Start/onramp](</Users/yulanbot/Developer/Ridge.io/cloud-swarm-source/.gstack/qa-reports/screenshots/production-start-desktop.png>)
- [Download](</Users/yulanbot/Developer/Ridge.io/cloud-swarm-source/.gstack/qa-reports/screenshots/production-download-desktop.png>)
- [Empty invite](</Users/yulanbot/Developer/Ridge.io/cloud-swarm-source/.gstack/qa-reports/screenshots/production-invite-empty.png>)
- [Terms draft banner](</Users/yulanbot/Developer/Ridge.io/cloud-swarm-source/.gstack/qa-reports/screenshots/production-terms-draft.png>)
- [Privacy](</Users/yulanbot/Developer/Ridge.io/cloud-swarm-source/.gstack/qa-reports/screenshots/production-privacy.png>)

Committed header-roster local visual evidence is under
`docs/evidence/2026-07-30-header-agent-roster/` in the current source tree.

## 8. Recommended next QA order

1. Resolve browser attachment or get permission for a controlled fresh window/profile.
2. Run cold email magic-link sign-in.
3. Execute one disposable workspace own-agent journey.
4. Measure live feed latency and visibility/reconnect behavior.
5. Execute teammate invite with a second disposable human owner.
6. Verify pending access clears and model/owner identity appears.
7. Run same-owner and cross-owner asks through the release listener.
8. Accept UI removal confirmation and verify lineage revocation.
9. Repeat key states at 390×844 and keyboard-only.
10. Enumerate and clean disposable production data; preserve redacted evidence.

## 9. What this QA did not do

- It did not implement fixes.
- It did not deploy anything.
- It did not create/delete production identities or workspaces.
- It did not inspect customer records or traffic analytics.
- It did not open a new user Chrome window without permission.
- It did not assert legal conclusions.
