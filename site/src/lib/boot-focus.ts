/*
 * Boot-time focus gate for the dashboard's scripted focus moves.
 *
 * Two surfaces move focus programmatically: showPanel (to a panel's heading) and
 * showAuthView (to the email field). Both exist so a user-driven transition —
 * sign in, retry, "use a different address", sign out — lands the reader in the
 * new context, where the platform's own heuristic paints :focus-visible for
 * keyboard users and not for pointer users.
 *
 * The FIRST presentation of the page's life is different: it is not a response
 * to anything the reader did. Moving focus there paints a ring around something
 * they never asked for (Chromium classifies the first programmatic focus of a
 * load as focus-visible), raises the on-screen keyboard on a phone before any
 * orientation, and pulls assistive technology past the page's own opening. So
 * the first presentation skips the move: the content is the document's natural
 * start and nothing has been lost.
 *
 * One gate per surface, each independent: the first call says skip, every later
 * call says move. Pure and I/O-free so the dashboard and its test drive the same
 * decision rather than a copy of it.
 */
export class BootFocusGate {
  #presented = false;

  /**
   * False exactly once — the boot presentation of this surface. True on every
   * later call, which is always a user-driven transition.
   */
  allowsFocus(): boolean {
    if (this.#presented) return true;
    this.#presented = true;
    return false;
  }
}
