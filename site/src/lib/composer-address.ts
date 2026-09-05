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

/**
 * THE ADDRESS ONE SEND ACTUALLY CARRIES, asked in one place by the row that draws it and by
 * the submit that posts it.
 *
 * A thread reply carries NO recipient. That is the server's rule and not a preference:
 * `chatSignalShapeProblem` refuses a body that sets `thread_root_id` and any recipient
 * ("A thread reply is readable by everyone who can read its thread, so it cannot also be
 * addressed to a recipient"), because a reply is undirected and a thread hung off a directed
 * message would disclose it.
 *
 * IT IS A DERIVATION AND NEVER A WRITE. The To: pair belongs to the top-level message being
 * composed; a reply does not empty it, overwrite it or store an empty one over it. The pass
 * HOLDS while a reply is in progress, exactly as it holds during a send, so cancelling a
 * reply gives the reader back the chips they had. Emptying the set instead would be a second
 * writer of the pair, which is the class `deriveComposerAddress` exists to remove.
 */
export const composerSendRecipients = (
  to: readonly ComposerRecipient[],
  threadReply: boolean,
): ComposerRecipient[] => (threadReply ? [] : [...to]);

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
 * What a chip's own control does, said from the rule the wake follows rather than typed
 * beside it. Promoting a PERSON does not notify them: it puts a user id in the scalar
 * column, leaves the agent column null, and wakes nobody. A chip that promised otherwise
 * contradicted the sentence underneath it, which is the failure a review arm found.
 */
export const composerPromoteLabel = (
  entity: ComposerRecipient,
  current: readonly ComposerRecipient[],
  nameOf: (candidate: ComposerRecipient) => string,
): string => {
  const name = nameOf(entity);
  const already = notifiedRecipient(current);
  if (already !== null && sameRecipient(already, entity)) return `${name} is notified`;
  /* Ask the same function the row asks, about the set this click would make. */
  const afterPromotion = notifiedRecipient(promoteComposerRecipient(current, entity));
  /* The position word comes from the same index the wake does, like the note under the
   * chips. Typing "first" here while the note generated it was the half of the round-one
   * finding that the kind fix did not cover. */
  const front = positionWord(NOTIFIED_POSITION);
  return afterPromotion !== null && sameRecipient(afterPromotion, entity)
    ? `Put ${name} ${front}, so ${name} is notified`
    : `Put ${name} ${front}. No agent is notified while a person is ${front}`;
};

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
  const refusedKeys = new Set(change.refused.map(recipientKey));
  /* ONLY A NAME THAT GOT IN IS APPLIED.
   *
   * A refused tag used to be marked applied as well, to stop the full-set notice repeating on
   * every keystroke. That made the refusal permanent: the reader deleted a chip to make room
   * and the refused name still did not join, because `applied` had already written it off.
   * Recovery was deleting the tag from the sentence and typing it again, which nothing said.
   *
   * The notice does not need this record any more. It is DERIVED from `refused` on every
   * pass, so the same sentence is rebuilt rather than pushed in once, and a refusal that
   * still stands keeps its sentence without repeating anything. */
  for (const entity of fresh) {
    if (!refusedKeys.has(recipientKey(entity))) applied.add(recipientKey(entity));
  }
  return { ...change, applied: [...applied] };
};

/* ────────────────────────────────────────────────────────────────────────────────────────
 * ONE DERIVED PASS.
 *
 * The To: set and the record of which tags produced it are one pair, and the pair must
 * follow the body. Four review rounds found the same class: the pair was kept in step BY
 * HAND across separate handlers — a draft restore, a workspace switch, a roster paint, a
 * chip edit, a send — and each round closed one door while the next opened another.
 *
 * Everything below is that pair as a function of what is known: the body's tags, the roster,
 * the stored draft, and the set the last message went to. Every handler calls this and
 * assigns what it returns. The rules the handlers used to carry each on their own now live
 * here, in one place, where a control can drive them:
 *
 *  - NOTHING COMMITS UNTIL THE ROSTER IS KNOWN. A workspace switch paints once with an empty
 *    roster; a pass that committed there pruned the draft's set to empty and marked itself
 *    done, and the later paint wrote the last-sent set over it.
 *  - NOTHING COMMITS WHILE THE MESSAGE IS ON THE WIRE. The send captured its recipients
 *    already, so a prune that moved the chips would leave the row showing one set and the
 *    post naming another.
 *  - AN EMPTY SET IS A CHOICE, never a residue. `null` means "no set was recorded"; an empty
 *    ARRAY means "the reader emptied it", and the two do not restore the same way.
 * ──────────────────────────────────────────────────────────────────────────────────────── */

/** Where the set a pass committed came from. The prune sentence follows this. */
export type ComposerAddressSource = "pending" | "live" | "draft" | "remembered";

/** The To: set and the record of which tags produced it, which never travel apart. */
export interface ComposerAddressPair {
  /** The set. `null` is "no set was recorded"; `[]` is a broadcast the reader chose. */
  to: readonly ComposerRecipient[] | null;
  applied: readonly string[];
}

export interface ComposerAddressInput {
  /** False while the roster request has not settled. Nothing commits until it is true. */
  rosterKnown: boolean;
  /** True while this composer's own message is being posted. Nothing commits until it ends. */
  sending: boolean;
  /**
   * True while the composer is writing a THREAD REPLY. Nothing commits until it ends.
   *
   * A reply carries no recipient, so the To: pair is not the address of the message in the
   * box; it is the address of the top-level message the reader was writing before, and it
   * has to come back untouched when the reply is cancelled or sent. Holding is how that is
   * done without a second writer: an @tag typed inside a reply changes nothing, and nothing
   * is stored. What the ROW shows meanwhile is `composerSendRecipients`, which is also what
   * the submit reads, so the row and the wire cannot disagree.
   */
  replying?: boolean;
  /** Is this name still in the workspace. Read only when `rosterKnown`. */
  known: (entity: ComposerRecipient) => boolean;
  /** The pair on screen, or null when no pass has committed one for this workspace yet. */
  live: ComposerAddressPair | null;
  /** The pair saved with the draft, or null when no draft is stored. */
  draft: ComposerAddressPair | null;
  /** The set the last message from here went to. */
  remembered: readonly ComposerRecipient[];
  /** Recipients named by @tags in the body right now, in the order they appear. */
  tagged: readonly ComposerRecipient[];
  /** Prunes already on screen, so a redraw keeps the sentence instead of losing it. */
  announcedPrune?: number;
}

export interface ComposerAddressState {
  recipients: ComposerRecipient[];
  applied: string[];
  source: ComposerAddressSource;
  /** Names the cap has no room for right now, so the sentence is rebuilt rather than kept. */
  refused: ComposerRecipient[];
  /** Recipients the roster took out of a set the reader was already looking at. */
  announcedPrune: number;
  /** False when the pass may not be written down and no restore may be marked done. */
  committed: boolean;
}

export const deriveComposerAddress = (
  input: ComposerAddressInput,
): ComposerAddressState => {
  const held: ComposerAddressState = {
    recipients: [...(input.live?.to ?? [])],
    applied: [...(input.live?.applied ?? [])],
    source: "pending",
    refused: [],
    announcedPrune: input.announcedPrune ?? 0,
    committed: false,
  };
  /* HOLD, do not guess. All three are states where the pair on screen is already right and
   * the inputs are not: an unknown roster would prune every chip, a send in flight has
   * captured recipients this pass cannot reach, and a thread reply is not addressed by this
   * pair at all — deriving one for it would let an @tag inside a reply edit the address of
   * the message the reader goes back to when they cancel. */
  if (!input.rosterKnown || input.sending || input.replying === true) return held;
  /* WHICH SET IS THE BASE. The live pair wins because it is what the reader is looking at.
   * With no live pair this is a cold entry: the draft's set is the message being written and
   * beats the last-sent set, which is only the starting point when no draft recorded one. */
  const chosen = input.live ?? input.draft;
  const recorded = chosen !== null && chosen.to !== null;
  const source: ComposerAddressSource = input.live !== null
    ? "live"
    : recorded
    ? "draft"
    : "remembered";
  const base = recorded ? chosen!.to! : input.remembered;
  const kept = pruneComposerRecipients(base, input.known);
  const removed = base.length - kept.length;
  const merged = mergeMentionRecipients({
    current: kept,
    tagged: input.tagged,
    applied: chosen?.applied ?? [],
  });
  return {
    recipients: merged.recipients,
    applied: merged.applied,
    source,
    refused: merged.refused,
    /* A PRUNE IS ANNOUNCED ONLY WHEN THE READER WAS LOOKING AT THE SET. A chip cannot vanish
     * from under somebody writing to that person, so a live prune is said out loud. A set
     * restored on arrival is pruned in silence: people leave a workspace between messages,
     * and greeting every reader with a notice about a set they have not looked at yet is
     * noise. The source decides that, so no handler has to know which case it is in. */
    announcedPrune: source === "live"
      ? (input.announcedPrune ?? 0) + removed
      : 0,
    committed: true,
  };
};

/**
 * IS THIS SET A CHOICE, or merely what a fresh derivation would produce?
 *
 * Only a chosen address is worth storing as a draft. The question is NOT "does it differ from
 * the last-sent set": a set that arrival PRUNED differs from it too, and writing that down
 * turned a silent prune into a decision. A member who left and came back stayed out, because
 * the stored draft answered on arrival before the remembered set could.
 *
 * So the comparison is against the set arrival would build: the remembered one, pruned. What
 * survives that comparison is something the reader did — a chip removed, a name promoted, a
 * tag lifted in, or To: emptied to a broadcast.
 */
export const composerAddressIsChosen = (
  recipients: readonly ComposerRecipient[],
  remembered: readonly ComposerRecipient[],
  known: (entity: ComposerRecipient) => boolean,
): boolean => {
  const key = (set: readonly ComposerRecipient[]): string => set.map(recipientKey).join("+");
  return key(recipients) !== key(pruneComposerRecipients(remembered, known));
};

/**
 * Everything the row has to say about names it could not honour, built from one pass's own
 * result. Every clause is generated: the cap sentence from the cap, the prune sentence from
 * the count, the ambiguity sentence from the names the parser could not separate.
 */
export const composerAddressNotice = (
  state: Pick<ComposerAddressState, "refused" | "announcedPrune">,
  parsed: { overflow: readonly string[]; ambiguous: readonly string[] },
  nameOf: (entity: ComposerRecipient) => string,
): string => {
  const clauses: string[] = [];
  /* BOTH WAYS A TAG CAN BE OVER THE CAP. `refused` is the To: set having no room for a name
   * it did resolve; `overflow` is the parser stopping at its own ceiling with bare names it
   * never resolved. Reading only one dropped a name out of the message with nothing said. */
  const overCap = [...state.refused.map(nameOf), ...parsed.overflow];
  if (overCap.length > 0) clauses.push(composerToFullNotice(overCap));
  if (parsed.ambiguous.length > 0) clauses.push(composerAmbiguousNotice(parsed.ambiguous));
  if (state.announcedPrune > 0) clauses.push(composerPrunedNotice(state.announcedPrune));
  return clauses.join(" ");
};
