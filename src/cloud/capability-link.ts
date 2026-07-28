import { assertCapabilityToken } from "./command-client.js";

/**
 * The public project alias, never a per-deployment Vercel host: those 302 to Vercel SSO
 * for anyone the link is forwarded to, which is exactly the person a capability link is
 * for (AGENTS.md, "Deploying the marketing site", trap 3).
 */
export const CAPABILITY_SITE_ORIGIN = "https://coswarm-site.vercel.app";

/**
 * The browser page that trades the fragment for a read. The token rides in the fragment
 * and not the path or query because a fragment is never sent to any server, never lands
 * in an access log, and never appears in a Referer header (SWARM-CLOUD.md §7).
 */
const CAPABILITY_PATH = "/see";

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/**
 * What a holder of the link can read, in one place, so the CLI sentence and docs/ cannot
 * drift apart. Mirrors the projection function's RETURNS TABLE — the allowlist is
 * enforced by Postgres, and this only describes it.
 */
export const CAPABILITY_DISCLOSURE =
  "Anyone holding the link can read this one work item: its name and state, the repository it belongs to, who invited them, and how long the project has existed. It reaches nothing else — not the member list, not the message feed, not any other work item.";

function loopbackOrigin(parsed: URL): boolean {
  return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
}

/**
 * Resolved and validated before the mint request is sent, so a mistyped origin costs one
 * line rather than a live credential that cannot be printed as a usable link.
 */
export function capabilitySiteOrigin(
  explicit: string | undefined,
  environmental: string | undefined,
): string {
  const raw = (explicit ?? environmental ?? CAPABILITY_SITE_ORIGIN).trim();
  if (!raw) {
    throw new Error(
      "--site is required when CSWARM_SITE_ORIGIN is set to an empty value",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      "--site must be the site's base origin, for example https://coswarm-site.vercel.app",
    );
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopbackOrigin(parsed))) {
    throw new Error(
      "--site must use https, because the link carries a credential; plain http is accepted only on localhost",
    );
  }
  if (
    parsed.username || parsed.password || parsed.search || parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new Error(
      "--site must be a bare origin with no path, query, fragment, or credentials",
    );
  }
  return parsed.origin;
}

/**
 * Composes the shareable link. The server never learns the site origin and never builds
 * this string — it hands back a credential, and the client decides where it is redeemed.
 */
export function capabilityUrl(origin: string, token: string): string {
  assertCapabilityToken(token);
  return `${origin}${CAPABILITY_PATH}#${token}`;
}

/** Rejects a timestamp we would otherwise print verbatim; server strings are untrusted. */
export function capabilityTimestamp(
  value: string | undefined,
  field: string,
): string {
  if (
    value === undefined || !ISO_TIMESTAMP_RE.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(`server returned a malformed ${field}`);
  }
  return value;
}

export interface CapabilityMintDisplay {
  /** Contains the raw credential. Rendered exactly once and stored nowhere. */
  url: string;
  taskId: string;
  capabilityId: string;
  expiresAt: string;
}

/**
 * The one and only place the credential is shown. Kept a pure function so the wording is
 * reviewable without minting anything, and so the caller can prove the token appears once.
 */
export function renderCapabilityMint(display: CapabilityMintDisplay): string {
  return [
    `Capability link created for work item ${display.taskId}.`,
    "",
    `  ${display.url}`,
    "",
    "This is the only time the link is shown. CommonSwarm stores just a hash of it, so it cannot be printed again — if it is lost, create another and revoke this one.",
    CAPABILITY_DISCLOSURE,
    `It stops working at ${display.expiresAt}, or sooner if you run:`,
    `  cswarm link revoke --capability-id ${display.capabilityId}`,
  ].join("\n");
}

export function renderCapabilityRevoke(
  capabilityId: string,
  revokedAt: string,
): string {
  return `Capability link ${capabilityId} was revoked at ${revokedAt}. Anyone who still holds it now gets the same answer as someone holding a link that never existed. Links you have not revoked are unaffected.`;
}
