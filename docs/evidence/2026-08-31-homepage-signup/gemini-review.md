# Independent D-036 Cross-Family Inversion Review

## Goal Description
Review of commit `59c190bbd77ed352baf902cb50bf5e88eeda00f1` which performs a cross-family inversion by changing the primary calls-to-action on the homepage from "Open your workspace" to explicitly say "Sign up" and "Log in". The change removes homepage confusion about whether GitHub is required to open a workspace, by offering a clear email-based onramp.

## Proposed Changes Review

### 1. "Sign up" and "Log in" buttons
**Analysis**: The change successfully replaces the confusing "Open your workspace" buttons and GitHub repository links in `SiteFooter.astro`, `SiteHeader.astro`, `ConsumerHero.astro`, and `ConsumerStory.astro` with distinct "Sign up" and "Log in" buttons. 
- In `ConsumerHero.astro`, both buttons are now placed side-by-side using robust flexbox rules that correctly wrap and stack vertically on screens narrower than `30rem` (480px).
- In `LiveDashboard.astro`, the title and copy were correctly updated to reflect the new "Sign up or log in" messaging, removing "See what your agents are doing".

### 2. Unified Email Auth Claim
**Analysis**: Verified against `site/src/lib/commonswarm.ts`. The `signInWithEmail` function calls `auth.signInWithOtp`. As noted in the source comments, this single Supabase endpoint acts as a unified mechanism: it creates a new user if the email is new, and issues a login link if the user already exists. The claim that `/app` auth handles both transparently without separate flows is accurate and implemented correctly.

### 3. Regressions Check
- **Mobile and no-JavaScript layout**:
  - The new "Log in" button in `SiteHeader.astro` is deliberately hidden via `display: none` on screens below `52rem` to conserve horizontal space. Users on narrow screens can still log in via the hero section, the footer, or the mobile burger menu (`<dialog class="mnav">`), ensuring no loss of capability.
  - The no-JS collapse ladder (which prevents navigation links from spilling over the CTA) had its breakpoint moved from `30rem` (480px) up to `40rem` (640px). This fully resolves the reported overlap at 481-520px. 
- **Prior sidebar fixes**: The previous GitHub link in the mobile menu (`.mnav__link`) was cleanly swapped for the "Log in" link. This preserves the structural integrity of the sidebar and any prior formatting applied to `.mnav__link` elements.
- **Existing signed-in routing**: `SiteHeader.astro` retains the conditional `signedIn ? "Open workspace" : "Sign up"` logic, preserving the dynamic header for authenticated sessions. The marketing pages (`index.astro`, `ConsumerHero.astro`) direct clicks to `/app`, which correctly leans on the client-side JavaScript in `LiveDashboard.astro` to detect an existing session and route the user to their workspace automatically.

## Verdict and Blockers
**Exact SHA**: `59c190bbd77ed352baf902cb50bf5e88eeda00f1`

**Verdict**: Approved.

**Blockers**: None. The changes execute on the stated goals, cleanly isolate GitHub from the onboarding flow, and correctly maintain responsive layout bounds for both JS and non-JS clients. All observer tests (`consumer-copy.observer.mjs` and `primary-cta.observer.test.ts`) were appropriately updated alongside the UI changes to prevent CI failures.
