/**
 * Channels, on the client side: the naming rule, the list, and the sentences
 * the CLI prints about both.
 *
 * ## Why the constants below are a COPY, and what keeps the copy honest
 *
 * The enforcement lives in `supabase/functions/_shared/channels.ts`. This file
 * cannot import it. `tsconfig.json` sets `rootDir: "src"`, so a module under
 * `src/` that reaches into `supabase/` fails the build with TS6059 before any
 * of it runs; the edge module is also read by `deno check`, which resolves
 * `.ts` specifiers, while `tsc` under Node16 resolves `.js` ones, so one file
 * cannot satisfy both from here. The protocol bundle would be the shared home,
 * but `src/protocol/` is owned by the schema lane and exports none of this.
 *
 * So the values are duplicated ON PURPOSE, once, in this comment's sight:
 * `tests/p1-cli/chat-cli.test.ts` imports BOTH modules and fails when any
 * constant, any generated sentence, or any `channelSlugProblem` answer differs.
 * The test is what makes the copy safe; without it this file would be exactly
 * the typed-enumeration failure AGENTS.md measured four times in one release.
 *
 * Every user-facing sentence here is BUILT from the constant the validator
 * reads, never typed, for the same reason.
 */
import {
  CLIENT_PROTOCOL_VERSION,
  readEndpoint,
  type CloudTarget,
} from "./config.js";

/** Longest channel slug. The edge and the database CHECK carry the same bound. */
export const CHANNEL_SLUG_MAX = 32;

/** Longest channel purpose. The edge and the database CHECK carry the same bound. */
export const CHANNEL_PURPOSE_MAX = 500;

/**
 * The character classes the slug pattern allows, as {regex fragment, words}.
 * BOTH the regex and the sentence are built from this table, so a class cannot
 * be added to one and left out of the other.
 *
 * `edge` is the class allowed at the first and last character; `inner` adds the
 * classes allowed only in between.
 */
export const CHANNEL_SLUG_CLASSES = {
  edge: [
    { fragment: "a-z", words: "lowercase letters", one: "a letter" },
    { fragment: "0-9", words: "digits", one: "a digit" },
  ],
  inner: [{ fragment: "-", words: "hyphens" }],
} as const;

function classList(
  entries: readonly { words: string; one?: string }[],
  conjunction: "and" | "or" = "and",
  singular = false,
): string {
  const words = entries.map((entry) =>
    singular ? (entry.one ?? entry.words) : entry.words
  );
  return words.length === 1
    ? words[0]!
    : `${words.slice(0, -1).join(", ")} ${conjunction} ${
      words[words.length - 1]!
    }`;
}

const SLUG_EDGE = CHANNEL_SLUG_CLASSES.edge.map((c) => c.fragment).join("");
const SLUG_INNER = SLUG_EDGE +
  CHANNEL_SLUG_CLASSES.inner.map((c) => c.fragment).join("");

export const CHANNEL_SLUG_RE = new RegExp(
  `^[${SLUG_EDGE}]([${SLUG_INNER}]*[${SLUG_EDGE}])?$`,
);

/**
 * Names a channel may not take. `all-signals` is the unfiltered view, not a
 * row, so a channel by that name would shadow the one place unfiled signals
 * are readable.
 */
export const RESERVED_CHANNEL_SLUGS: readonly string[] = ["all-signals"];

/** The slug rule, in words, built from the bound the validator enforces. */
export const CHANNEL_SLUG_RULE_TEXT = `A channel name uses ${
  classList([...CHANNEL_SLUG_CLASSES.edge, ...CHANNEL_SLUG_CLASSES.inner])
}, starts and ends with ${
  classList(CHANNEL_SLUG_CLASSES.edge, "or", true)
}, and is 1 to ${CHANNEL_SLUG_MAX} characters.`;

/**
 * What a channel id is. The edge exports the same sentence as
 * CHANNEL_ID_RULE_TEXT; the drift test pins the two together.
 */
export const CHANNEL_ID_RULE_TEXT = "channel_id must be a UUID.";

/** The reserved list, in words, built from the list the validator enforces. */
export const RESERVED_CHANNEL_SLUG_TEXT = `Reserved names: ${
  RESERVED_CHANNEL_SLUGS.join(", ")
}.`;

/** Trim and lowercase. Slugs compare case-insensitively in the unique index. */
export function normalizeChannelSlug(value: string): string {
  return value.trim().toLowerCase();
}

export function isReservedChannelSlug(value: string): boolean {
  return RESERVED_CHANNEL_SLUGS.includes(normalizeChannelSlug(value));
}

/**
 * WHY a name cannot be used, as a value rather than as a sentence.
 *
 * The edge has only the sentence, because the edge only ever prints it. The CLI
 * needs the reason too: a selector that is a well-formed name but RESERVED has
 * broken a different rule from one that is the wrong shape, and telling the
 * second story to the first caller sends them to fix a rule they kept. A review
 * arm found exactly that in the first version of `channelSelectorProblem`.
 *
 * Deriving the sentence from this classifier rather than beside it is what
 * keeps `channelSlugProblem` byte-identical to the edge's while the reason
 * stays readable.
 */
export type ChannelNameProblem = "ok" | "not-text" | "shape" | "reserved";

export function channelNameProblem(value: unknown): ChannelNameProblem {
  if (typeof value !== "string") return "not-text";
  const slug = normalizeChannelSlug(value);
  if (slug.length < 1 || slug.length > CHANNEL_SLUG_MAX) return "shape";
  if (!CHANNEL_SLUG_RE.test(slug)) return "shape";
  if (isReservedChannelSlug(slug)) return "reserved";
  return "ok";
}

/**
 * The one refusal message for a bad slug, or null when the slug is usable.
 * Byte-identical to the edge's, which is what lets the CLI refuse before the
 * round trip without ever telling a caller a different rule than the server
 * would have.
 */
export function channelSlugProblem(value: unknown): string | null {
  switch (channelNameProblem(value)) {
    case "ok":
      return null;
    case "not-text":
      return `A channel name must be text. ${CHANNEL_SLUG_RULE_TEXT}`;
    case "shape":
      return CHANNEL_SLUG_RULE_TEXT;
    case "reserved":
      return `${
        normalizeChannelSlug(value as string)
      } is reserved. ${RESERVED_CHANNEL_SLUG_TEXT}`;
  }
}

/**
 * A channel as the command edge returns it and as `swarm_read.channels`
 * projects it. The two shapes are the same eight columns in the same order.
 */
export interface ChannelRow {
  channel_id: string;
  workspace_id: string;
  slug: string;
  purpose: string | null;
  created_by_principal: string;
  created_by_kind: "user" | "agent";
  created_at: string;
  archived_at: string | null;
}

/**
 * The columns the human REST read asks for.
 *
 * It must equal CHANNEL_READ_COLUMNS in supabase/functions/_shared/channels.ts,
 * which the agent read edge builds its SELECT from, or the two credentials get
 * different fields for the same list. This file cannot import that module --
 * tsconfig.json pins rootDir to src -- so the two arrays are pinned by
 * tests/chat-channel-constants.test.ts, which imports BOTH and compares them.
 */
export const CHANNEL_COLUMNS = [
  "channel_id",
  "workspace_id",
  "slug",
  "purpose",
  "created_by_principal",
  "created_by_kind",
  "created_at",
  "archived_at",
] as const;

/**
 * RETIRED 2026-09-05. Two constants stood here and both are gone, because both
 * became false the moment the `read` edge learned a `channels` resource. They
 * are preserved verbatim: a reader can still meet them in an installed 0.1.55
 * build, which prints them, and in `docs/evidence/2026-09-05-chat-client/`.
 *
 *   CHANNEL_LIST_NEEDS_HUMAN_MESSAGE:
 *     "Listing channels needs a signed-in person: this deployment's read
 *      service has no channel list for an agent credential. Run cswarm channel
 *      ls from a session signed in with cswarm login, or name the channel you
 *      want by name wherever a command takes one."
 *
 *   CHANNEL_SELECTOR_NEEDS_ID_MESSAGE:
 *     "Turning a channel name into a channel id needs a signed-in person,
 *      because this deployment's read service does not list channels for an
 *      agent credential. Pass the channel id instead. cswarm channel create
 *      prints it, and cswarm channel ls shows it from a session signed in with
 *      cswarm login."
 *
 * Their measured cause was accurate when written and is no longer true:
 * `parseBody` in `supabase/functions/read/index.ts` had no channels arm. It has
 * one, `listChannelsAsAgent` below reads it, and `channelRows` in src/cli.ts no
 * longer branches on the credential kind, so an agent lists channels and turns
 * a name into an id exactly as a person does.
 *
 * ⚠ THE COUPLING THIS CREATES. A client carrying these removals talks to a read
 * service that may not have the arm yet. Against such a deployment
 * `listChannelsAsAgent` gets HTTP 400 and says the list was refused, which is a
 * worse sentence than the two above but is not a wrong one. Ship the `read`
 * deploy first, or in the same release.
 */

/**
 * The channel list for an agent credential: the `read` edge function, the same
 * transport `cswarm file ls` and `cswarm brain ls` take for an agent.
 *
 * `listChannelsAsHuman` BELOW uses PostgREST, because the read function accepts
 * agent credentials only. Both end at the same `swarm_read.channels` view and
 * ask for the same columns, so the two credentials render the same list.
 *
 * ORDER, and the reason the two sorts agree rather than nearly agree: the edge
 * sorts by `lower(slug)` and PostgREST by `slug`. Those differ only where a
 * slug carries an uppercase letter, and `20260905000001_channels.sql` CHECKs
 * `slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'`, so no stored slug can. A review
 * arm refuted an earlier version of this paragraph, which claimed a workspace
 * "mixing cases" could list in a different order for the two credentials: that
 * workspace cannot exist.
 */
export async function listChannelsAsAgent(
  target: CloudTarget,
  credential: string,
  workspaceId: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 30_000,
): Promise<ChannelRow[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Same body-covering deadline as the human read above, and the same reason.
  try {
    let response: Response;
    try {
      response = await fetcher(readEndpoint(target), {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          apikey: target.anonKey,
          "content-type": "application/json",
        },
        /* EXACTLY these two keys and no others. The read function parses this
         * resource with `exactKeys(["resource", "workspace_id"])`, which
         * compares the SORTED key sets: an extra or a missing key is a 400, and
         * the ORDER below is not something the server enforces. It is pinned
         * byte for byte by tests/p1-cli/chat-cli.test.ts anyway, because a
         * renamed or added key is the failure worth catching and a byte
         * comparison catches it without another shape assertion. */
        body: JSON.stringify({ resource: "channels", workspace_id: workspaceId }),
        signal: controller.signal,
      });
    } catch {
      throw new ChannelListError(
        0,
        "The channel list did not complete. Nothing changed. Run the same command again.",
        true,
      );
    }
    if (!response.ok) {
      throw new ChannelListError(
        response.status,
        `The channel list was refused (HTTP ${response.status}). Nothing changed.`,
      );
    }
    let raw: string;
    try {
      raw = await response.text();
    } catch {
      throw new ChannelListError(
        0,
        "The channel list did not complete. Nothing changed. Run the same command again.",
        true,
      );
    }
    let body: { channels?: unknown } | null = null;
    try {
      body = JSON.parse(raw) as { channels?: unknown };
    } catch {
      body = null;
    }
    if (!body || !Array.isArray(body.channels)) {
      throw new ChannelListError(
        response.status,
        "The channel list came back in a shape this version does not understand.",
      );
    }
    return body.channels as ChannelRow[];
  } finally {
    clearTimeout(timer);
  }
}

export function channelSelectorProblem(selector: string): string | null {
  const problem = channelNameProblem(selector);
  if (problem === "ok") return null;
  if (problem === "reserved") return channelSlugProblem(selector);
  return `That is neither a channel name nor a channel id. ${CHANNEL_SLUG_RULE_TEXT} ${CHANNEL_ID_RULE_TEXT}`;
}

export class ChannelListError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly noResponse = false,
  ) {
    super(message);
    this.name = "ChannelListError";
  }
}

/**
 * The membership-gated channel list, read the way `cswarm file ls` and
 * `cswarm members` read theirs for a human: PostgREST over the `swarm_read`
 * profile, with the person's own access token. The view's WHERE is the policy;
 * this asks for one workspace and can widen nothing.
 */
export async function listChannelsAsHuman(
  target: CloudTarget,
  accessToken: string,
  workspaceId: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 30_000,
): Promise<ChannelRow[]> {
  const url = new URL("/rest/v1/channels", target.url);
  url.searchParams.set("workspace_id", `eq.${workspaceId}`);
  url.searchParams.set("select", CHANNEL_COLUMNS.join(","));
  url.searchParams.set("order", "slug.asc");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  /* THE DEADLINE COVERS THE BODY, not only the headers. D-034 is the rule and a
   * review arm found this function breaking it: clearTimeout used to run in the
   * fetch's own finally, so a server that sent headers and then stalled the
   * stream left `cswarm channel ls` waiting for ever, with no abort and no
   * retry. The timer is cleared once, after the bytes are in hand. */
  try {
    let response: Response;
    try {
      response = await fetcher(url.toString(), {
        headers: {
          authorization: `Bearer ${accessToken}`,
          apikey: target.anonKey,
          "accept-profile": "swarm_read",
        },
        signal: controller.signal,
      });
    } catch {
      throw new ChannelListError(
        0,
        "The channel list did not complete. Nothing changed. Run the same command again.",
        true,
      );
    }
    if (!response.ok) {
      throw new ChannelListError(
        response.status,
        `The channel list was refused (HTTP ${response.status}). Nothing changed.`,
      );
    }
    /* A body that never settles is the request not completing, so it takes the
     * retryable sentence rather than the "shape this version does not
     * understand" one, which would blame the server for our own timeout. */
    let raw: string;
    try {
      raw = await response.text();
    } catch {
      throw new ChannelListError(
        0,
        "The channel list did not complete. Nothing changed. Run the same command again.",
        true,
      );
    }
    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    if (!Array.isArray(body)) {
      throw new ChannelListError(
        response.status,
        "The channel list came back in a shape this version does not understand.",
      );
    }
    return body as ChannelRow[];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Find one channel by slug in an already-read list. Comparison is
 * case-insensitive because the unique index is.
 */
export function findChannelBySlug(
  rows: readonly ChannelRow[],
  slug: string,
): ChannelRow | null {
  const wanted = normalizeChannelSlug(slug);
  return rows.find((row) => normalizeChannelSlug(row.slug) === wanted) ?? null;
}

/**
 * The sentence for a slug that names no channel here. The list is generated
 * from the same rows the lookup searched, so it can never name a channel that
 * is not there or omit one that is. The edge builds the same sentence from its
 * own query; this one exists because the CLI resolves a slug locally before it
 * sends anything.
 */
export function unknownChannelMessage(
  slug: string,
  rows: readonly ChannelRow[],
): string {
  const live = rows
    .filter((row) => row.archived_at === null)
    .map((row) => row.slug)
    .sort();
  return live.length === 0
    ? `There is no channel named ${
      normalizeChannelSlug(slug)
    } in this workspace, and no channel has been created yet. Create it with cswarm channel create ${
      normalizeChannelSlug(slug)
    }.`
    : `There is no channel named ${
      normalizeChannelSlug(slug)
    } in this workspace. Channels here: ${live.join(", ")}.`;
}

/**
 * The channel list a person reads. Pure, so the claims it makes are gated by a
 * unit test rather than only by a live deployment.
 */
export function renderChannelList(
  rows: readonly ChannelRow[],
  options: { includeArchived: boolean },
): string {
  const live = rows.filter((row) => row.archived_at === null);
  const archived = rows.filter((row) => row.archived_at !== null);
  const shown = options.includeArchived ? [...live, ...archived] : live;
  if (shown.length === 0) {
    return live.length === 0 && archived.length > 0
      ? "Every channel in this workspace is archived. See them with cswarm channel ls --include-archived.\n"
      : "No channels in this workspace yet. Create one with cswarm channel create <name>.\n";
  }
  const lines = shown.map((row) => {
    const marker = row.archived_at === null
      ? ""
      : "  [archived; it keeps its history and takes no new messages]";
    const purpose = row.purpose === null ? "" : `: ${row.purpose}`;
    return `- ${row.slug}${purpose}${marker}`;
  });
  const head = `Channels in this workspace (${shown.length}):`;
  const tail = options.includeArchived || archived.length === 0
    ? ""
    : `\n${archived.length} archived channel${
      archived.length === 1 ? "" : "s"
    } not shown. See them with cswarm channel ls --include-archived.`;
  return `${head}\n${lines.join("\n")}${tail}\n`;
}

/**
 * What a caller is told when the deployment refuses the request WITHOUT saying
 * why. The chat commands answer every validation refusal with a `message`
 * (`supabase/functions/command/index.ts`), so a bare refusal means the request
 * never reached that validator: the envelope layer of a deployment that
 * predates channels is the reachable cause.
 *
 * It states what is known and what to do, and claims nothing about the cause it
 * cannot see. The version is the client protocol version this build speaks, so
 * the sentence moves with the build rather than naming a number by hand.
 */
export const CHANNEL_UNSUPPORTED_MESSAGE =
  `This deployment refused the request and did not say why. Channels need a deployment whose command service knows them; this cswarm speaks protocol ${CLIENT_PROTOCOL_VERSION}. Nothing was created or changed. Ask whoever runs this deployment to update it, or drop the channel options and post as before.`;
