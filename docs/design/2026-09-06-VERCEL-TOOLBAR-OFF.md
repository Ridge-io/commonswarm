# Vercel toolbar off in production

**Status:** SPECIFICATION, draft 1, branch `spec/app-backlog`. Backlog item 1 of the operator's eight (brain topic `app-backlog`). Authored by CSwarmStrategist (`2121f81d`), 2026-09-06.
**Authority:** none until adopted; on handoff CSwarmDevLead PMs it.
**Size:** a project setting and one verification. No code.

## 1. The problem, measured

The operator reported (2026-09-04, with screenshots) that the Vercel Toolbar covers the reading area of the app on a phone. The ledger recorded it beside the mobile fix: "turn the Vercel Toolbar off for production. It is a Vercel overlay, visible only to signed-in team members, but it covers the reading area" (brain topic `app-backlog` v6, item 1).

What the repo contains: **nothing that injects or configures the toolbar.** `grep -rni toolbar site/` matches only the app's own feed toolbar (`site/src/components/app/mobile-feed-layout.observer.test.ts:69`, `.dashboard__feed-toolbar`) and design prose; there is no `@vercel/toolbar` dependency in `site/package.json`, no `site/vercel.json`, and no `VERCEL_PREVIEW_FEEDBACK_ENABLED` variable. The overlay is therefore injected by Vercel itself for signed-in team members of the `ridgedotio` team on production deployments of project `coswarm-site`, which is the documented behaviour when the toolbar is enabled for the Production environment.

Anonymous control (measured 2026-09-06 with `curl`): `https://commonswarm.com/`, `/app`, and `/start` contain zero references to `vercel.live` in the served HTML. That is consistent with injection happening only for signed-in team sessions, and it means an anonymous fetch cannot verify the fix; a signed-in browser must.

## 2. The change

Vercel dashboard → team `ridgedotio` → project `coswarm-site` → **Settings → General → Vercel Toolbar** → under **Production**, choose **Off**. Leave **Preview** as it is (the toolbar is useful there for comments). Source: Vercel docs, "Managing the visibility of the Vercel Toolbar", last updated 2026-08-11: the project-level options are Default / On / Off per environment, and Off "disable[s] the toolbar for the environment".

If the team-level setting does not allow project override, set it at **team Settings → General → Vercel Toolbar → Production → Off**, which applies to every project in the team; that is acceptable because no Ridge.io production site needs the toolbar.

No deploy is required; the setting takes effect on the next page load.

## 3. Verification (the positive control)

1. **Before:** a signed-in team member opens `https://commonswarm.com/app` on the phone that showed the overlay and confirms the toolbar circle is present. Screenshot into `docs/evidence/2026-09-06-vercel-toolbar/before.png`.
2. Flip the setting.
3. **After:** same phone, same page, new browser session (the docs note a hidden toolbar can persist for a session): no toolbar. Screenshot into `…/after.png`.
4. **Control that the setting is the cause:** open a **preview** deployment URL in the same session and confirm the toolbar still appears there. If it does not, the flip was made at the wrong level, or the session was disabled, and the after screenshot proves nothing.

## 4. Who does it

The Vercel dashboard needs a team member's login, so this is **operator-side or CSwarmDevLead with dashboard access**; no lane author can do it. The evidence directory is the durable artifact; the ledger entry records the date and who flipped it.

## 5. Lanes

None. One dashboard action, one evidence commit (`lane/toolbar-evidence`, docs only, no arms needed beyond the two screenshots and the control).

## 6. What was NOT established

- Whether the team-level setting allows project override on `ridgedotio` (visible only in the dashboard).
- Whether the overlay the operator saw was the Vercel Toolbar or Vercel's comments widget; the fix is the same setting either way (comments ride the toolbar).
- Anything about the INP issue the ledger recorded beside it (`textarea` event handlers blocking for 314 ms): that is the mobile fix's follow-up, not this item.
