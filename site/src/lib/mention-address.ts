/**
 * AN @TAG READS A NAME OUT OF A SENTENCE. What the composer then does with that name lives in
 * `composer-address.ts`: the tag ADDS the person or agent to the To: set (ruling D2), it does
 * not open a DM and it does not replace whoever is already there.
 *
 * RETIRED 2026-09-05: "THE ADDRESS IS THE MESSAGE ... the send posts one signal per tag because
 * the wire carries a single recipient per signal." The wire learned a recipient list on
 * 2026-09-05 (`SIGNAL_RECIPIENT_MAX` in `_shared/channels.ts`), so one message now carries the
 * whole set. A reader who meets the old wording somewhere else should read this instead.
 *
 * This lives outside the dashboard component so it can be tested directly. Every rule below was
 * written against a defect a review arm found in the first version, and each has a test:
 * longest-name-first, boundary characters, case folding that changes a string's LENGTH,
 * two roster entries sharing a name, and more tags than one message may carry.
 */
import { COMPOSER_TO_MAX } from "./composer-address.js";
import {
  foldIdentityName,
  identityDisplayLabel,
  type IdentityRecord,
} from "./identity-label.js";

export interface MentionEntity {
  id: string;
  kind: "agent" | "person";
}

export interface MentionTarget {
  entity: MentionEntity;
  /** Raw display name. A name-only tag uses this, and refuses when it is shared. */
  name: string;
  /** Picker and tag label. Duplicate names include a short UUID suffix. */
  label?: string;
}

export interface MentionAddress {
  /** Names shared by two roster entries. A tag on one of these cannot be resolved. */
  ambiguous: string[];
  /** Tags past the cap. They are named rather than dropped in silence. */
  overflow: string[];
  recipients: MentionEntity[];
}

/**
 * A ceiling on one message, and the SAME number the server refuses above. It is imported
 * rather than typed: a tag costs a row in `swarm.signal_recipients` now, not a whole signal,
 * so the parser must stop exactly where the To: set does.
 */
export const MENTION_MAX_RECIPIENTS = COMPOSER_TO_MAX;

/** What may sit in front of an @ for it to start a tag. */
const OPENS_TAG = /\s|[([]/u;

/** What may sit after a name for the tag to end there. */
const CLOSES_TAG = /[\s.,;:!?)\]]/u;

/* Decompose, drop the combining marks, then lower-case. Plain `toLowerCase` is not enough:
 * "İ" folds to TWO code units, so "@ipek" never matched a roster name of "İpek". Stripping marks
 * makes a tag forgiving about accents, and the same fold decides ambiguity below, so two names
 * that differ only by an accent are treated as the same name rather than silently colliding. */
const fold = (value: string): string => foldIdentityName(value);

/* A name has to survive folding as something a reader could type after an "@". Only combining
 * marks fold to "", and only whitespace folds to whitespace; both used to bind — the first on the
 * empty span after a dangling "@", the second on "@ ". Checked in BOTH entry points, because
 * addressFromBody is called with target lists this module did not build. */
export function isTaggable(name: string): boolean {
  return fold(name).trim() !== "";
}

/**
 * Longest name first, so "@Dana Rivera" is never read as "@Dana" plus stray text.
 * Entries without a name cannot be tagged and are dropped.
 */
export function mentionTargets(
  agents: ReadonlyArray<{ name?: string | null; principalId: string }>,
  members: ReadonlyArray<{ name?: string | null; userId: string }>,
): MentionTarget[] {
  const records: IdentityRecord[] = [
    ...agents.map((agent) => ({ id: agent.principalId, name: agent.name ?? "" })),
    ...members.map((member) => ({ id: member.userId, name: member.name ?? "" })),
  ];
  return [
    ...agents.map((agent) => {
      const name = agent.name ?? "";
      return {
        entity: { kind: "agent" as const, id: agent.principalId },
        name,
        label: identityDisplayLabel({ id: agent.principalId, name }, records),
      };
    }),
    ...members.map((member) => {
      const name = member.name ?? "";
      return {
        entity: { kind: "person" as const, id: member.userId },
        name,
        label: identityDisplayLabel({ id: member.userId, name }, records),
      };
    }),
  ]
    .filter((target) => isTaggable(target.name))
    .sort((left, right) =>
      right.label.length - left.label.length || right.name.length - left.name.length
    );
}

/** Names two or more roster entries share, folded. */
function ambiguousNames(targets: readonly MentionTarget[]): Set<string> {
  const counts = new Map<string, number>();
  for (const target of targets) {
    const folded = fold(target.name);
    counts.set(folded, (counts.get(folded) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}

function targetLabel(target: MentionTarget): string {
  return target.label ?? target.name;
}

function tagMatch(
  body: string,
  at: number,
  token: string,
): number | null {
  if (!isTaggable(token)) return null;
  const span = body.slice(at + 1, at + 1 + token.length);
  if (span.length !== token.length) return null;
  if (fold(span) !== fold(token)) return null;
  const after = body[at + 1 + token.length];
  if (after !== undefined && !CLOSES_TAG.test(after)) return null;
  return token.length;
}

export function addressFromBody(
  body: string,
  targets: readonly MentionTarget[],
): MentionAddress {
  const ordered = [...targets]
    .filter((target) => isTaggable(target.name) || isTaggable(targetLabel(target)))
    .sort((left, right) =>
      targetLabel(right).length - targetLabel(left).length ||
      right.name.length - left.name.length
    );
  const ambiguousSet = ambiguousNames(ordered);
  const recipients: MentionEntity[] = [];
  const ambiguous: string[] = [];
  const overflow: string[] = [];
  const seen = new Set<string>();
  for (let at = body.indexOf("@"); at !== -1; at = body.indexOf("@", at + 1)) {
    const before = at === 0 ? "" : body[at - 1]!;
    if (before !== "" && !OPENS_TAG.test(before)) continue;
    let matched: MentionTarget | undefined;
    let consumed = 0;
    let nameOnlyAmbiguous: string | undefined;
    for (const target of ordered) {
      const labelLength = tagMatch(body, at, targetLabel(target));
      if (labelLength !== null) {
        matched = target;
        consumed = labelLength;
        nameOnlyAmbiguous = undefined;
        break;
      }
      const nameLength = tagMatch(body, at, target.name);
      if (nameLength === null) continue;
      if (ambiguousSet.has(fold(target.name))) {
        nameOnlyAmbiguous = target.name;
        consumed = nameLength;
        continue;
      }
      matched = target;
      consumed = nameLength;
      nameOnlyAmbiguous = undefined;
      break;
    }
    if (nameOnlyAmbiguous !== undefined && matched === undefined) {
      if (!ambiguous.includes(nameOnlyAmbiguous)) ambiguous.push(nameOnlyAmbiguous);
      at += consumed;
      continue;
    }
    if (matched === undefined) continue;
    const key = `${matched.entity.kind}:${matched.entity.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      if (recipients.length < MENTION_MAX_RECIPIENTS) recipients.push({ ...matched.entity });
      else overflow.push(targetLabel(matched));
    }
    at += consumed;
  }
  return { ambiguous, overflow, recipients };
}
