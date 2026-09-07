/**
 * Display names are labels. Principal and member UUIDs are the identity.
 *
 * Duplicate names stay selectable through a short UUID suffix. A generated
 * suffix must be unique across every raw name and every other generated label.
 * On collision the prefix grows, then the full UUID. A name-only lookup
 * resolves only when it is unique. It never takes the first match.
 */

export const IDENTITY_LABEL_SEPARATOR = " · ";
export const IDENTITY_UUID_SUFFIX_MIN = 8;
export const ALLOW_DUPLICATE_NAME_FIELD = "allow_duplicate_name";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isIdentityUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function foldIdentityName(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export interface IdentityRecord {
  id: string;
  name: string;
}

export function identityNameIsShared(
  name: string,
  roster: readonly IdentityRecord[],
): boolean {
  const folded = foldIdentityName(name);
  let count = 0;
  for (const row of roster) {
    if (foldIdentityName(row.name) === folded) {
      count += 1;
      if (count > 1) return true;
    }
  }
  return false;
}

export function identityUuidSuffix(
  id: string,
  roster: readonly IdentityRecord[] = [],
): string {
  const normalized = id.toLowerCase();
  const others = roster
    .map((row) => row.id.toLowerCase())
    .filter((other) => other !== normalized);
  for (let size = IDENTITY_UUID_SUFFIX_MIN; size <= normalized.length; size += 1) {
    const suffix = normalized.slice(0, size);
    if (!others.some((other) => other.slice(0, size) === suffix)) return suffix;
  }
  return normalized;
}

function shownIdentityName(record: IdentityRecord): string {
  const trimmed = record.name.trim();
  return trimmed.length > 0 ? trimmed : record.id;
}

function suffixedIdentityLabel(
  shown: string,
  id: string,
  roster: readonly IdentityRecord[],
  taken: ReadonlySet<string>,
): string {
  const normalized = id.toLowerCase();
  const others = roster
    .map((row) => row.id.toLowerCase())
    .filter((other) => other !== normalized);
  for (let size = IDENTITY_UUID_SUFFIX_MIN; size <= normalized.length; size += 1) {
    const suffix = normalized.slice(0, size);
    if (others.some((other) => other.slice(0, size) === suffix)) continue;
    const candidate = `${shown}${IDENTITY_LABEL_SEPARATOR}${suffix}`;
    if (taken.has(foldIdentityName(candidate))) continue;
    return candidate;
  }
  return `${shown}${IDENTITY_LABEL_SEPARATOR}${normalized}`;
}

/**
 * One label per roster row, in roster order. Unique raw names stay bare.
 * Shared names get a UUID suffix that does not collide with any raw name
 * or any earlier generated label.
 */
export function identityDisplayLabels(
  roster: readonly IdentityRecord[],
): string[] {
  const shown = roster.map(shownIdentityName);
  const taken = new Set(shown.map((label) => foldIdentityName(label)));
  const labels = shown.slice();
  for (let index = 0; index < roster.length; index += 1) {
    const record = roster[index]!;
    if (!identityNameIsShared(record.name, roster)) continue;
    const chosen = suffixedIdentityLabel(shown[index]!, record.id, roster, taken);
    labels[index] = chosen;
    taken.add(foldIdentityName(chosen));
  }
  return labels;
}

export function identityDisplayLabel(
  record: IdentityRecord,
  roster: readonly IdentityRecord[],
): string {
  const rows = roster.some((row) => row.id === record.id)
    ? roster
    : [...roster, record];
  const labels = identityDisplayLabels(rows);
  const index = rows.findIndex((row) => row.id === record.id);
  return index >= 0 ? labels[index]! : shownIdentityName(record);
}

export type NameLookup =
  | { status: "unique"; id: string }
  | { status: "ambiguous"; name: string }
  | { status: "missing"; name: string };

export function lookupByDisplayName(
  name: string,
  roster: readonly IdentityRecord[],
): NameLookup {
  const folded = foldIdentityName(name);
  const matches = roster.filter((row) => foldIdentityName(row.name) === folded);
  if (matches.length === 1) return { status: "unique", id: matches[0]!.id };
  if (matches.length > 1) return { status: "ambiguous", name };
  return { status: "missing", name };
}

export interface StoredIdentityRef {
  kind: "agent" | "person";
  id?: string;
  name?: string;
}

export type ResolvedIdentityRef =
  | { status: "resolved"; kind: "agent" | "person"; id: string }
  | { status: "ambiguous"; kind: "agent" | "person"; name: string }
  | { status: "invalid" };

export function parseStoredIdentityRef(entry: unknown): StoredIdentityRef | null {
  if (entry === null || typeof entry !== "object") return null;
  const candidate = entry as { kind?: unknown; id?: unknown; name?: unknown };
  if (candidate.kind !== "agent" && candidate.kind !== "person") return null;
  const id = typeof candidate.id === "string" ? candidate.id : undefined;
  const name = typeof candidate.name === "string" ? candidate.name : undefined;
  if (id === undefined && name === undefined) return null;
  return {
    kind: candidate.kind,
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
  };
}

export function resolveStoredIdentityRef(
  stored: StoredIdentityRef,
  roster: {
    agents: readonly IdentityRecord[];
    members: readonly IdentityRecord[];
  },
): ResolvedIdentityRef {
  const table = stored.kind === "agent" ? roster.agents : roster.members;
  if (typeof stored.id === "string" && stored.id.length > 0) {
    const found = table.find((row) =>
      row.id === stored.id || row.id.toLowerCase() === stored.id!.toLowerCase()
    );
    if (found) {
      return { status: "resolved", kind: stored.kind, id: found.id };
    }
    if (isIdentityUuid(stored.id)) {
      return { status: "resolved", kind: stored.kind, id: stored.id };
    }
  }
  const name = typeof stored.name === "string"
    ? stored.name
    : typeof stored.id === "string"
    ? stored.id
    : "";
  if (foldIdentityName(name).trim() === "") return { status: "invalid" };
  const lookup = lookupByDisplayName(name, table);
  if (lookup.status === "unique") {
    return { status: "resolved", kind: stored.kind, id: lookup.id };
  }
  if (lookup.status === "ambiguous") {
    return { status: "ambiguous", kind: stored.kind, name };
  }
  return { status: "invalid" };
}

export function resolveStoredIdentityRefs(
  stored: readonly StoredIdentityRef[],
  roster: {
    agents: readonly IdentityRecord[];
    members: readonly IdentityRecord[];
  },
): {
  recipients: Array<{ kind: "agent" | "person"; id: string }>;
  ambiguous: string[];
} {
  const recipients: Array<{ kind: "agent" | "person"; id: string }> = [];
  const ambiguous: string[] = [];
  const seen = new Set<string>();
  for (const entry of stored) {
    const resolved = resolveStoredIdentityRef(entry, roster);
    if (resolved.status === "ambiguous") {
      if (!ambiguous.includes(resolved.name)) ambiguous.push(resolved.name);
      continue;
    }
    if (resolved.status !== "resolved") continue;
    const key = `${resolved.kind}:${resolved.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push({ kind: resolved.kind, id: resolved.id });
  }
  return { recipients, ambiguous };
}

export function createAgentPrincipalCommand(
  name: string,
  model?: string,
  allowDuplicateName = false,
): Record<string, unknown> {
  const command = model === undefined
    ? { kind: "create_agent_principal" as const, name }
    : { kind: "create_agent_principal" as const, name, model };
  if (allowDuplicateName === true) {
    return { ...command, [ALLOW_DUPLICATE_NAME_FIELD]: true };
  }
  return command;
}
