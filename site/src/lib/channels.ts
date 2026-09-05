/**
 * Channels, browser side.
 *
 * Every bound and every list a reader can see here is imported from
 * `supabase/functions/_shared/channels.ts` — the module the command edge
 * validates with. Nothing in this file retypes a rule the server enforces:
 * that is the failure AGENTS.md measured four times in one release cycle, and
 * a sentence built from the enforcing constant cannot drift from it.
 *
 * The dashboard already imports `_shared/signal-text` the same way
 * (`LiveDashboard.astro:21`), so this crosses no new boundary.
 */
import {
  CHANNEL_PURPOSE_MAX,
  CHANNEL_SLUG_MAX,
  CHANNEL_SLUG_RULE_TEXT,
  RESERVED_CHANNEL_SLUG_TEXT,
  RESERVED_CHANNEL_SLUGS,
  channelSlugProblem,
  isReservedChannelSlug,
  normalizeChannelSlug,
} from "../../../supabase/functions/_shared/channels.js";

export {
  CHANNEL_PURPOSE_MAX,
  CHANNEL_SLUG_MAX,
  CHANNEL_SLUG_RULE_TEXT,
  RESERVED_CHANNEL_SLUG_TEXT,
  RESERVED_CHANNEL_SLUGS,
  channelSlugProblem,
  isReservedChannelSlug,
  normalizeChannelSlug,
};

/**
 * The name of the unfiltered view. It is NOT a row in `swarm.channels`: it is
 * the whole feed, filed and unfiled together. The edge reserves this slug so a
 * member cannot create a channel that shadows it, and
 * `channels.test.mjs` asserts that reservation rather than assuming it.
 */
export const ALL_SIGNALS_SLUG = "all-signals";

/** One channel row as the browser reads it from `swarm_read.channels`. */
export interface WorkspaceChannel {
  channelId: string;
  workspaceId: string;
  slug: string;
  purpose: string | null;
  createdByPrincipal: string;
  createdByKind: string;
  createdAt: string;
  archivedAt: string | null;
}

/** What the feed is filtered to. `null` is the unfiltered view. */
export type ActiveChannel = WorkspaceChannel | null;

/** The rail and the head write a channel the same way: one hash, one slug. */
export const channelLabel = (slug: string): string => `#${slug}`;

/** Live channels only, in the order a reader scans them. */
export const liveChannels = (
  channels: readonly WorkspaceChannel[],
): WorkspaceChannel[] =>
  channels
    .filter((channel) => channel.archivedAt === null)
    .sort((a, b) => a.slug.localeCompare(b.slug));

export const channelById = (
  channels: readonly WorkspaceChannel[],
  channelId: string | null,
): WorkspaceChannel | null =>
  channelId === null
    ? null
    : channels.find((channel) => channel.channelId === channelId) ?? null;

/**
 * The rule text a reader sees before typing a name, built from the same two
 * constants the validator refuses with.
 */
export const channelNameHint = (): string =>
  `${CHANNEL_SLUG_RULE_TEXT} ${RESERVED_CHANNEL_SLUG_TEXT}`;

/** The purpose bound, built from the bound the validator applies. */
export const channelPurposeHint = (): string =>
  `Optional. What this channel is for, in ${CHANNEL_PURPOSE_MAX} characters or fewer.`;

/**
 * What a channel is, said once and honestly. Two facts the design requires in
 * the UI rather than in a help page: every member reads every channel, and
 * filing a message in one changes nothing about who is woken.
 */
export const CHANNEL_REACH_TEXT =
  "Every member of this workspace reads every channel. A channel is the address of a message, not who gets woken.";

/**
 * Signals written before channels existed carry no channel and can never be
 * moved into one, because a signal row is immutable. Say so where the reader
 * meets an empty channel rather than letting them conclude it is broken.
 */
export const CHANNEL_EMPTY_TEXT =
  "Nothing has been posted here yet. Messages written before this channel existed stay in all-signals.";

export const CHANNEL_ARCHIVED_TEXT =
  "This channel is archived. Its messages still read, and nothing new can be posted to it.";

/**
 * The refusal a reader sees. The server's own `message` is used whenever it
 * sent one, and it is NEVER parsed: D-053 says a message is presentation, so
 * this reads `body.message` as text to show and branches only on the numeric
 * status when the server sent no message at all.
 */
export const channelRefusalMessage = (
  status: number,
  body: Record<string, unknown>,
  fallback: string,
): string => {
  const message = body.message;
  if (typeof message === "string" && message.trim() !== "") return message;
  return `${fallback} (HTTP ${status}). Nothing was changed.`;
};

/**
 * The slug a caller may send, or the refusal to show instead. The edge runs the
 * same function on the same normalized value, so a name this accepts is refused
 * by the server only for a reason the browser cannot know (a name already
 * taken), never for its spelling.
 */
export const channelSubmitProblem = (raw: string): string | null =>
  channelSlugProblem(raw);

/** Trim to what the edge stores, so a preview cannot promise a different name. */
export const channelSubmitSlug = (raw: string): string =>
  normalizeChannelSlug(raw);

/**
 * Longest slug the input accepts. The edge measures the NORMALIZED value, so a
 * trailing space is not part of the bound; the attribute is the bound itself
 * and the validator still has the last word.
 */
export const channelSlugInputMax = (): number => CHANNEL_SLUG_MAX;
export const channelPurposeInputMax = (): number => CHANNEL_PURPOSE_MAX;
