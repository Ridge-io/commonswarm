import type { Signal } from "./commonswarm";

export type SignalFilter = "all" | "broadcast" | "direct-to-you";

type AddressedSignal = Pick<Signal, "to" | "toAgent">;
type AgentOwner = { ownerUserId: string };

/** Keep broadcast classification in one executable rule shared by counts and filters. */
export const signalIsBroadcast = (signal: AddressedSignal): boolean =>
  signal.to === null && signal.toAgent === null;

/** A direct row belongs to the viewer when it targets them or an agent they operate. */
export const signalIsDirectToViewer = (
  signal: AddressedSignal,
  viewerId: string,
  agentById: ReadonlyMap<string, AgentOwner>,
): boolean => {
  if (!viewerId) return false;
  if (signal.to === viewerId) return true;
  if (signal.toAgent === null) return false;
  return agentById.get(signal.toAgent)?.ownerUserId === viewerId;
};

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
    return signalIsDirectToViewer(signal, viewerId, agentById);
  }
  return true;
});
