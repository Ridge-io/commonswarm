# Vercel toolbar off in production

**Status:** SPECIFICATION, draft 2 (final-round Grok finding on `93792ef` folded), branch `spec/app-backlog`. Backlog item 1 of the operator's eight (brain topic `app-backlog`). Authored by CSwarmStrategist (`2121f81d`), 2026-09-06.
**Authority:** none until adopted; on handoff CSwarmDevLead PMs it.
**Size:** a project setting and one verification. No code.

## 1. The problem, measured

The operator reported (2026-09-04, with screenshots) that the Vercel Toolbar covers the reading area of the app on a phone. The ledger recorded it beside the mobile fix: "turn the Vercel Toolbar off for production. It is a Vercel overlay, visible only to signed-in team members, but it covers the reading area" (brain topic `app-backlog` v6, item 1).

What the repo contains: **nothing that injects or configures the toolbar.** `grep -rni toolbar site/` matches only the app's own feed toolbar (`site/src/components/app/mobile-feed-layout.observer.test.ts:69`, `.dashboard__feed-toolbar`) and design prose; there is no `@vercel/toolbar` dependency in `site/package.json`, no `site/vercel.json`, and no `VERCEL_PREVIEW_FEEDBACK_ENABLED` variable. The overlay is therefore injected by Vercel itself for signed-in team members of the `ridgedotio` team on production deployments of project `coswarm-site`, which is the documented behaviour when the toolbar is enabled for the Production environment.

Anonymous control (measured 2026-09-06 with `curl`): `https://commonswarm.com/`, `/app`, and `/start` contain zero references to `vercel.live` in the served HTML. That is consistent with injection happening only for signed-in team sessions, and it means an anonymous fetch cannot verify the fix; a signed-in browser must.

## 2. The change

Vercel dashboard → team `ridgedotio` → project `coswarm-site` → **Settings → General → Vercel Toolbar** → under **Production**, choose **Off**. Leave **Preview** as it is (the toolbar is useful there for comments). Source: Vercel docs, "Managing the visibility of the Vercel Toolbar", last updated 2026-08-11: the project-level options are Default / On / Off per environment, and Off "disable[s] the toolbar for the environment".

If the team-level setting does not allow project override, set it at **team Settings → General → Vercel Toolbar → Production → Off**, which applies to every project in the team; that is acceptable because no Ridge.io production site needs the toolbar.

The docs' disable steps do not ask for a deploy; whether the change shows on the next page load or only on a new session is what §3's before/after establishes, not something this document asserts.

## 3. Verification (the positive control)

The whole check must run in a browser that is **signed in to the `ridgedotio` Vercel team**, because §1 shows an anonymous visit never carries the toolbar: an unauthenticated "after" is a false pass. Step 4 is what proves the session was authenticated.

1. **Before:** a signed-in team member opens `https://commonswarm.com/app` on the phone that showed the overlay and confirms the toolbar circle is present. Screenshot into `docs/evidence/2026-09-06-vercel-toolbar/before.png`.
2. Flip the setting.
3. **After:** same phone, same signed-in account, same page, new browser session (the docs note a hidden toolbar can persist for a session): no toolbar. Screenshot into `…/after.png`.
4. **Control that the setting is the cause and the session is authenticated:** in the same session open a **preview** deployment URL and confirm the toolbar appears there. If it does not, either the flip was made at the wrong level, the session was disabled, or the browser is not signed in — and the after screenshot proves nothing. Screenshot into `…/control-preview.png`.

## 4. Who does it, and the two ways to do it

The setting has no repo file, CLI flag, or environment variable that turns it off for production (`VERCEL_PREVIEW_FEEDBACK_ENABLED` is preview-only and `x-vercel-skip-toolbar` is a per-request preview header). It **does** have a REST field: `PATCH /v9/projects/{idOrName}` with body `{"enableProductionFeedback": false}` ("Opt-in to production toolbar on the project level", Vercel REST docs, "Update an existing project"), and `PATCH /v2/teams/{teamId}` with `enableProductionFeedback: "off"` (team owner only). Both need a team token, which is the same class of secret as the Google client secret and branch protection: **an operator-side action**, or CSwarmDevLead with dashboard access. So the flip is either the dashboard click in §2, or, from a machine whose Vercel CLI is already signed in to `ridgedotio` (the deploy machine is), the project PATCH sent with that CLI's token, followed by a `GET /v9/projects/coswarm-site` showing `enableProductionFeedback: false`. A lane author must not be asked for, and must not look for, the token; whoever holds the session runs one of the two.

## 5. Lanes

- **Human step (not a lane):** the flip in §2 or the PATCH in §4, by the operator or the lead.
- **`lane/toolbar-evidence`** (docs only, authored by whoever flipped it): the three screenshots from §3 under `docs/evidence/2026-09-06-vercel-toolbar/` and one line in the ledger (brain topic `app-backlog`) with the date, the level (project or team), the method (dashboard or PATCH), and the account that verified. No code, no test gate, no D-036 arms beyond this spec's.

## 6. What was NOT established

- Whether the team-level setting allows project override on `ridgedotio` (visible only in the dashboard).
- Whether the overlay the operator saw was the Vercel Toolbar or Vercel's comments widget; the fix is the same setting either way (comments ride the toolbar).
- Anything about the INP issue the ledger recorded beside it (`textarea` event handlers blocking for 314 ms): that is the mobile fix's follow-up, not this item.
