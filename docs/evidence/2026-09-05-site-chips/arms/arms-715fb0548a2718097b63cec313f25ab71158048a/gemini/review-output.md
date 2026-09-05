diff --git a/TODO.md b/TODO.md

1. `site/src/components/auth/provider-buttons.observer.test.ts`:321 - MAJOR: The bounds for OAuth call sites in `SWEEP_CATCHES` are typed in substance despite appearing derived. While `NAMED_PROVIDER_WRAPPER` and `GENERAL_PROVIDER_CALL` are injected, the actual rules `"outside lib/commonswarm.ts"` and `"more than one call to"` are hardcoded strings. If the allowed call sites or counts in the test assertions change (e.g., permitting a second `signInWithGitHub` caller in `UNGENERATED_SIGNIN_SURFACES`), the `SWEEP_CATCHES` control will not notice, and the list will silently drift from the code's enforcement.

I tried to refute the following claims and could not:
- The design doc and test carry the exact same `SWEEP_DOES_NOT_CATCH` bound word for word.
- The `LiveDashboard.astro` reauth swap properly removes typed provider details and handles zero-provider states correctly via `ProviderButtons`.
- `Hero.astro` and `Invite.astro` are fully deleted with no lingering active imports or false comments.
- The `brain-links` control accurately discriminates the specific defect shape while honestly documenting its gaps.

VERDICT: FAIL
