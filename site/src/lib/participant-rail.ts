import { modelFamily, modelGlyphSvg } from './model-glyph.js';

export interface RailMember {
  userId: string;
  name: string;
  role: "owner" | "admin" | "member";
}

export interface RailAgent {
  principalId: string;
  name: string;
  ownerUserId: string;
  model?: string | null;
}

export interface RosterAgent extends RailAgent {
  model: string | null;
}

export interface RosterAgentRow {
  principal_id?: unknown;
  name?: unknown;
  model?: unknown;
  owner_user_id?: unknown;
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

/** Normalizes roster rows without discarding agents whose owner cannot be resolved. */
export const rosterAgentsFromRows = (rows: RosterAgentRow[]): RosterAgent[] =>
  rows
    .map((row) => ({
      principalId: String(row.principal_id ?? ''),
      name: String(row.name ?? 'Unnamed agent'),
      model: row.model == null ? null : String(row.model),
      ownerUserId: String(row.owner_user_id ?? ''),
    }))
    .filter((agent) => agent.principalId.length > 0);

/** Renders the participant rail used by the live dashboard and its DOM observers. */
export const renderSidebarParticipants = <
  TMember extends RailMember,
  TAgent extends RailAgent,
>(
  participantList: HTMLUListElement,
  members: TMember[],
  agents: TAgent[],
  initials: (name: string) => string,
): void => {
  const document = participantList.ownerDocument;
  participantList.replaceChildren();

  const buildAgentRow = (agent: TAgent, ownerName?: string): HTMLLIElement => {
    const row = document.createElement('li');
    row.className = 'dashboard__sidebar-agent';
    const modelMark = document.createElement('span');
    modelMark.className = 'dashboard__sidebar-model-mark';
    modelMark.innerHTML = modelGlyphSvg(
      modelFamily(agent.model),
      'dashboard__sidebar-model-glyph',
    );
    const copy = document.createElement('span');
    copy.className = 'dashboard__sidebar-participant-copy';
    const name = document.createElement('strong');
    name.textContent = agent.name;
    name.title = agent.name;
    copy.append(name);
    if (agent.model) {
      const model = document.createElement('span');
      model.textContent = agent.model;
      copy.append(model);
    }
    if (ownerName) {
      const owner = document.createElement('span');
      owner.className = 'dashboard__sidebar-orphan-owner';
      owner.textContent = `operated by ${ownerName}`;
      copy.append(owner);
    }
    row.append(modelMark, copy);
    return row;
  };

  for (const group of groupParticipantsByOwner(members, agents)) {
    const groupItem = document.createElement('li');
    groupItem.className = 'dashboard__sidebar-owner-group';
    const personRow = document.createElement('div');
    personRow.className = group.kind === 'member'
      ? 'dashboard__sidebar-person'
      : 'dashboard__sidebar-person dashboard__sidebar-person--unresolved';

    if (group.kind === 'member') {
      const avatarWrap = document.createElement('span');
      avatarWrap.className = 'dashboard__sidebar-avatar-wrap';
      const avatar = document.createElement('span');
      avatar.className = 'dashboard__sidebar-person-avatar';
      avatar.textContent = initials(group.member.name);
      avatar.setAttribute('aria-hidden', 'true');
      const presence = document.createElement('span');
      presence.className = 'dashboard__presence-dot';
      presence.setAttribute('aria-hidden', 'true');
      avatarWrap.append(avatar, presence);
      const copy = document.createElement('span');
      copy.className = 'dashboard__sidebar-participant-copy';
      const name = document.createElement('strong');
      name.textContent = group.member.name;
      name.title = group.member.name;
      const meta = document.createElement('span');
      meta.textContent = group.member.role;
      copy.append(name, meta);
      personRow.append(avatarWrap, copy);
    } else {
      const marker = document.createElement('span');
      marker.className = 'dashboard__sidebar-unresolved-mark';
      marker.textContent = '?';
      marker.setAttribute('aria-hidden', 'true');
      const label = document.createElement('strong');
      label.textContent = group.label;
      personRow.append(marker, label);
    }
    groupItem.append(personRow);
    if (group.agents.length > 0) {
      const nestedAgents = document.createElement('ul');
      nestedAgents.className = 'dashboard__sidebar-owner-agents';
      for (const agent of group.agents) {
        nestedAgents.append(buildAgentRow(
          agent,
          group.kind === 'unresolved' ? group.label : undefined,
        ));
      }
      groupItem.append(nestedAgents);
    }
    participantList.append(groupItem);
  }
};
