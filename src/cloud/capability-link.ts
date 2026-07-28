import { assertCapabilityToken } from "./command-client.js";

/**
 * The public project alias, never a per-deployment Vercel host: those 302 to Vercel SSO
 * for anyone the link is forwarded to, which is exactly the person a capability link is
 * for (AGENTS.md, "Deploying the marketing site", trap 3).
 */
export const CAPABILITY_SITE_ORIGIN = "https://coswarm-site.vercel.app";

/**
 * The complete set of hosts a capability link may point at. An allowlist, not a syntax
 * check: the printed link IS the credential, so accepting any well-formed https origin
 * means one mistyped or attacker-supplied --site (or CSWARM_SITE_ORIGIN, which nothing
 * about the CLI's own invocation reveals) sends the operator to paste a working token
 * into a stranger's host, where it reads the work item and is then held indefinitely.
 * `coswarm-site.vercel.app` is the Vercel project alias and stays until DNS moves.
 */
export const CAPABILITY_ALLOWED_HOSTS: readonly string[] = [
  "commonswarm.com",
  "www.commonswarm.com",
  "coswarm-site.vercel.app",
];

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
  // Named in every message below, because the dangerous case is the one the operator
  // cannot see: CSWARM_SITE_ORIGIN is set somewhere else and appears nowhere in the
  // command they typed. "--site is wrong" would send them looking at the wrong thing.
  const source = explicit !== undefined ? "--site" : "CSWARM_SITE_ORIGIN";
  const raw = (explicit ?? environmental ?? CAPABILITY_SITE_ORIGIN).trim();
  if (!raw) {
    // `source`, not a hardcoded name. `--site ""` and `--site "  "` reach this line with
    // explicit === "" — the CLI's parser hands an empty flag value through verbatim — and
    // the message here used to say "--site is required when CSWARM_SITE_ORIGIN is set to
    // an empty value" in that case too, sending an operator who had just typed --site off
    // to inspect an environment variable that was not involved. It is dead.
    throw new Error(
      `${source} is empty; it must be the site's base origin, for example ${CAPABILITY_SITE_ORIGIN}${
        explicit === undefined ? ", or unset it to use the default" : ""
      }`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `${source} must be the site's base origin, for example ${CAPABILITY_SITE_ORIGIN}`,
    );
  }
  const loopback = loopbackOrigin(parsed);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error(
      `${source} must use https, because the link carries a credential; plain http is accepted only on localhost`,
    );
  }
  if (
    parsed.username || parsed.password || parsed.search || parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new Error(
      `${source} must be a bare origin with no path, query, fragment, or credentials`,
    );
  }
  // The host is checked against the allowlist, never merely parsed. https and a bare
  // origin say only that the string is well formed — they say nothing about who receives
  // the credential the operator is about to paste there.
  if (!loopback && !CAPABILITY_ALLOWED_HOSTS.includes(parsed.hostname)) {
    throw new Error(
      `${source} must name a CommonSwarm page — ${
        CAPABILITY_ALLOWED_HOSTS.map((host) => `https://${host}`).join(", ")
      }, or http://localhost / http://127.0.0.1 while developing that page. The link this prints is a live credential for one work item, so it may only point somewhere CommonSwarm serves.`,
    );
  }
  // A port would still be a CommonSwarm host, but nothing CommonSwarm serves listens on
  // one, so it is a typo rather than a deployment.
  if (!loopback && parsed.port !== "") {
    throw new Error(
      `${source} must not carry a port; a CommonSwarm page is served on the default https port`,
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
