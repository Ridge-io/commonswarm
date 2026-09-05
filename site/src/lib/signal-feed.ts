import type { Signal } from "./commonswarm";

export type SignalFilter = "all" | "broadcast" | "direct-to-you";

type AddressedSignal = Pick<Signal, "to" | "toAgent">;

/** Keep broadcast classification in one executable rule shared by counts and filters. */
export const signalIsBroadcast = (signal: AddressedSignal): boolean =>
  signal.to === null && signal.toAgent === null;

/* ~~"targets them or an agent they operate"~~ Dead 2026-09-01, by operator report:
 * in a solo-owner workspace the operator operates nearly every agent, so the
 * operated-agent clause made "Direct to you" degenerate into ALL directed
 * traffic. Direct to you means to YOU the person, nothing else. */
export const signalIsDirectToViewer = (
  signal: AddressedSignal,
  viewerId: string,
): boolean => viewerId !== "" && signal.to === viewerId;

/** Derive truthful loaded-page counts without implying a server-wide total. */
export const signalCounts = (signals: readonly AddressedSignal[]) => {
  const broadcastCount = signals.filter(signalIsBroadcast).length;
  return { broadcastCount, directCount: signals.length - broadcastCount };
};

/* ~~`agentById: ReadonlyMap<string, AgentOwner>`~~ Dead 2026-09-01: the fourth
 * parameter fed the operated-agent clause retired above and was never read after
 * it. A signature that still took it told the next reader the filter consults
 * agent ownership. It does not; the parameter and its type are gone. */
/** Apply the visible feed filters to signals already loaded in the browser. */
export const filterSignals = <T extends AddressedSignal>(
  signals: readonly T[],
  filter: SignalFilter,
  viewerId: string,
): T[] => signals.filter((signal) => {
  if (filter === "broadcast") return signalIsBroadcast(signal);
  if (filter === "direct-to-you") {
    return signalIsDirectToViewer(signal, viewerId);
  }
  return true;
});

/* ~~"Thread grouping is NOT in this lane"~~ Retired 2026-09-05 by `lane/chat-app-threads`,
 * which is where the cut sent it. `groupSignalThreads` is back below;
 * `threadReplyCountLabel` went to `thread-reply.ts` with the rest of the thread copy, so the
 * count and the sentences around it are read from one place. While the surface was cut, a
 * reply rendered inline in the flat feed, interleaved by time — the behaviour the design
 * states for a client that does not know about threads, and still what an OLD client shows.
 */

type ThreadSignal = Pick<Signal, "id" | "threadRootId">;

export interface ThreadGroup<T> {
  root: T;
  replies: T[];
}

/**
 * Collapse thread replies under the message their thread starts from.
 *
 * The input order is the DISPLAY order, and it is kept: a root holds the place
 * of its first appearance, and its replies come back in the order they were
 * given. A reply whose root is not in the loaded page is returned as a row of
 * its own rather than dropped — an expired or not-yet-paged root must never
 * take a visible message off the screen with it.
 */
export const groupSignalThreads = <T extends ThreadSignal>(
  signals: readonly T[],
): ThreadGroup<T>[] => {
  const rootIds = new Set(
    signals
      .filter((signal) => signal.threadRootId === null)
      .map((signal) => signal.id),
  );
  const isOwnRow = (signal: T): boolean =>
    signal.threadRootId === null || !rootIds.has(signal.threadRootId);
  const groups: ThreadGroup<T>[] = [];
  const byRootId = new Map<string, ThreadGroup<T>>();
  /* Pass one places every row that stands on its own, IN INPUT ORDER, so an
   * orphan reply keeps its place in the transcript instead of being appended
   * after the rows it was written between. Pass two attaches the rest. A single
   * pass that looked a root up as it met each reply would also assume every
   * root precedes its replies, which is true of the oldest-first display order
   * and not of the newest-first order the feed keeps for pagination. */
  for (const signal of signals) {
    if (!isOwnRow(signal)) continue;
    const group: ThreadGroup<T> = { root: signal, replies: [] };
    groups.push(group);
    if (signal.threadRootId === null) byRootId.set(signal.id, group);
  }
  for (const signal of signals) {
    if (isOwnRow(signal)) continue;
    byRootId.get(signal.threadRootId!)!.replies.push(signal);
  }
  return groups;
};

/* There is deliberately NO client-side channel filter here. The shipped
 * All / Broadcast / Direct-to-you filter above runs over the loaded page, so it
 * says "your direct signals" and means "among the last 25 loaded". A channel
 * must not copy that: the narrowing is `channel_id=eq.<uuid>` on the query
 * (`LiveDashboard.astro` signalPage), so a reader who opens a channel is
 * reading the newest messages IN it and pages backwards through it. The view's
 * WHERE remains the authorization; a client-issued equality on top of it
 * cannot widen anything.
 *
 * A thread reply is stamped with its root's channel by the server
 * (`resolveThreadRoot` returns the root's `channel_id` and the placement carries
 * it), so a reply needs no resolution through its root to land in the same
 * narrowing as the message it answers. THAT is what makes threads and the
 * channel filter compose: a reply written in #mobile is returned by
 * `channel_id=eq.<mobile>` and by the unfiltered read alike, and
 * `groupSignalThreads` collapses it under its root in whichever of the two the
 * reader is looking at. No client-side resolution, and no second query.
 */
