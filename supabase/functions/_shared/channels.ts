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

/**
 * The signal kinds, once for the edge. AGENTS.md records SEVEN un-synced copies
 * of this set across the edge, the clients and the table CHECK; this collapses
 * the three EDGE copies (command's array, command's type, read's Set) into one.
 * The client copies in src/ and the CHECK in 20260724000003_signals.sql:10 are
 * still separate and still owed by a later lane.
 *
 * It lives HERE rather than in signal-text.ts because this module is imported
 * by Node tests as well as by Deno: a relative "./signal-text.ts" import breaks
 * `npm run check:tests`, and a ".js" one breaks `npm run check:edge`. One file
 * with no relative imports satisfies both typecheckers.
 *
 * Any user-facing sentence naming these kinds must be BUILT from this array.
 */
export const SIGNAL_KINDS = ["working-on", "note", "ask"] as const;
export type SignalKind = typeof SIGNAL_KINDS[number];

/**
 * "a" or "an" for a word, so a generated list does not read "a ask". The list
 * was generated and the article was typed, which is the same drift one level
 * down: add a kind starting with a vowel and the sentence goes wrong on its own.
 */
export function indefiniteArticle(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

/** Kinds a thread reply may take. R11: a thread reply is never working-on. */
export const THREAD_REPLY_KINDS: readonly SignalKind[] = SIGNAL_KINDS.filter(
  (kind) => kind !== "working-on",
);

/** Longest channel slug. The database CHECK carries the same bound. */
export const CHANNEL_SLUG_MAX = 32;

/** Longest channel purpose. The database CHECK carries the same bound. */
export const CHANNEL_PURPOSE_MAX = 500;

/**
 * Lowercase letters, digits and hyphens; first and last character alphanumeric.
 * The identical pattern is the CHECK on swarm.channels.slug.
 */
/**
 * The character classes the slug pattern allows, as {regex fragment, words}.
 * BOTH the regex and the sentence are built from this table, so a class cannot
 * be added to one and left out of the other. An arm pointed out that the bound
 * was interpolated while the class list beside it was typed prose.
 *
 * `edge` is the class allowed at the first and last character; `inner` adds the
 * classes allowed only in between.
 */
export const CHANNEL_SLUG_CLASSES = {
  edge: [
    { fragment: "a-z", words: "lowercase letters", one: "a letter" },
    { fragment: "0-9", words: "digits", one: "a digit" },
  ],
  inner: [{ fragment: "-", words: "hyphens" }],
} as const;

function classList(
  entries: readonly { words: string; one?: string }[],
  conjunction: "and" | "or" = "and",
  singular = false,
): string {
  const words = entries.map((entry) =>
    singular ? (entry.one ?? entry.words) : entry.words
  );
  return words.length === 1
    ? words[0]!
    : `${words.slice(0, -1).join(", ")} ${conjunction} ${
      words[words.length - 1]!
    }`;
}

const SLUG_EDGE = CHANNEL_SLUG_CLASSES.edge.map((c) => c.fragment).join("");
const SLUG_INNER = SLUG_EDGE +
  CHANNEL_SLUG_CLASSES.inner.map((c) => c.fragment).join("");

function channelSlugPattern(): RegExp {
  return new RegExp(`^[${SLUG_EDGE}]([${SLUG_INNER}]*[${SLUG_EDGE}])?$`);
}

export const CHANNEL_SLUG_RE = channelSlugPattern();

/**
 * The edges' UUID_RE, character for character: version [1-8] and variant
 * [89ab], not any 8-4-4-4-12 hex. Local so this module imports no edge file --
 * it is typechecked by BOTH deno and tsc, and a relative import satisfies only
 * one of them.
 *
 * An earlier version accepted the nil uuid here while the edge's own check
 * refused it, so the caller got the generic "malformed" reason and never the
 * chat sentence. tests/chat-signal-wire-compat.test.ts pins the two together.
 */
const CHAT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Names a channel may not take. `all-signals` is the unfiltered view, not a
 * row, so a channel by that name would shadow the one place unfiled signals
 * are readable.
 */
export const RESERVED_CHANNEL_SLUGS: readonly string[] = ["all-signals"];

/**
 * "<field> must be a UUID.", from one place. Three validators answer a
 * malformed id and each had typed its own sentence; the wording is the same
 * shape every time, so it is built once and the field name is the only input.
 */
export function uuidFieldRuleText(field: string): string {
  return `${field} must be a UUID.`;
}

/** What a channel_id is, for the refusal that fires when one is malformed. */
export const CHANNEL_ID_RULE_TEXT = uuidFieldRuleText("channel_id");

/**
 * The model bound and its sentence, together. src/protocol's normalizedModel
 * owns the same 120 and the same "string or null" rule, but it is NOT exported
 * from the protocol bundle, so the edge cannot call it the way it now calls the
 * feedback normalizers. This is a DOCUMENTED hand copy, not an accident: the
 * number lives in one place on this side and the sentence is built from it, and
 * the day normalizedModel is exported the edge should call it and delete this.
 */
export const MODEL_MAX = 120;
export const MODEL_CONTROL_RULE_TEXT =
  "model must not contain control characters.";
export const MODEL_RULE_TEXT =
  `model is text of at most ${MODEL_MAX} characters, or null.`;

/** The slug rule, in words, built from the bound the validator enforces. */
export const CHANNEL_SLUG_RULE_TEXT = `A channel name uses ${
  classList([...CHANNEL_SLUG_CLASSES.edge, ...CHANNEL_SLUG_CLASSES.inner])
}, starts and ends with ${
  classList(CHANNEL_SLUG_CLASSES.edge, "or", true)
}, and is 1 to ${CHANNEL_SLUG_MAX} characters.`;

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
 * The kinds of thing a signal can be addressed to. Every sentence about `to`
 * is built from this array, so a third kind changes the check and the words in
 * one edit.
 */
export const SIGNAL_RECIPIENT_KINDS = ["user", "agent"] as const;
export type SignalRecipientKind = typeof SIGNAL_RECIPIENT_KINDS[number];

/**
 * The most recipients one signal may carry, and one of the cap's TWO
 * enforcement points. The other is the CHECK on swarm.signal_recipients.position
 * in 20260905000010_signal_recipients.sql, which caps the row count at this
 * number because positions are unique per signal and cannot exceed
 * SIGNAL_RECIPIENT_MAX - 1. tests/chat-channel-constants.test.ts fails if the
 * SQL bound and this constant drift apart, the same way it already pins the
 * channel slug bound.
 *
 * The value is 8 because that is what site/src/lib/mention-address.ts already
 * enforces on a composed message (MENTION_MAX_RECIPIENTS). The composer now
 * posts ONE signal carrying this whole list in `to`, and its To: field reads its
 * cap from this constant (COMPOSER_TO_MAX in site/src/lib/composer-address.ts).
 *
 * RETIRED 2026-09-05: "each tag costs a whole signal, a wake and a receipt row
 * -- that composer posts one directed signal per tag and has not moved to `to`
 * yet." That was true of the 2026-09-04 composer, which fanned a message out
 * into one signal per tag. It is preserved here because the reasoning it
 * supported is not: a recipient no longer costs a signal or a wake. Naming a
 * recipient costs a row in swarm.signal_recipients and nothing else, and only
 * the recipient at position 0 is woken, because swarm.enqueue_signal_delivery
 * fires on swarm.signals.to_agent_principal_id and this edge writes recipient 0
 * into that column. The same test pins the two numbers together, so the composer
 * and the server cannot disagree about how many recipients fit.
 */
export const SIGNAL_RECIPIENT_MAX = 8;

/**
 * The scalar recipient fields a body may still send. `to` replaces BOTH of
 * them, so the conflict sentence names whichever one the caller set, from this
 * list rather than from a typed pair.
 */
export const SCALAR_RECIPIENT_FIELDS = [
  "to_user_id",
  "to_agent_principal_id",
] as const;

/**
 * "1 recipient" / "8 recipients", so a bound and its noun cannot disagree. The
 * plural was written out beside the number twice before this existed.
 */
function countNoun(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

/** What a `to` entry is, built from the kind list and the cap. */
export const SIGNAL_RECIPIENT_RULE_TEXT = `to is a list of recipients. Each one is {kind, id}, kind is ${
  classList(
    SIGNAL_RECIPIENT_KINDS.map((kind) => ({ words: kind })),
    "or",
  )
}, and id is a UUID. A signal is addressed to at most ${SIGNAL_RECIPIENT_MAX} ${
  countNoun(SIGNAL_RECIPIENT_MAX, "recipient")
}.`;

/** One recipient, after the shape is known good. */
export interface SignalRecipient {
  kind: SignalRecipientKind;
  id: string;
}

function isRecipientEntry(value: unknown): value is SignalRecipient {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry).sort();
  return keys.length === 2 && keys[0] === "id" && keys[1] === "kind" &&
    typeof entry.kind === "string" &&
    (SIGNAL_RECIPIENT_KINDS as readonly string[]).includes(entry.kind) &&
    typeof entry.id === "string" && CHAT_UUID_RE.test(entry.id);
}

/**
 * The refusal for a malformed `to`, or null when the list is usable. Absent and
 * explicit null both mean "no list", the same way `channel` treats them.
 *
 * Every sentence here is built from SIGNAL_RECIPIENT_KINDS and
 * SIGNAL_RECIPIENT_MAX. Typing "user or agent" or "at most 8" beside a check
 * that reads the constants is the failure AGENTS.md measured four times in one
 * release cycle.
 */
export function signalRecipientListProblem(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return SIGNAL_RECIPIENT_RULE_TEXT;
  if (value.length === 0) {
    return "to names at least one recipient. Leave it out to post to the whole workspace.";
  }
  if (value.length > SIGNAL_RECIPIENT_MAX) {
    return `A signal is addressed to at most ${SIGNAL_RECIPIENT_MAX} ${
      countNoun(SIGNAL_RECIPIENT_MAX, "recipient")
    }. This one names ${value.length}.`;
  }
  for (const entry of value) {
    if (!isRecipientEntry(entry)) return SIGNAL_RECIPIENT_RULE_TEXT;
  }
  const seen = new Set<string>();
  for (const entry of value as SignalRecipient[]) {
    const key = `${entry.kind}:${entry.id.toLowerCase()}`;
    if (seen.has(key)) return "to names the same recipient twice.";
    seen.add(key);
  }
  return null;
}

/**
 * The list, lower-cased, after signalRecipientListProblem returned null. Null
 * means the body carried no list. The caller never re-derives the shape: this
 * is the one place a `to` becomes typed.
 */
export function parseSignalRecipients(
  value: unknown,
): SignalRecipient[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return null;
  const parsed: SignalRecipient[] = [];
  for (const entry of value) {
    if (!isRecipientEntry(entry)) return null;
    parsed.push({ kind: entry.kind, id: entry.id.toLowerCase() });
  }
  return parsed;
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
  "to",
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
  /** The multi-recipient list. `undefined` means the key was absent. */
  to?: unknown;
}

/**
 * Every rule the chat fields add to post_signal, in one pure function so the
 * rules are testable without a Deno runtime and so no caller can enforce half
 * of them. Returns the refusal sentence, or null when the shape is usable.
 *
 * Type and uuid checks for the PRE-EXISTING fields stay with the caller. The
 * chat fields' own checks belong here, including thread_root_id's uuid shape:
 * a review arm pointed out that leaving one chat rule on the edge is exactly
 * the split this function exists to prevent.
 */
export function chatSignalShapeProblem(
  fields: ChatSignalFields,
): string | null {
  const channel = fields.channel;
  const threadRoot = fields.thread_root_id === undefined
    ? null
    : fields.thread_root_id;
  const broadcast = fields.broadcast_to_channel;

  /* SHAPE BEFORE MEANING. A field that is not a valid id is not yet a thread
   * reply, so its shape is the first rule broken. Moving the thread rules ahead
   * of the SLUG rule (an earlier arm finding) put them ahead of this check too,
   * and a body with a malformed thread_root_id AND a channel was told a thread
   * reply takes no channel -- a rule about a thread it was not yet making. The
   * uuid test therefore runs first, the way the edge runs baseValid before any
   * chat sentence. */
  if (
    threadRoot !== undefined && threadRoot !== null &&
    !(typeof threadRoot === "string" && CHAT_UUID_RE.test(threadRoot))
  ) {
    return "thread_root_id is the id of the message the thread starts from, as a UUID.";
  }
  if (broadcast !== undefined && typeof broadcast !== "boolean") {
    return "broadcast_to_channel is true or false.";
  }
  /* IMPOSSIBLE BEFORE MERELY WRONG, the rule the comment below states. This
   * test used to sit at the END of this function, after the slug rule, so
   * `broadcast_to_channel: true` with no thread_root_id and a misspelled
   * channel was told how to spell a channel name -- advice that cannot make
   * the request legal, because there is no thread to broadcast from. The
   * request is impossible whatever the slug says, so say that first. It is
   * safe here: this arm needs thread_root_id ABSENT and every rule between
   * here and its old position needs it PRESENT, so no other refusal changes. */
  if (broadcast === true && (threadRoot === null || threadRoot === undefined)) {
    return "broadcast_to_channel says to send a thread reply to the channel as well, so it needs a thread_root_id.";
  }
  /* SHAPE BEFORE MEANING again: a `to` that is not a list of recipients is not
   * yet an address, so every rule below that reads the list runs after this. */
  const recipientProblem = signalRecipientListProblem(fields.to);
  if (recipientProblem !== null) return recipientProblem;
  const recipientCount = Array.isArray(fields.to) ? fields.to.length : 0;
  if (recipientCount > 0) {
    /* `to` replaces BOTH scalar fields. Sending one of them as well is two
     * answers to the same question, and the design rules out reconciling them
     * silently. The names come from SCALAR_RECIPIENT_FIELDS, so a third scalar
     * field could not be added without appearing in this sentence. */
    const bothWays = SCALAR_RECIPIENT_FIELDS.filter((field) => {
      const value = (fields as unknown as Record<string, unknown>)[field];
      return value !== null && value !== undefined;
    });
    if (bothWays.length > 0) {
      return `${
        classList(bothWays.map((field) => ({ words: field })))
      } names a recipient and so does to. Put every recipient in to, and leave ${
        bothWays.length === 1 ? "it" : "them"
      } null.`;
    }
  }
  /* Now that the field IS an id, the rule that makes the request impossible
   * outranks the rule that is merely also broken: a thread reply takes no
   * channel at all, so say that rather than the slug's spelling. */
  if (
    threadRoot !== null && threadRoot !== undefined &&
    channel !== undefined && channel !== null
  ) {
    return "A thread reply is filed in the channel its thread is in, so it does not take a channel of its own.";
  }
  if (channel !== undefined && channel !== null) {
    const problem = channelSlugProblem(channel);
    if (problem !== null) return problem;
  }

  if (threadRoot !== null && threadRoot !== undefined) {
    /* A threaded reply is a message in the open. R11: ask or note, never
     * working-on. It carries no recipient, because a thread everyone can see
     * cannot have a private half. And it does not also set in_reply_to: that
     * column means "reply privately to the author" and the server re-addresses
     * the row on it, so accepting both would make the audience ambiguous at the
     * exact place addressing is decided. */
    if (!THREAD_REPLY_KINDS.includes(fields.signal_kind as never)) {
      /* Both halves come from THREAD_REPLY_KINDS: the CHECK and the sentence
       * that describes it. Testing `=== "working-on"` while naming "note or an
       * ask" in the text was a typed enumeration inside a correct-looking
       * sentence, which is the exact shape AGENTS.md says the arms do not
       * catch. A fourth kind now changes both at once. */
      const refused = String(fields.signal_kind);
      return `${
        indefiniteArticle(refused) === "an" ? "An" : "A"
      } ${refused} signal cannot be a thread reply. Reply with ${
        THREAD_REPLY_KINDS
          .map((kind) => `${indefiniteArticle(kind)} ${kind}`)
          .join(" or ")
      }.`;
    }
    /* An ABSENT key and an explicit null mean the same thing here. The command
     * edge's exactKeys short-circuits before this function ever sees an absent
     * modern key, so this is not reachable there today -- but this function is
     * the one place the rules live, and it must be right read on its own. */
    const toUser = fields.to_user_id ?? null;
    const toAgent = fields.to_agent_principal_id ?? null;
    /* `to` is a third way to address a reply and is refused by the same rule.
     * Leaving it out of this test would have let a thread reply carry a
     * recipient set through the one check that exists to stop it. */
    if (toUser !== null || toAgent !== null || recipientCount > 0) {
      return "A thread reply is readable by everyone who can read its thread, so it cannot also be addressed to a recipient.";
    }
    if (fields.in_reply_to !== null && fields.in_reply_to !== undefined) {
      return "Use thread_root_id for a reply in the thread, or in_reply_to for a private reply to the author. Not both.";
    }
    /* The channel-on-a-thread-reply rule is checked above, before the slug
     * rule, so there is no second test here. */
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
/**
 * The feedback categories, once. The validator tested three string literals and
 * the refusal sentence typed the same three in prose -- invisible while the
 * reason went only to swarm.audit, user-facing the moment this lane put it on
 * the wire. A fourth category would have changed the check and not the sentence.
 */
export function commandFieldsMessage(
  kind: string,
  required: readonly string[],
  optional: readonly string[] = [],
  describe: Readonly<Record<string, string>> = {},
): string {
  /* `describe` decorates a key for the reader -- "category (bug|idea|friction)"
   * -- WITHOUT forking the list. An earlier version took an already-decorated
   * array, so the sentence and the exactKeys check read two different arrays
   * and adding a field to one did not change the other. Both arms found it. */
  const label = (key: string): string =>
    describe[key] === undefined ? key : `${key} (${describe[key]})`;
  const list = (names: readonly string[]): string =>
    names.length === 1
      ? label(names[0]!)
      : `${names.slice(0, -1).map(label).join(", ")} and ${
        label(names[names.length - 1]!)
      }`;
  const head = required.length === 0
    ? `${kind} takes no fields`
    : `${kind} takes ${list(required)}`;
  const body = optional.length === 0
    ? head
    : `${head}, and optionally ${list(optional)}`;
  /* "and nothing else" is load-bearing: exactKeys refuses ANY extra key, and a
   * sentence that only lists what is accepted does not say that. Dropping it
   * when this generator replaced the typed strings was a real loss of meaning,
   * and both arms called it. */
  return `${body}, and nothing else.`;
}
