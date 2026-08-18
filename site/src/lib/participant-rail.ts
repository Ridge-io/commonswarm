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

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareMembers = <TMember extends RailMember>(left: TMember, right: TMember): number =>
  compareText(left.name.toLowerCase(), right.name.toLowerCase()) ||
  compareText(left.userId, right.userId);

const compareAgents = <TAgent extends RailAgent>(left: TAgent, right: TAgent): number =>
  compareText(left.name, right.name) || compareText(left.principalId, right.principalId);

/** Keeps every workspace member and agent visible while making ownership structural. */
export const groupParticipantsByOwner = <
  TMember extends RailMember,
  TAgent extends RailAgent,
>(members: TMember[], agents: TAgent[]): ParticipantGroup<TMember, TAgent>[] => {
  const memberIds = new Set(members.map((member) => member.userId));
  const groups: ParticipantGroup<TMember, TAgent>[] = [...members]
    .sort(compareMembers)
    .map((member) => ({
      kind: "member",
      member,
      agents: agents
        .filter((agent) => agent.ownerUserId === member.userId)
        .sort(compareAgents),
    }));
  const unresolved = agents
    .filter((agent) => !memberIds.has(agent.ownerUserId))
    .sort(compareAgents);
  if (unresolved.length > 0) {
    groups.push({ kind: "unresolved", label: "Owner unavailable", agents: unresolved });
  }
  return groups;
};
