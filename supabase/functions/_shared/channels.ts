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

/** The chat fields of a post_signal body, after the caller resolved presence. */
export interface ChatSignalFields {
  signal_kind: unknown;
  to_user_id: unknown;
  to_agent_principal_id: unknown;
  in_reply_to: unknown;
  /** `undefined` means the key was absent from the body. */
  channel?: unknown;
  thread_root_id?: unknown;
  broadcast_to_channel?: unknown;
}

/**
 * Every rule the chat fields add to post_signal, in one pure function so the
 * rules are testable without a Deno runtime and so no caller can enforce half
 * of them. Returns the refusal sentence, or null when the shape is usable.
 *
 * Type and uuid checks for the pre-existing fields stay with the caller; this
 * function decides only what the chat fields mean together.
 */
export function chatSignalShapeProblem(
  fields: ChatSignalFields,
): string | null {
  const channel = fields.channel;
  const threadRoot = fields.thread_root_id === undefined
    ? null
    : fields.thread_root_id;
  const broadcast = fields.broadcast_to_channel;

  if (channel !== undefined && channel !== null) {
    const problem = channelSlugProblem(channel);
    if (problem !== null) return problem;
  }
  if (broadcast !== undefined && typeof broadcast !== "boolean") {
    return "broadcast_to_channel is true or false.";
  }

  if (threadRoot !== null && threadRoot !== undefined) {
    /* A threaded reply is a message in the open. R11: ask or note, never
     * working-on. It carries no recipient, because a thread everyone can see
     * cannot have a private half. And it does not also set in_reply_to: that
     * column means "reply privately to the author" and the server re-addresses
     * the row on it, so accepting both would make the audience ambiguous at the
     * exact place addressing is decided. */
    if (fields.signal_kind === "working-on") {
      return "A working-on signal cannot be a thread reply. Reply with a note or an ask.";
    }
    /* An ABSENT key and an explicit null mean the same thing here. The command
     * edge's exactKeys short-circuits before this function ever sees an absent
     * modern key, so this is not reachable there today -- but this function is
     * the one place the rules live, and it must be right read on its own. */
    const toUser = fields.to_user_id ?? null;
    const toAgent = fields.to_agent_principal_id ?? null;
    if (toUser !== null || toAgent !== null) {
      return "A thread reply is readable by everyone who can read its thread, so it cannot also be addressed to one recipient.";
    }
    if (fields.in_reply_to !== null && fields.in_reply_to !== undefined) {
      return "Use thread_root_id for a reply in the thread, or in_reply_to for a private reply to the author. Not both.";
    }
    if (channel !== undefined && channel !== null) {
      return "A thread reply is filed in the channel its thread is in, so it does not take a channel of its own.";
    }
  }

  if (broadcast === true && (threadRoot === null || threadRoot === undefined)) {
    return "broadcast_to_channel says to send a thread reply to the channel as well, so it needs a thread_root_id.";
  }
  return null;
}

/**
 * The "this command takes these fields" sentence, BUILT from the same arrays
 * the `exactKeys` check reads. Typing that list is the failure AGENTS.md
 * measured four times in one release cycle: the sentence and the enforcement
 * drift the moment one of them changes, and the arms do not catch it because
 * reading it means re-deriving the enforcement.
 *
 * `kind` is the command name; `required` and `optional` are the exact key
 * arrays, minus the literal "kind" every command carries.
 */
export function commandFieldsMessage(
  kind: string,
  required: readonly string[],
  optional: readonly string[] = [],
): string {
  const list = (names: readonly string[]): string =>
    names.length === 1
      ? names[0]!
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
  const head = required.length === 0
    ? `${kind} takes no fields`
    : `${kind} takes ${list(required)}`;
  return optional.length === 0
    ? `${head}.`
    : `${head}, and optionally ${list(optional)}.`;
}
