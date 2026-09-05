/**
 * THE To: FIELD IS THE ADDRESS. One message carries one recipient set; the composer shows that
 * set as chips and posts it as the wire's `to` list.
 *
 * This replaces "the address is the message" (2026-09-04), where an @tag in the body was the
 * only address and the send posted ONE SIGNAL PER TAG. That behaviour lost the person you were
 * last messaging every time you typed a new tag, which is the defect this module exists to
 * remove. An @tag now ADDS to the set and never replaces it.
 *
 * Everything a reader is told here is built from the constants the server enforces:
 *
 * - the cap is `SIGNAL_RECIPIENT_MAX`, the number the command edge refuses above and the number
 *   the CHECK on `swarm.signal_recipients.position` refuses above;
 * - the wake is `NOTIFIED_POSITION`, because `swarm.enqueue_signal_delivery`
 *   (20260731000001_signal_deliveries.sql:127) enqueues a delivery only for
 *   `swarm.signals.to_agent_principal_id`, and the command edge writes recipient 0 into that
 *   column. Recipients after it are readable and repliable and are NOT woken.
 *
 * That second bound is why `composerDeliveryNote` never says "everyone is notified". It says
 * which one recipient is, and it says so from the same index `notifiedRecipient` reads.
 */
import { SIGNAL_RECIPIENT_MAX } from "../../../supabase/functions/_shared/channels.js";

/** What the browser calls a recipient. The wire says "user" where the browser says "person". */
export interface ComposerRecipient {
  kind: "agent" | "person";
  id: string;
}

/** One entry of the wire's `to` list, exactly as `signalRecipientListProblem` accepts it. */
export interface WireRecipient {
  kind: "agent" | "user";
  id: string;
}

/**
 * The most recipients one To: set may hold. It is the server's cap and not a second opinion
 * about it: `tests/chat-channel-constants.test.ts` already pins that number to the migration.
 */
export const COMPOSER_TO_MAX = SIGNAL_RECIPIENT_MAX;

/**
 * The position the command edge copies into `swarm.signals.to_user_id` /
 * `swarm.signals.to_agent_principal_id`. An old reader that knows only those columns still
 * sees a real recipient because of it.
 */
export const SCALAR_POSITION = 0;

/** The recipient whose id the server writes into the scalar column, or null for a broadcast. */
export const scalarRecipient = (
  recipients: readonly ComposerRecipient[],
): ComposerRecipient | null => recipients[SCALAR_POSITION] ?? null;

/**
 * The position whose recipient is woken. This is a fact about the database, not a preference:
 * `swarm.enqueue_signal_delivery` fires on the scalar column alone, so the wake can only ever
 * follow the position that column is filled from.
 */
export const NOTIFIED_POSITION = SCALAR_POSITION;

/**
 * The word for a position, so a sentence about the front of the list and the index the code
 * reads cannot disagree. One word per addressable position, which
 * `composer-address.test.mjs` pins to COMPOSER_TO_MAX.
 */
const POSITION_WORDS = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
] as const;

export const positionWord = (position: number): string =>
  POSITION_WORDS[position] ?? `number ${position + 1}`;

/** The wire's word for each browser kind, in one place rather than at each call site. */
const WIRE_KIND: Record<ComposerRecipient["kind"], WireRecipient["kind"]> = {
  agent: "agent",
  person: "user",
};

/** "1 recipient" / "2 recipients", so a count and its noun cannot disagree. */
const countNoun = (count: number, singular: string): string =>
  count === 1 ? singular : `${singular}s`;

/** Identity of one recipient across kinds, used for de-duplication everywhere below. */
export const recipientKey = (entity: ComposerRecipient): string =>
  `${entity.kind}:${entity.id}`;

export const sameRecipient = (
  left: ComposerRecipient,
  right: ComposerRecipient,
): boolean => recipientKey(left) === recipientKey(right);

/** The `to` list for a set. An empty set sends no list at all, which is a broadcast. */
export const toWireRecipients = (
  recipients: readonly ComposerRecipient[],
): WireRecipient[] =>
  recipients.map((entity) => ({ kind: WIRE_KIND[entity.kind], id: entity.id }));

/**
 * The one recipient the service wakes, or null when the service wakes nobody. A person at the
 * front wakes nobody at all, because the column the trigger reads holds an agent principal.
 */
export const notifiedRecipient = (
  recipients: readonly ComposerRecipient[],
): ComposerRecipient | null => {
  const front = recipients[NOTIFIED_POSITION];
  return front !== undefined && front.kind === "agent" ? front : null;
};

/** The scalar pair the server will write, so the optimistic row shows what the row will be. */
export const scalarRecipientFields = (
  recipients: readonly ComposerRecipient[],
): { toUserId: string | null; toAgentPrincipalId: string | null } => {
  const front = scalarRecipient(recipients);
  return {
    toUserId: front !== null && front.kind === "person" ? front.id : null,
    toAgentPrincipalId: front !== null && front.kind === "agent" ? front.id : null,
  };
};

/** The change one edit makes, with whatever the cap refused named rather than dropped. */
export interface ComposerToChange {
  recipients: ComposerRecipient[];
  /** Entries the cap left out. They are reported, never silently discarded. */
  refused: ComposerRecipient[];
}

/**
 * Adds recipients to the end of the set, keeping the order they arrive in and adding nobody
 * twice. Anything past the cap comes back in `refused` so the caller can say which name did
 * not fit; a set that quietly stopped growing is the hidden-recipient failure in reverse.
 */
export const addComposerRecipients = (
  current: readonly ComposerRecipient[],
  incoming: readonly ComposerRecipient[],
): ComposerToChange => {
  const recipients = [...current];
  const refused: ComposerRecipient[] = [];
  const seen = new Set(recipients.map(recipientKey));
  for (const entity of incoming) {
    const key = recipientKey(entity);
    if (seen.has(key)) continue;
    if (recipients.length >= COMPOSER_TO_MAX) {
      refused.push({ ...entity });
      continue;
    }
    seen.add(key);
    recipients.push({ kind: entity.kind, id: entity.id });
  }
  return { recipients, refused };
};

export const removeComposerRecipient = (
  current: readonly ComposerRecipient[],
  entity: ComposerRecipient,
): ComposerRecipient[] =>
  current.filter((candidate) => !sameRecipient(candidate, entity));

/**
 * Moves one recipient to the front, which is the only way a reader can change who is woken.
 * A name that is not in the set leaves the set alone: promoting is an edit of what is there,
 * never a way to add.
 */
export const promoteComposerRecipient = (
  current: readonly ComposerRecipient[],
  entity: ComposerRecipient,
): ComposerRecipient[] => {
  const found = current.find((candidate) => sameRecipient(candidate, entity));
  if (found === undefined) return [...current];
  return [found, ...current.filter((candidate) => !sameRecipient(candidate, entity))];
};

/**
 * The set, with everyone the workspace no longer has removed. A chip for a revoked agent or a
 * departed member would be a recipient the reader can see but the send cannot honour, and a
 * To: field that names one is no longer the one source of truth for delivery.
 */
export const pruneComposerRecipients = (
  current: readonly ComposerRecipient[],
  known: (entity: ComposerRecipient) => boolean,
): ComposerRecipient[] => current.filter((entity) => known(entity));

/** "a and b", "a, b and c". A joiner, not an enumeration of anything the code enforces. */
const joinNames = (names: readonly string[]): string =>
  names.length <= 1
    ? names[0] ?? ""
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/**
 * The sentence under the chips. It states the wake bound rather than implying delivery to the
 * whole set, and every clause is built from the set and the constants above.
 *
 * Clause 1 is always the wake, so the reader reads the same fact in the same place whatever
 * the set holds. Clause 2 is reach. Clause 3 is a remedy, and only when there is something to
 * remedy: with no agent in the set there is no name that could be put first.
 */
export const composerDeliveryNote = (
  recipients: readonly ComposerRecipient[],
  nameOf: (entity: ComposerRecipient) => string,
): string => {
  const notified = notifiedRecipient(recipients);
  const clauses: string[] = [
    notified === null ? "No agent is notified." : `${nameOf(notified)} is notified.`,
  ];
  const readers = notified === null ? recipients : recipients.slice(1);
  if (recipients.length === 0) {
    clauses.push("Everyone here can read this.");
  } else if (readers.length === 1) {
    clauses.push(`${nameOf(readers[0]!)} can read this and reply.`);
  } else if (readers.length > 1) {
    clauses.push(
      `${readers.length} ${countNoun(readers.length, "recipient")} can read this and reply.`,
    );
  }
  if (notified === null && recipients.some((entity) => entity.kind === "agent")) {
    clauses.push(
      `Only the ${positionWord(NOTIFIED_POSITION)} recipient is notified. ` +
        "Choose a name to put it first.",
    );
  }
  return clauses.join(" ");
};

/** What the chip row says when the set is empty. Broadcast is named, never implied by silence. */
export const BROADCAST_CHIP_LABEL = "Everyone here";

/**
 * The notice when a name cannot join the set, built from the cap.
 *
 * It takes NAMES rather than recipients because a tag can be over the cap in two places and
 * both have to be said. `addComposerRecipients` refuses an entity the set has no room for;
 * `addressFromBody` stops resolving after MENTION_MAX_RECIPIENTS and hands back the rest as
 * bare names, having never turned them into entities. Reading only the first left the second
 * dropping a name out of the message with nothing said about it.
 */
export const composerToFullNotice = (names: readonly string[]): string =>
  `To: holds ${COMPOSER_TO_MAX} ${countNoun(COMPOSER_TO_MAX, "recipient")}, so ${
    joinNames(names)
  } ${names.length === 1 ? "is" : "are"} not in it. Remove one to make room.`;

/**
 * The notice when the roster took somebody out of the set. Their name cannot be part of it:
 * once the roster no longer holds them there is nothing left to read a name from, so this is
 * built from the COUNT. Saying nothing was the alternative, and a chip that disappears while
 * the reader is writing to it is the one thing this row exists to prevent.
 */
export const composerPrunedNotice = (count: number): string =>
  `${count} ${countNoun(count, "recipient")} left this workspace, so ${
    count === 1 ? "it is" : "they are"
  } no longer in To:.`;

/** The notice for a tag that names two roster entries and so cannot become a chip. */
export const composerAmbiguousNotice = (names: readonly string[]): string =>
  `${joinNames(names.map((name) => `"${name}"`))} ${
    names.length === 1 ? "names" : "name"
  } more than one person or agent here, so ${
    names.length === 1 ? "it is" : "they are"
  } not in To:. Rename one of them, or choose the name from the mention list.`;

/**
 * An @tag ADDS to the To: set (ruling D2). It never opens a DM and never replaces the set.
 *
 * `applied` is what keeps a removed chip removed. Without it the next keystroke re-parses the
 * body, finds the tag still there, and puts the chip straight back, so removing a recipient
 * would be impossible while their name stayed in the sentence. A key leaves `applied` when its
 * tag leaves the body, so deleting the tag and typing it again adds the chip again.
 */
export interface MentionMergeInput {
  current: readonly ComposerRecipient[];
  /** Recipients named by tags in the body right now, in the order they appear. */
  tagged: readonly ComposerRecipient[];
  /** Keys already turned into a chip by a tag that is still in the body. */
  applied: readonly string[];
}

export interface MentionMergeResult extends ComposerToChange {
  applied: string[];
}

export const mergeMentionRecipients = (
  input: MentionMergeInput,
): MentionMergeResult => {
  const taggedKeys = new Set(input.tagged.map(recipientKey));
  /* Keys whose tag is gone are forgotten, so retyping the tag adds the chip again. */
  const applied = new Set(input.applied.filter((key) => taggedKeys.has(key)));
  const fresh = input.tagged.filter((entity) => !applied.has(recipientKey(entity)));
  const change = addComposerRecipients(input.current, fresh);
  /* A refused tag is remembered too. Leaving it out would re-report the same full-set notice
   * on every keystroke, which reads as the composer arguing with the reader. */
  for (const entity of fresh) applied.add(recipientKey(entity));
  return { ...change, applied: [...applied] };
};
