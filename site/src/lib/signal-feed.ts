import type { Signal } from "./commonswarm";

export type SignalFilter = "all" | "broadcast" | "direct-to-you";

type AddressedSignal = Pick<Signal, "to" | "toAgent">;
type AgentOwner = { ownerUserId: string };

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

/** Apply the visible feed filters to signals already loaded in the browser. */
export const filterSignals = <T extends AddressedSignal>(
  signals: readonly T[],
  filter: SignalFilter,
  viewerId: string,
  agentById: ReadonlyMap<string, AgentOwner>,
): T[] => signals.filter((signal) => {
  if (filter === "broadcast") return signalIsBroadcast(signal);
  if (filter === "direct-to-you") {
    return signalIsDirectToViewer(signal, viewerId);
  }
  return true;
});
