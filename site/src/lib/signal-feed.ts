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

/* Thread grouping is NOT in this lane. `groupSignalThreads` and `threadReplyCountLabel`
 * were written here and are cut to `lane/chat-app-threads` with the surface that used them:
 * until it ships, a reply renders inline in the flat feed, interleaved by time, which is what
 * the design already states for a client that does not know about threads.
 */

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
 * (`command/index.ts:7827`), so a reply needs no resolution through its root to
 * land in the same narrowing as the message it answers.
 */
