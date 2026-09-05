/**
 * Channel vocabulary and request shape, in one place.
 *
 * Two rules from AGENTS.md meet in this file.
 *
 * 1. An enumeration inside a user-facing message must be GENERATED from the
 *    constant the enforcement reads. Every sentence below is built from the
 *    same values the validators use, so a new reserved slug or a changed length
 *    bound cannot leave a stale sentence behind. That failure was measured four
 *    times in one release cycle, each time after two review arms passed.
 * 2. Every new optional request key gets its OWN `Object.hasOwn` group.
 *    `modernKeys` in the command edge is an all-or-nothing pair that every
 *    installed client always sends; folding a new key into it returns 400 on
 *    every post and every agent read, after a perfectly ordered migration.
 *    `chatSignalKeys` exists so no caller has to remember that.
 *
 * The database enforces the slug SHAPE independently
 * (20260905000001_channels.sql). tests/chat-channel-constants.test.ts fails if
 * the SQL pattern and CHANNEL_SLUG_RE drift apart. Reserved slugs are a product
 * decision and are enforced here only.
 */

/** Longest channel slug. The database CHECK carries the same bound. */
export const CHANNEL_SLUG_MAX = 32;

/** Longest channel purpose. The database CHECK carries the same bound. */
export const CHANNEL_PURPOSE_MAX = 500;

/**
 * Lowercase letters, digits and hyphens; first and last character alphanumeric.
 * The identical pattern is the CHECK on swarm.channels.slug.
 */
export const CHANNEL_SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Names a channel may not take. `all-signals` is the unfiltered view, not a
 * row, so a channel by that name would shadow the one place unfiled signals
 * are readable.
 */
export const RESERVED_CHANNEL_SLUGS: readonly string[] = ["all-signals"];

/** The slug rule, in words, built from the bound the validator enforces. */
export const CHANNEL_SLUG_RULE_TEXT =
  `A channel name uses lowercase letters, digits and hyphens, starts and ends with a letter or a digit, and is 1 to ${CHANNEL_SLUG_MAX} characters.`;

/** The reserved list, in words, built from the list the validator enforces. */
export const RESERVED_CHANNEL_SLUG_TEXT = `Reserved names: ${
  RESERVED_CHANNEL_SLUGS.join(", ")
}.`;

/** Trim and lowercase. Slugs compare case-insensitively in the unique index. */
export function normalizeChannelSlug(value: string): string {
  return value.trim().toLowerCase();
}

export function isReservedChannelSlug(value: string): boolean {
  return RESERVED_CHANNEL_SLUGS.includes(normalizeChannelSlug(value));
}

/**
 * The one refusal message for a bad slug, or null when the slug is usable.
 * Both sentences are generated, so a reader is never told a rule the validator
 * does not apply.
 */
export function channelSlugProblem(value: unknown): string | null {
  if (typeof value !== "string") {
    return `A channel name must be text. ${CHANNEL_SLUG_RULE_TEXT}`;
  }
  const slug = normalizeChannelSlug(value);
  if (slug.length < 1 || slug.length > CHANNEL_SLUG_MAX) {
    return CHANNEL_SLUG_RULE_TEXT;
  }
  if (!CHANNEL_SLUG_RE.test(slug)) {
    return CHANNEL_SLUG_RULE_TEXT;
  }
  if (isReservedChannelSlug(slug)) {
    return `${slug} is reserved. ${RESERVED_CHANNEL_SLUG_TEXT}`;
  }
  return null;
}

/**
 * The message shown when a slug names no channel in the route's workspace. The
 * list is passed in from the same query the validator ran, never typed.
 */
export function unknownChannelMessage(
  slug: string,
  liveSlugs: readonly string[],
): string {
  const known = [...liveSlugs].sort();
  return known.length === 0
    ? `There is no channel named ${normalizeChannelSlug(slug)} in this workspace, and no channel has been created yet.`
    : `There is no channel named ${normalizeChannelSlug(slug)} in this workspace. Channels here: ${
      known.join(", ")
    }.`;
}

/**
 * The optional chat keys a post_signal body may carry. Each is INDEPENDENT: a
 * body may send any subset, including none. Never merge these into a group that
 * demands its siblings.
 */
export const CHAT_SIGNAL_OPTIONAL_KEYS: readonly string[] = [
  "channel",
  "thread_root_id",
  "broadcast_to_channel",
];

/**
 * The chat keys actually present on a body, for the caller's `exactKeys` list.
 * A body that sends none — which is every installed client — gets an empty
 * array, so its key set is unchanged and it still validates.
 */
export function chatSignalKeys(
  body: Record<string, unknown>,
): string[] {
  return CHAT_SIGNAL_OPTIONAL_KEYS.filter((key) => Object.hasOwn(body, key));
}

/**
 * The same rule for the read edge, which accepts only `channel`. Agent read
 * bodies always carry `in_reply_to`, so this must not join that group.
 */
export function chatReadKeys(body: Record<string, unknown>): string[] {
  return Object.hasOwn(body, "channel") ? ["channel"] : [];
}
