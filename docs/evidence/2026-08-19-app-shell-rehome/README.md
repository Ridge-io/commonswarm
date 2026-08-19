# App shell rehome — secondary controls off the rail (2026-08-19)

Operator direction: the left rail should hold only navigation + the owner-grouped roster;
the other controls move to better homes.

## Before -> After (where each control lives)

| Control | Before (rail) | After |
|---|---|---|
| Manage people (human members: list, Remove, re-auth) | rail `<details data-member-details>` | a `People` section inside the header **People & agents** dialog (retitled from "Agents"); same `data-member-details`/`data-member-list` hooks, so `renderMembers` gates owner/admin visibility unchanged |
| Pending access | rail `<details data-access-details>` | removed from the rail; the dialog already mirrored it (`data-dialog-access-*`, one `pendingAccessRows` source). The rail JS lookups are null-guarded |
| Workspace details (ID + copy) | rail `<details data-workspace-details>` | a **gear button** next to the workspace name, opening `data-workspace-details-popover`; same `data-channel-id`/`data-copy-workspace-id` hooks |
| Theme toggle, Sign out, CommonSwarm home link | rail `dashboard__rail-foot` (always visible) | a **user menu** popped from the account/email button (`data-user-menu`); theme toggle keeps `data-theme-toggle` (app.astro querySelector), sign-out keeps `data-signout` |

Rail now: workspace switcher (+ gear), STREAMS, ARTIFACTS, PEOPLE & AGENTS roster (flex:1 fill
from a283e10 stays), and a single account button at the foot.

## Wiring preserved
Every moved control kept its `data-*` hook, so the existing attribute-selector wiring resolves
unchanged: `renderMembers` ([data-member-list]/[data-member-details]), the copy-ID flow
([data-copy-workspace-id]/[data-channel-id]/[data-workspace-id-status]), theme persistence
([data-theme-toggle] in app.astro), and sign-out ([data-signout], iterated). Two new popovers use
one shared `wirePopover()` helper: show/hide + aria-expanded + Escape + outside-click, isolated
from the workspace switcher's roving-focus logic.

## Gates
Build clean. `npm test` 167/167. Moved-surface observers with tsx (theme-toggle + slack-shape +
header-roster) 21/21.

## Observers re-pointed (coverage kept, not deleted)
- workspace-entry.observer: `<summary>Manage people</summary>` -> the dialog title "People &
  agents" + `data-member-details` section.
- workspace-switcher.observer "home link reachable": the rail-foot wordmark direct-child pin ->
  the home link inside `data-user-menu`, plus the mobile rule placing the foot in the top bar.

## Verify visually (Lead — I cannot drive a browser)
1. Desktop: gear beside the workspace name opens the ID popover; the roster fills the freed rail;
   the account button at the foot opens a menu with theme + Sign out + CommonSwarm.
2. Header roster dialog now titled "People & agents" and shows a People section (members +
   Remove) for owners/admins, hidden for plain members.
3. **Mobile (<=52rem): the account menu popover positioning is the one thing I changed but could
   not verify** — I replaced the old `display:contents` foot (which hoisted the bare wordmark into
   the top bar) with the foot as its own box placed at grid-column:2/row:1 so its popover anchors.
   Confirm the account menu opens correctly at narrow widths.
