export interface RailMember {
  userId: string;
  name: string;
  role: "owner" | "admin" | "member";
}

export interface RailAgent {
  principalId: string;
  name: string;
  ownerUserId: string;
}

export type ParticipantGroup<TMember extends RailMember, TAgent extends RailAgent> =
  | { kind: "member"; member: TMember; agents: TAgent[] }
  | { kind: "unresolved"; label: "Owner unavailable"; agents: TAgent[] };

/** Keeps every workspace member and agent visible while making ownership structural. */
export const groupParticipantsByOwner = <
  TMember extends RailMember,
  TAgent extends RailAgent,
>(members: TMember[], agents: TAgent[]): ParticipantGroup<TMember, TAgent>[] => {
  const memberIds = new Set(members.map((member) => member.userId));
  const groups: ParticipantGroup<TMember, TAgent>[] = members.map((member) => ({
    kind: "member",
    member,
    agents: agents.filter((agent) => agent.ownerUserId === member.userId),
  }));
  const unresolved = agents.filter((agent) => !memberIds.has(agent.ownerUserId));
  if (unresolved.length > 0) {
    groups.push({ kind: "unresolved", label: "Owner unavailable", agents: unresolved });
  }
  return groups;
};
