/**
 * The install host and the commands built from it, in ONE place.
 *
 * WHY THIS FILE EXISTS. The host was written out as the literal placeholder
 * `<host>` in six separate files, and the site shipped that way: the live front
 * page told strangers to run
 *
 *     curl -fsSL https://<host>/install.sh | sh
 *
 * which is not a command, it is a diagram of one. Every copy carried its own
 * comment explaining that the placeholder was deliberate and would be replaced
 * before launch, so each file looked correct in isolation and the page was
 * broken. Six files is also why it stayed broken: fixing it meant finding all
 * six, and the first search found three.
 *
 * So the host is a constant here and nothing else may spell it. If it moves,
 * one edit moves every command on the site, and a grep for `<host>` under
 * site/src returning nothing is a meaningful check rather than a hopeful one.
 *
 * WHAT MAKES THIS TRUE RATHER THAN INTENDED: `site/package.json` copies the
 * repo-root `install.sh` into `public/` on every build, so the file served at
 * the address below is the same file the repo reviews. Verify against the
 * DEPLOYED site, not the source — `curl -fsSL https://commonswarm.com/install.sh`
 * must return the installer, with a positive control proving the check can fail.
 *
 * THE PINNED VERSION IS NOT TYPED HERE EITHER. The version halves of these commands
 * come from lib/release.ts, which reads the repo-root package.json — a bump touches
 * that one field and nothing on this page.
 */
import { CLI_VERSION } from "./release.ts";

export const INSTALL_HOST = "commonswarm.com";

/** The one line a stranger is asked to run. Everything else is a variation. */
export const INSTALL_CMD = `curl -fsSL https://${INSTALL_HOST}/install.sh | sh`;

/**
 * Pin a version instead of taking latest. `CSWARM_VERSION` is read by the
 * installer itself; it is not a flag we invented for the page. The version is
 * the shipping CLI version from lib/release.ts (root package.json); the pipe
 * order and the variable name must not be rearranged.
 */
export const INSTALL_CMD_PINNED =
  `curl -fsSL https://${INSTALL_HOST}/install.sh | CSWARM_VERSION=${CLI_VERSION} sh`;

/** Install somewhere other than ~/.local/bin. Also the installer's own variable. */
export const INSTALL_CMD_DIR =
  `curl -fsSL https://${INSTALL_HOST}/install.sh | CSWARM_INSTALL_DIR="$HOME/bin" sh`;

/**
 * For people whose node comes from a version manager. A non-login shell cannot
 * see nvm/fnm/asdf's node, so the installer's own error names this case; this is
 * the command that error tells them to run.
 */
export const INSTALL_CMD_LOGIN_SHELL =
  `zsh -lic 'curl -fsSL https://${INSTALL_HOST}/install.sh | sh'`;
