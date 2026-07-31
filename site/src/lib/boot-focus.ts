/*
 * Boot-time focus gate for the dashboard's scripted focus moves.
 *
 * Two surfaces move focus programmatically: showPanel (to a panel's heading) and
 * showAuthView (to the email field). Each surface owns an independent gate, so a
 * transition can move context once without a second surface immediately moving
 * it again. The platform's own heuristic paints :focus-visible for keyboard users
 * and not for pointer users.
 *
 * The FIRST presentation of each surface is different: it may be the page boot,
 * or the auth form's first appearance after a signed-in boot. Moving focus there
 * can paint an unsolicited ring, raise the phone keyboard, or compete with the
 * panel heading that already received the transition. So that surface's first
 * presentation skips the move.
 *
 * One gate per surface, each independent: the first call says skip, every later
 * call says move. Pure and I/O-free so the dashboard and its test drive the same
 * decision rather than a copy of it.
 */
export class BootFocusGate {
  #presented = false;

  /**
   * False exactly once — the first presentation of this surface. True on every
   * later call.
   */
  allowsFocus(): boolean {
    if (this.#presented) return true;
    this.#presented = true;
    return false;
  }
}
