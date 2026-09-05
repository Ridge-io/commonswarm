/**
 * Thread replies, browser side: who may start a thread, and every sentence the composer's
 * reply bar says.
 *
 * A thread reply is the one message this app posts that carries NO recipient. The server is
 * explicit about it (`chatSignalShapeProblem`: "A thread reply is readable by everyone who
 * can read its thread, so it cannot also be addressed to a recipient."), and the reason is
 * the disclosure arm in `resolveThreadRoot`: a reply is undirected and readable by everyone
 * who can read the thread, so a thread hung off a DIRECTED message would advertise that the
 * private message exists.
 *
 * EVERY RULE HERE IS THE SERVER'S, READ RATHER THAN RESTATED. `resolveThreadRoot`
 * (`supabase/functions/command/index.ts`) is the enforcement; this module is the affordance,
 * so a drift between the two shows up as the server's own refusal and never as a message
 * posted somewhere the reader did not mean. The one number that is mirrored rather than
 * imported is the liveness margin, and `signal-feed-threads.test.mjs` reads it back out of
 * the edge's SQL so the mirror cannot go quiet.
 */
import { ALL_SIGNALS_SLUG, channelLabel } from "./channels.js";

/**
 * The margin `resolveThreadRoot` requires between a root's `until` and the moment the reply
 * is written: `AND s.until > statement_timestamp() + interval '1 second'`.
 *
 * It exists because the reply's horizon is clamped to the root's in SQL and
 * `CHECK (until > created_at)` would fire if the root expired between the SELECT and the
 * INSERT. The browser reads it for the same reason it reads any other server bound: to stop
 * offering a control the server will refuse. It cannot be imported — it is a SQL interval
 * literal inside a tagged template, not an exported constant — so the control on it is a
 * source read of that exact line, in `signal-feed-threads.test.mjs`.
 */
export const THREAD_ROOT_LIVE_MARGIN_MS = 1_000;

/**
 * Why a message cannot be the root of a thread. Every arm of `resolveThreadRoot`'s WHERE
 * clause, plus the archive check that follows it, and nothing else.
 *
 * The array is the enumeration; the classifier below returns one of its members and
 * `threadRootBlockText` answers for every one of them. A fifth rule on the server has to
 * appear here, in the classifier and in the sentence table at once, which is the shape
 * AGENTS.md asks for and the shape a typed list does not have.
 */
export const THREAD_ROOT_BLOCKS = [
  "directed",
  "already-a-reply",
  "expiring",
  "channel-archived",
] as const;

export type ThreadRootBlock = typeof THREAD_ROOT_BLOCKS[number];

/** The fields of a loaded row that decide whether a thread may start from it. */
export interface ThreadRootRow {
  to: string | null;
  toAgent: string | null;
  threadRootId: string | null;
  until: string | null;
}

/**
 * What stops a thread starting here, or `null` when nothing does.
 *
 * ORDER MATTERS AND FOLLOWS THE SERVER'S. `resolveThreadRoot` answers 404
 * `thread_root_not_found` for the three WHERE arms together — directed, already a reply, and
 * not live — deliberately, so the refusal is not an oracle for which ids exist. It then
 * checks the archive separately, with its own 409. The order below is that order, so the
 * sentence a reader meets names the rule the server would have named.
 *
 * `channelArchived` is an argument rather than a field because the row does not carry it:
 * the browser learns it from `swarm_read.channels`, which is a different read. Passing it in
 * keeps this function pure and keeps the caller honest about where the answer came from.
 */
export const threadRootBlock = (
  signal: ThreadRootRow,
  now: number,
  channelArchived: boolean,
): ThreadRootBlock | null => {
  /* An `in_reply_to` row is stored DIRECTED — `resolveSignalWriteTarget` re-addresses it to
   * the referenced signal's author — so this one test covers the server's `to_user_id`,
   * `to_agent_principal_id` AND `in_reply_to` arms. The browser's `Signal` carries no
   * `in_reply_to` field, and it does not need one: there is no row that is undirected here
   * and directed there. The server asserts all three anyway, which is where the property is
   * enforced; this is the affordance that follows it. */
  if (signal.to !== null || signal.toAgent !== null) return "directed";
  if (signal.threadRootId !== null) return "already-a-reply";
  if (signal.until !== null) {
    const until = new Date(signal.until).getTime();
    /* A row whose `until` does not parse is left alone rather than called expired: the feed
     * already drops rows it can read as expired, and inventing an expiry from an unreadable
     * value would take a control off a message that is still there. */
    if (Number.isFinite(until) && until <= now + THREAD_ROOT_LIVE_MARGIN_MS) return "expiring";
  }
  if (channelArchived) return "channel-archived";
  return null;
};

/** Sugar for the one question the feed asks of every row it draws. */
export const canStartThread = (
  signal: ThreadRootRow,
  now: number,
  channelArchived: boolean,
): boolean => threadRootBlock(signal, now, channelArchived) === null;

/**
 * What the composer says when a reply cannot be sent after all.
 *
 * Every one of these is reachable WITHOUT a server round trip, because the reply bar is
 * opened against a row and sent later: the root can expire while the reply is being written,
 * and its channel can be archived by somebody else in the same window. The sentence names
 * the rule and says what is still possible, so the reader is not left guessing which of the
 * four applies.
 */
const THREAD_ROOT_BLOCK_TEXT: Readonly<Record<ThreadRootBlock, string>> = {
  directed:
    "That message is addressed to one recipient, so a thread cannot start from it. A reply in a thread is read by everyone, and this message is not.",
  "already-a-reply":
    "That message is already a reply in a thread. Reply to the message the thread starts from.",
  expiring:
    "That message has expired, so its thread is closed. A reply cannot outlive the message its thread starts from.",
  "channel-archived":
    "That thread is in an archived channel, so it takes no new replies. Its history still reads and its links still resolve.",
};

/** The sentence for one block, so no caller writes its own. */
export const threadRootBlockText = (block: ThreadRootBlock): string =>
  THREAD_ROOT_BLOCK_TEXT[block];

/** The label on the control that opens a reply. */
export const THREAD_REPLY_CONTROL_LABEL = "Reply in thread";

/** The label on the control that closes one. */
export const THREAD_REPLY_CANCEL_LABEL = "Cancel reply";

/** The message a reply in progress belongs to, as the composer holds it. */
export interface ThreadReplyRoot {
  id: string;
  /** Whoever wrote the root, already resolved to a name by the caller. */
  author: string;
  /**
   * The channel the root is filed in, captured when the reply was opened. `null` is unfiled,
   * which reads in all-signals. A signal is immutable, so this cannot go stale: the SLUG can
   * be renamed, which is why the composer redraws the bar from the live channel list and
   * only the id is held here.
   */
  channelId: string | null;
  /** The root's expiry, or `null` when it does not expire. The ceiling the server clamps to. */
  until: string | null;
}

/**
 * WHERE THE REPLY GOES, named the way the rest of the app names a place.
 *
 * A thread reply is filed in its ROOT's channel by the server — the client may not file it
 * anywhere else, and the edge refuses a body that names a channel alongside a thread root.
 * So the bar states the channel rather than offering one, and it takes the SLUG from the
 * live channel list so a rename between opening a reply and sending it is reflected instead
 * of frozen. An unfiled thread is named `#all-signals`, from the same constant the head and
 * the rail use.
 */
export const threadReplyPlaceLabel = (slug: string | null): string =>
  channelLabel(slug ?? ALL_SIGNALS_SLUG);

/**
 * The bar's first sentence: who is being answered, and where the reply lands.
 *
 * The task this lane was given asks the bar to name the root and the channel it is in, and
 * both are in one sentence rather than two lines, because they are one fact: this reply
 * belongs to that message, which lives there.
 */
export const threadReplyTargetText = (
  author: string,
  slug: string | null,
): string => `Replying to ${author} in ${threadReplyPlaceLabel(slug)}.`;

/**
 * The bar's second sentence: the reach, stated rather than implied.
 *
 * TRUE OF BOTH SURFACES. A thread reply is undirected, so `swarm.enqueue_signal_delivery`
 * writes no `swarm.signal_deliveries` row for it and nothing is woken — not an agent in the
 * hosted workspace, and not a local listener, which reads the same delivery rows. The
 * p1-server suite measures the general form of that claim ("a channel post wakes nobody").
 */
export const THREAD_REPLY_REACH_TEXT =
  "Everyone who can read the thread can read this reply. It notifies nobody.";

/**
 * WHAT THE To: ROW SHOWS AS THE ADDRESS OF A REPLY.
 *
 * The row is not hidden and it does not go blank: an empty address row reads as a bug, and the
 * broadcast label is wrong here because it names the WORKSPACE while a reply's reach is the
 * thread. So the address is named, the way a broadcast is named, and the sentence under it says
 * what that means.
 *
 * It matters that this is a LABEL for an empty set and not a recipient. The row draws
 * `composerSendRecipients` in every state — a mutation proved that an early return for the
 * reply case made "the row draws what the send posts" true by accident, because two separate
 * rules both happened to produce nothing — so if that derivation ever stopped returning an
 * empty set, chips would appear here and the browser control would see them.
 */
export const THREAD_REPLY_CHIP_LABEL = "This thread";

/**
 * What the To: row says while a reply is being written.
 *
 * It says the reply has no recipients, which is the fact, and it is the same row in the same
 * place so the reader does not have to learn a second one.
 */
export const THREAD_REPLY_TO_TEXT =
  "A thread reply has no recipients. " + THREAD_REPLY_REACH_TEXT;

/**
 * The ceiling the server clamps to, when there is one.
 *
 * §6 P4 of the reconciled design requires the composer to show it: the remaining window can
 * be milliseconds, and a reader must not write a considered reply into a thread that expires
 * while they are reading. The relative time is formatted by the caller — the dashboard
 * already has one formatter and a second one here would be the drift this file exists to
 * avoid — and a root with no expiry produces no sentence rather than an empty one.
 */
export const threadReplyWindowText = (relativeUntil: string | null): string =>
  relativeUntil === null
    ? ""
    : `This thread ends ${relativeUntil}, and a reply cannot outlive it.`;

/**
 * WHETHER THE BROADCAST CONTROL IS OFFERED AT ALL.
 *
 * `broadcast_to_channel` says "send this thread reply to the channel as well". A thread whose
 * root is UNFILED has no channel to send it to: the edge stores the flag as true and leaves
 * `channel_id` null, so the request is accepted and does nothing. The CLI met exactly this —
 * a review arm found `--broadcast-to-channel` printing "sent to the thread's channel as well"
 * with no channel in the row (`threadReplyMessage`, `src/cli.ts`) — and the browser answers
 * it one step earlier, by not offering a control that cannot do anything.
 */
export const threadReplyMayBroadcast = (slug: string | null): boolean => slug !== null;

/**
 * The label on that control, which names the channel it would send to.
 *
 * It takes the slug rather than a boolean so the label cannot be rendered for a thread that
 * has nowhere to broadcast: there is no wording for that case, because the control is absent.
 */
export const threadReplyBroadcastLabel = (slug: string): string =>
  `Also post this reply in ${channelLabel(slug)}`;

/** "1 reply" / "N replies", so no caller retypes the plural. */
export const threadReplyCountLabel = (count: number): string =>
  `${count} ${count === 1 ? "reply" : "replies"}`;
