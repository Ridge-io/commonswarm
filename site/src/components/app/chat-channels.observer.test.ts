import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  CHANNEL_SLUG_MAX,
  RESERVED_CHANNEL_SLUGS,
} from "../../../../supabase/functions/_shared/channels.js";

/*
 * The channel surfaces of the workspace app: the rail, the phone's control, the feed's
 * narrowing, the composer's stamp, and the thread. Source assertions pin the behaviour;
 * the built /app artifact proves Astro ships it.
 *
 * The claims this file defends, stated so a reader can check them against the system rather
 * than against another artifact that repeats them:
 *   1. A channel is an ADDRESS. all-signals shows every message, filed and unfiled.
 *   2. The narrowing is the QUERY's, so a channel shows the newest messages IN it.
 *   3. The composer posts where you are reading, with no added chrome and no body parsing.
 *   4. A refusal shows the server's sentence and is never read for meaning.
 *   5. A ?c= that names no readable channel never falls back to the unfiltered feed.
 */
const componentDir = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(componentDir, "..", "..", "..");
const repoRoot = join(siteRoot, "..");
const dashboard = readFileSync(join(componentDir, "LiveDashboard.astro"), "utf8");
const client = readFileSync(join(siteRoot, "src", "lib", "commonswarm.ts"), "utf8");
const commandEdge = readFileSync(
  join(repoRoot, "supabase", "functions", "command", "index.ts"),
  "utf8",
);
const serverSuite = readFileSync(
  join(repoRoot, "tests", "p1-server", "chat-signals.test.ts"),
  "utf8",
);
const appHtml = readFileSync(join(siteRoot, "dist", "app", "index.html"), "utf8");

const between = (source: string, start: string, end: string): string => {
  const startAt = source.indexOf(start);
  assert.notEqual(startAt, -1, `missing start anchor: ${start}`);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(endAt, -1, `missing end anchor: ${end}`);
  return source.slice(startAt, endAt);
};

/** The key set the command edge's own `exactKeys` check accepts, read from the edge. */
const edgeKeys = (kind: string): { required: string[]; optional: string[] } => {
  const block = between(commandEdge, `if (cmd.kind === "${kind}") {`, "return {");
  const list = (name: string): string[] => {
    const match = block.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
    return match === null
      ? []
      : match[1]!.split(",").map((entry) => entry.trim().replace(/^"|"$/g, "")).filter(Boolean);
  };
  return { required: list("required"), optional: list("optional") };
};

/**
 * The keys a literal command object in our source actually sends: `key: value` pairs and
 * ES shorthand alike, the latter both as `{ slug }` and as the last entry of a longer
 * object. Missing the shorthand form made this read a command as short one field and gave
 * a confident failure about a key that was there.
 */
const sentKeys = (source: string): string[] => {
  /* Comments first. This repo keeps the reason beside the code, and prose inside an object
     literal reads as `word:` to any regex — which is how a comment's own words arrived here
     as command fields. */
  const body = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const keys = new Set<string>();
  for (const match of body.matchAll(/(?:^|[{,\s])([a-z_][a-z0-9_]*)\s*:/gi)) keys.add(match[1]!);
  for (const match of body.matchAll(/[{,]\s*([a-z_][a-z0-9_]*)\s*[,}]/gi)) keys.add(match[1]!);
  return [...keys].sort();
};

test("the rail names channels, and `stream` is gone from the app's vocabulary", () => {
  const rail = between(dashboard, '<aside class="dashboard__rail"', '<section class="dashboard__channel"');
  assert.match(rail, /<h2 id="dashboard-channels-label">CHANNELS<\/h2>/);
  /* ~~STREAMS (broadcast)~~ retired 2026-09-05. `stream` is the event log on the wire and in
     SWARM-CLOUD.md 2.1; this heading was the only place the app showed that word.
     The negative runs on the BUILT markup, because the source keeps the retired wording in
     the comment that records the change and a source sweep would fail on our own doctrine. */
  const builtRail = between(appHtml, 'class="dashboard__rail"', 'class="dashboard__channel"');
  assert.doesNotMatch(builtRail, /STREAMS/);
  assert.doesNotMatch(builtRail, /\bstream\b/i);
  /* all-signals sits above the list because it is not one of them: it is the whole feed. */
  assert.match(rail, /data-channel-place=""[\s\S]*?aria-current="page"/);
  /* Built from the constant, not typed: ~~`<span>all-signals</span>`~~ 2026-09-05. */
  assert.match(rail, /<span>\{ALL_SIGNALS_SLUG\}<\/span>/);
  assert.match(rail, /data-channel-list/);
  assert.match(rail, /data-channel-new[\s\S]*?aria-label="New channel"/);
  assert.ok(appHtml.includes("CHANNELS"), "the built /app page must ship the rail heading");
  assert.ok(appHtml.includes("data-channel-list"), "the built /app page must ship the list");
});

test("the phone reaches channels without a second standing header row", () => {
  /* The 2026-09-04 ruling: the 73px app bar is the only standing header. The rail's channel
     list is hidden on a phone with the rest of the rail, so the control that replaces it
     rides in the feed toolbar, which floats over the transcript on a negative margin equal
     to its own height. Its own height must not exceed that band. */
  assert.match(dashboard, /class="dashboard__channel-switch"[\s\S]*?data-channel-switch/);
  assert.match(dashboard, /\.dashboard__channel-switch \{\s*display: none;\s*\}/);
  const mobile = between(
    dashboard,
    "@media (max-width: 52rem) {\n    .dashboard__product {",
    "@media (max-width: 34rem)",
  );
  const rule = between(mobile, ".dashboard__channel-switch {", "}");
  assert.match(rule, /display: inline-flex;/);
  assert.match(rule, /min-block-size: 2\.5rem;/, "the control may not be taller than the band");
  const toolbar = between(mobile, ".dashboard__feed-toolbar {", "}");
  assert.match(toolbar, /min-block-size: 2\.5rem;/);
  assert.match(toolbar, /margin-block-end: -2\.5rem;/, "the band still takes its height back");
  assert.ok(appHtml.includes("data-channel-switch"), "the built page ships the phone control");
});

test("the channel narrowing is the query's, not the rendered list's", () => {
  const page = between(dashboard, "const signalPage = async (", "const initials =");
  assert.match(page, /channelId: string \| null,/);
  assert.match(page, /if \(channelId !== null\) query = query\.eq\("channel_id", channelId\);/);
  /* Both readers carry the channel with the request and check it again when it lands, the
     same way they check the workspace. Without that, a page fetched for one channel can be
     applied under another channel's name. */
  for (const anchor of ["const loadSignals = async (", "const refreshLatestSignals = async ("]) {
    const reader = between(dashboard, anchor, "};");
    assert.match(reader, /const channelId = activeChannelId;/, anchor);
    assert.match(reader, /channelId !== activeChannelId/, anchor);
  }
  /* And nothing filters channels in the browser: a client-side channel filter would say
     "this channel" and mean "among the loaded page", which is the defect the shipped
     All / Broadcast / Direct-to-you filter already has and must not spread. */
  assert.doesNotMatch(dashboard, /filterSignalsByChannel/);
  const feedLib = readFileSync(join(siteRoot, "src", "lib", "signal-feed.ts"), "utf8");
  assert.doesNotMatch(feedLib, /export const filterSignalsByChannel/);
});

test("all-signals shows every message and names the channel each one is in", () => {
  const feed = between(dashboard, "const buildMessageRow = (", "previousSignalIds = new Set(");
  /* The default is the whole feed: nothing narrows unless a channel is chosen, so a filed
     message is visible from all-signals and is not hidden behind its channel. */
  assert.match(dashboard, /let activeChannelId: string \| null = null;/);
  assert.match(
    feed,
    /const rowChannel = activeChannelId === null && signal\.channelId !== null/,
  );
  assert.match(feed, /class = "dashboard__message-channel"|className = "dashboard__message-channel"/);
  assert.match(feed, /selectChannel\(rowChannel\.channelId\)/);
});

test("the composer stamps the channel being read and gains no chrome for it", () => {
  const composer = between(dashboard, '<form class="dashboard__composer"', "</form>");
  /* R10 and the 2026-09-04 operator direction: no dropdown, no TO row, no second bar. */
  assert.doesNotMatch(composer, /<select/);
  assert.doesNotMatch(composer, /data-composer-channel-select|data-composer-audience/);
  /* And no `#` parsing of the body, ever: bodies contain `#` legitimately (a Markdown
     heading, an issue reference), so a parser cannot tell an address from prose. */
  assert.doesNotMatch(dashboard, /rawBody[^\n]*match\([^\n]*#/);
  /* THE INTENT KEEPS AN ID, NEVER A SLUG. `post_signal` takes a slug and the edge resolves it
     against the live row, so a frozen slug made a Retry after a rename name a channel that no
     longer exists — or, if another member had taken the freed name, someone else's. A review
     arm found it. The slug is resolved from the id at the moment of sending, and a send whose
     channel has left the list is refused rather than posted unfiled. */
  const placement = between(dashboard, "const freshPlacementChannelId =", "const attachmentSnapshot");
  assert.match(placement, /const freshPlacementChannelId = activeChannel\(\)\?\.channelId \?\? null;/);
  const resolve = between(dashboard, "const placementChannelId = intent.placementChannelId;", "const mentionsFor");
  assert.match(resolve, /channelById\(channels, placementChannelId\)/);
  assert.match(resolve, /const placement: BrowserSignalPlacement = placementChannel === null\s*\n\s*\? \{\}\s*\n\s*: \{ channel: placementChannel\.slug \};/);
  assert.match(resolve, /is not in this workspace any more/);
  /* An archived channel RESOLVES on purpose — a permalink into one must still work — so a
     check that only asked whether the row exists let a retry keep sending into a channel the
     server refuses, with Retry still lit, forever. A review arm found it. */
  assert.match(resolve, /placementChannel\.archivedAt !== null/);
  assert.match(resolve, /is archived and does not accept new messages/);
  assert.doesNotMatch(dashboard, /placement: freshPlacement/);
  /* THREADS ARE NOT THIS LANE (cut 2026-09-05 to `lane/chat-app-threads`). The browser never
     sends `thread_root_id` or `broadcast_to_channel`; a reply written from the CLI still
     renders, inline in the flat feed, which is what the design states for a client that does
     not know about threads. */
  assert.doesNotMatch(dashboard, /threadRootId: (?!null)[a-zA-Z]/);
  assert.doesNotMatch(dashboard, /broadcastToChannel: (?!false)[a-zA-Z]/);
  const sync = between(dashboard, "const syncComposerPlacement = (", "const renderChannelHead");
  assert.match(sync, /input\.placeholder = `Message \$\{channelLabel\(channel\.slug\)\}`;/);
  assert.match(sync, /input\.setAttribute\("aria-label", `Message in \$\{channelLabel\(channel\.slug\)\}`\)/);
});

test("a ?c= that names no readable channel never shows the unfiltered feed", () => {
  const apply = between(dashboard, "const applyChannelFromUrl = (", "const selectChannel = (");
  assert.match(apply, /unknownChannelId = found === null \? requested : null;/);
  /* renderFeed stops before it renders a row. The loaded rows ARE the whole workspace's,
     because a channel that cannot be resolved cannot narrow the query, so the honest state
     is the only thing standing between the reader and a feed under the wrong name. */
  const render = between(dashboard, 'const renderFeed = (change: "history"', "const now = Date.now();");
  assert.match(render, /if \(unknownChannelId !== null\) \{\s*renderUnknownChannel\(\);\s*return;\s*\}/);
  const unknown = between(dashboard, "const renderUnknownChannel = (", "const renderFeed =");
  /* ~~"is not in this workspace, or one you cannot read"~~ retired 2026-09-05: that named a
     read permission this product does not have. The sentence is generated now, and the test
     for what it may say is `the unresolved-channel copy names no permission…` below. */
  assert.match(unknown, /row\.textContent = unknownChannelText\(channelListFailed\);/);
  assert.match(unknown, /selectChannel\(null\)/);
  /* The bad id STAYS in the address bar. Dropping it would turn the link into the
     unfiltered feed on the next reload, which is the same failure one step later. */
  const url = between(dashboard, "const syncChannelUrl = (", "const applyChannelFromUrl");
  assert.match(url, /const channelId = unknownChannelId \?\? activeChannelId;/);
});

test("the URL round-trips the workspace and the channel by id", () => {
  const url = between(dashboard, "const syncChannelUrl = (", "const applyChannelFromUrl");
  assert.match(url, /url\.searchParams\.set\("w", activeWorkspaceId\)/);
  assert.match(url, /url\.searchParams\.set\("c", channelId\)/);
  assert.match(url, /window\.history\.replaceState/);
  /* The id, not the name, so a rename does not rot a link. */
  const rename = between(dashboard, "const submitChannelRename = async (", "const submitChannelArchive");
  assert.match(rename, /The id does not change/);
  /* ?w= is a convenience and never an authorization: it is honoured only when it names a
     workspace already in this reader's own memberships. */
  const boot = between(dashboard, "const requestedWorkspaceId =", "await openWorkspace(bootWorkspace.id);");
  assert.match(boot, /workspaces\.find\(\(workspace\) => workspace\.id === requestedWorkspaceId\) \?\?/);
});

test("the URL is written on every workspace open, and a ?c= belongs to its own ?w=", () => {
  /*
   * The URL used to be written only when a channel was clicked. Switching workspace from the
   * menu therefore carried the previous workspace's channel id into the new one, where it is
   * not, so the reader who chose workspace B was shown "Channel not found" instead of B's
   * feed and a reload took them back to A. Found by a review arm. Two rules fix it and both
   * are pinned here: a `?c=` belongs to the workspace its `?w=` names, and the address bar is
   * written after every open rather than after a click.
   */
  const apply = between(dashboard, "const applyChannelFromUrl = (", "const selectChannel = (");
  assert.match(apply, /const applyChannelFromUrl = \(workspaceId: string\): void =>/);
  assert.match(apply, /const forWorkspace = params\.get\("w"\);/);
  assert.match(
    apply,
    /\(forWorkspace !== null && forWorkspace !== workspaceId\)/,
    "a channel id from another workspace must not be applied to this one",
  );
  const open = between(dashboard, "applyChannelFromUrl(selected.id);", "renderMembers();");
  assert.match(open, /syncChannelUrl\(\);/, "the open must WRITE the address it just read");
});

test("the channel list flag follows the latest read, in both directions", () => {
  /* It was set once at workspace open and never again, so a first read that failed kept
     saying so after a later one succeeded, and a later one that failed left the copy claiming
     the id is simply not here. Found by a review arm. */
  const refresh = between(dashboard, "const refreshChannels = async (", "\n    };");
  assert.match(refresh, /channelListFailed = true;/);
  assert.match(refresh, /channels = next;\s*\n\s*channelListFailed = false;/);
});

test("a sample post joins the sample set, so the local narrowing stays honest", () => {
  /* Sample mode narrows over a snapshot taken at boot, and a sample post only reached
     `signals`. Posting then switching channel made the post vanish, and it made the argument
     for allowing a local filter there false: "the sample IS the whole set" holds only if the
     set grows with it. Found by a review arm. */
  const submit = between(dashboard, "const visible = posted.filter(showsOnScreen);", "clearComposerDraft();");
  assert.match(submit, /if \(sampleMode\) sampleSignals = \[\.\.\.posted, \.\.\.sampleSignals\];/);
});

test("a post belongs to the channel it was sent from, whatever the reader does next", () => {
  /*
   * A channel click does not bump requestVersion, because it is not a workspace change. So
   * the composer's success and failure paths, guarded on version and workspace alone, would
   * prepend a row posted in one channel onto another channel's page — and the poll keeps any
   * local id the fetched page does not carry, so the stray row was durable. Found by a review
   * arm. The row still posts; it belongs to the channel it was sent to and is read there.
   */
  const submit = between(
    dashboard,
    'one<HTMLFormElement>("[data-composer]")?.addEventListener("submit"',
    "syncComposerControls();\n      renderFeed",
  );
  /* ~~`const channelAtSend = activeChannelId;`~~ retired 2026-09-05: two rounds of arms showed
     that neither aborting the send on a channel change nor comparing the view the send began
     in with the view it ended in was the right question. The row carries the channel the
     server gave it, so the row answers the question the list on screen asks. */
  const submitCode = submit.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(submitCode, /channelAtSend/);
  /* ~~`postedRowsBelongHere = () => channelAtSend === activeChannelId`~~ retired 2026-09-05.
     Comparing view identities was wrong in both directions: a post made in a channel and then
     read from all-signals belongs on screen and was dropped, and the row was also stripped
     out of a page that had already fetched it, so it appeared, vanished, and returned on the
     next poll. The question is the one the query on screen asks, and the SERVER stamped the
     row's channel, so the row answers it. A review arm found both directions. */
  /* One rule, one place: the composer's landing rule and the reset page's merge ask the same
     question, so they cannot be two answers. */
  assert.match(submit, /const showsOnScreen = rowShowsOnScreen;/);
  assert.match(
    dashboard,
    /const rowShowsOnScreen = \(row: Signal\): boolean =>\s*\n\s*unknownChannelId === null &&\s*\n\s*\(activeChannelId === null \|\| row\.channelId === activeChannelId\);/,
  );
  /* And a retry replays the address the message was sent to, not the channel the reader is
     looking at when they press it: a partial send, a switch, and a Retry filed the rest in
     the OTHER channel, and a failed thread reply lost its thread because the switch cleared
     it. Both arms found it. */
  /* ~~`placement: freshPlacement` / `const placement = intent.placement`~~ 2026-09-05: the
     intent keeps the channel ID and the slug is resolved from it at send time, because a
     frozen slug made a Retry after a rename name the wrong channel. */
  assert.match(submit, /placementChannelId: freshPlacementChannelId,/);
  assert.match(submit, /const placementChannelId = intent\.placementChannelId;/);
  assert.doesNotMatch(submit, /intent\.placement\b/);
  /*
   * AND IT IS NOT A REASON TO ABANDON THE SEND. Returning early on a channel change left the
   * draft uncleared, the pending rows in two caches, the status stuck on "Posting…", and — on
   * the failure path — the body deleted with no error and no Retry, because the focus move a
   * channel click makes blurs the emptied box and flushes the draft. Both arms found that. So
   * the early return is guarded on the workspace ONLY, and the channel decides one thing:
   * whether the posted rows join the list on screen.
   */
  const applied = between(dashboard, "const attachmentRefs = sampleMode", "clearComposerDraft();");
  assert.doesNotMatch(
    applied.replace(/\/\*[\s\S]*?\*\//g, ""),
    /channelAtSend/,
    "a channel change must not skip the send's own cleanup",
  );
  /* A row is removed from the list ONLY when it is about to be put back: the id set filtered
     out and the id set prepended are the same one, on both paths. */
  assert.match(applied, /const visible = posted\.filter\(showsOnScreen\);/);
  assert.match(applied, /!pendingSet\.has\(entry\.id\) && !visibleIds\.has\(entry\.id\)/);
  assert.match(applied, /signals = \[\.\.\.visible, \.\.\.kept\];/);
  const failed = between(dashboard, "} catch (caught) {", "const sent = posted.length;");
  assert.doesNotMatch(failed.replace(/\/\*[\s\S]*?\*\//g, ""), /channelAtSend/);
  const failedRows = between(dashboard, "const keptOnFailure = signals.filter", "setComposerStatus(");
  assert.match(failedRows, /!visibleFailureIds\.has\(signal\.id\)/);
  assert.match(failedRows, /signals = \[\.\.\.visibleOnFailure, \.\.\.keptOnFailure\];/);
});

test("the workspace open leaves the rail's current mark to the channel rule", () => {
  /*
   * The all-signals button is BOTH a view control and a place control, so the signals-view
   * loop marks it current. Running that loop after the rail marked all-signals current on
   * every workspace open, including opens that resolved to a channel (two current places) and
   * opens whose ?c= resolved to nothing (a mark saying you are reading the whole feed while
   * the feed is not shown). Found by a review arm. Order is the fix, and order is what this
   * pins: syncChannelCurrent, reached through renderChannelRail and renderChannelHead, runs
   * last.
   */
  const render = between(dashboard, "const renderChannel = (workspace: Workspace", "renderWorkspaceList(workspace);");
  const loopAt = render.indexOf('for (const button of all<HTMLButtonElement>("[data-workspace-view]"))');
  const railAt = render.indexOf("renderChannelRail();");
  const headAt = render.indexOf("renderChannelHead();");
  assert.ok(loopAt >= 0 && railAt >= 0 && headAt >= 0, "all three steps must be present");
  assert.ok(loopAt < railAt, "the signals-view loop must run BEFORE the rail");
  assert.ok(railAt < headAt, "the head, which owns syncChannelCurrent, runs last");
});

test("only the newest channel read is applied", () => {
  /* A channel command does not bump requestVersion. Archive and Create are different buttons
     and each disables only its own, so two reads can be in flight at once and the older answer
     wins whenever it lands second, dropping a channel that was just created or flagging a
     healthy list as failed. Raised by a review arm. */
  const refresh = between(dashboard, "const refreshChannels = async (", "\n    };");
  assert.match(refresh, /const generation = \+\+channelReadGeneration;/);
  assert.match(refresh, /generation === channelReadGeneration &&/);
  assert.match(refresh, /if \(!current\(\)\) return;/);
  /*
   * The workspace open is a channel read too, and it takes its generation BEFORE the fetch.
   * Taken after, a slow open landed behind a create the reader made while it was still
   * loading — same workspace, same requestVersion, so nothing else dropped it — and overwrote
   * the list with the snapshot from before that channel existed; the URL then named an id the
   * stale list did not have and the head said "Channel not found" for a channel that does.
   * Found by a review arm.
   *
   * `const [nextAgents, nextRoster` is NOT a usable anchor here: an earlier roster catch-up
   * opens with the same words, and anchoring there sliced a region that does not contain the
   * code and produced a confident failure about code that was present.
   */
  const openStart = between(dashboard, "if (keepShell) renderChannel(selected, true);", "try {")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(openStart, /const channelGeneration = \+\+channelReadGeneration;/);
  const open = between(dashboard, "nextChannels] = await Promise.all([", "renderMembers();")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(
    open,
    /if \(channelGeneration === channelReadGeneration\) \{\s*\n\s*channels = nextChannels\.value;/,
  );
});

test("an auth change closes the channel dialog and drops the channel state", () => {
  /* The channel dialog is the third modal this app opens with showModal, and it lives outside
     every panel so a panel switch cannot display:none it out from under an open session —
     which is exactly why signing out has to close it. The other two are closed there already.
     Found by a review arm. */
  const reset = between(dashboard, "const resetWorkspaceSessionState = (", "\n    };");
  assert.match(reset, /closeChannelDialog\(\);/);
  for (const cleared of [
    "channels = \\[\\];",
    "channelListFailed = false;",
    "activeChannelId = null;",
    "unknownChannelId = null;",
    "disarmChannelArchive\\(\\);",
    "renderChannelRail\\(\\);",
  ]) {
    assert.match(reset, new RegExp(cleared), cleared);
  }
});

test("a later channel read gives an unresolved link one more chance", () => {
  /* The open resolves the URL against the list it read, and that read can be dropped for a
     newer one that has not landed yet, leaving a real id resolved against an empty list. It
     can also simply be a channel someone else made after this reader's list was read. Found
     by a review arm. */
  const refresh = between(dashboard, "const refreshChannels = async (", "\n    };");
  /* It goes through selectChannel, not applyChannelFromUrl: the head, the rail, the URL and
     the FEED have to move together. Resolving the id in place left the reader inside the
     channel with "Channel not found" still on the screen. A review arm found that. */
  assert.match(
    refresh,
    /if \(unknownChannelId !== null && channelById\(channels, unknownChannelId\) !== null\) \{\s*\n\s*selectChannel\(unknownChannelId\);\s*\n\s*return;/,
  );
});

test("an unfinished send is not resumed into a channel it was not addressed to", () => {
  /* selectChannel retires the intent when the reader moves, because the composer is about to
     promise the new channel. The failure path then wrote it back with the OLD placement,
     undoing that: Retry reused the old command ids and the old address, and the row landed in
     a channel the reader had left, filtered off their screen by showsOnScreen. Both arms
     found it. */
  const failed = between(dashboard, "const unsent = sent < recipients.length;", "renderFeed(\"latest\");");
  assert.match(
    failed,
    /const addressStillActive =\s*\n\s*placementChannelId === \(activeChannel\(\)\?\.channelId \?\? null\);/,
  );
  assert.match(failed, /const resumable = unsent && addressStillActive;/);
  assert.match(failed, /composerIntent = resumable/);
  assert.match(failed, /if \(retry && resumable\) retry\.hidden = false;/);
  /* And the sentence says where it was going, rather than inviting a send that cannot finish. */
  assert.match(failed, /That message was addressed to \$\{addressLabel\}/);
  /* And the retirement fires only on an actual MOVE. `changed` is also true when the
     unresolved state merely clears, so gating on it retired a valid retry whenever the reader
     clicked the place they were already in: Retry vanished, the send error was replaced with a
     sentence about a move that did not happen, and Enter minted fresh command ids that
     reposted every hop that had already landed. Found by a review arm, on a fix from two
     rounds earlier. */
  const select = between(dashboard, "const selectChannel = (", "const setChannelDialogError");
  /* An unfinished send survives only while the composer still promises ITS address. Two
     narrower questions were tried and both were wrong: `changed` also fires when the
     unresolved state merely clears, so clicking the place you were already in killed a valid
     Retry; and comparing the place being left called a `?c=` heal into a different channel a
     no-op, leaving a retry pointed somewhere the box no longer names. Review arms found both.
     ~~`next !== activeChannelId`~~, ~~`next !== previousPlace`~~. */
  assert.match(
    select,
    /const addressMoved = composerIntent !== null &&\s*\n\s*composerIntent\.placementChannelId !== next;/,
  );
  assert.match(select, /if \(addressMoved && composerIntent !== null\) \{/);
});

test("a page fetched before a post landed does not drop that post", () => {
  /* A channel click starts a fresh page and does not cancel a send in flight. That page was
     requested before the post committed, so it cannot carry it, and replacing the list
     wholesale dropped a row the new screen should show: a message posted in a channel and
     read from all-signals appeared, vanished, and came back on the next poll. Found by a
     review arm. */
  const load = between(dashboard, "const loadSignals = async (", "const refreshLatestSignals");
  /* ~~cleared as the request goes out~~: that dropped a row posted BEFORE the request and not
     yet visible to the read replica, which is the case this set exists for. A review arm found
     it. What keeps another channel's row out is the same question the screen asks. */
  assert.doesNotMatch(load, /postedSinceReset = new Set<string>\(\);/);
  /* The record holds the ROW, not only the id: a channel move empties `signals`, so coming
     back before the replica caught up an id-only record had nothing left to put back. A review
     arm found that. ~~`signals.filter((row) => postedSinceReset.has(row.id) && …)`~~. */
  assert.match(
    load,
    /prunePostedRows\(\);[\s\S]{0,900}?const arrivedWhileFetching = \[\.\.\.postedSinceReset\.values\(\)\]\s*\n\s*\.map\(\(entry\) => entry\.row\)\s*\n\s*\.filter\(\(row\) =>\s*\n\s*!fetched\.has\(row\.id\) && rowShowsOnScreen\(row\) &&\s*\n\s*\(newestFetched === "" \|\| row\.createdAt >= newestFetched\)\)/,
  );
  /* AND NEWER THAN THE PAGE. The grace bounds how long a row may stand in; it does not say
     WHERE it belongs, and replica lag and a page roll share every other bit. A rolled-off row
     is older than the page's newest and was being painted above rows newer than it. Both
     timestamps are the server's, so the question is answerable rather than guessed. Both arms
     found it; it is not lost, it is in history where Load older fetches it. */
  assert.match(load, /const newestFetched = page\.rows\[0\]\?\.createdAt \?\? "";/);
  /* The record has a bound in TIME and in SPACE. Without the first, a row that fell off the
     first page of its channel was re-prepended as the newest message every time the reader
     came back, and the map grew for the life of the tab. Without the second, a message posted
     in one workspace was painted into another workspace's feed, which no query of that
     workspace had returned. Both arms, on the fix from the round before. */
  assert.match(dashboard, /const POSTED_ROW_GRACE_MS = 30_000;/);
  const prune = between(dashboard, "const prunePostedRows = (", "\n    };");
  assert.match(prune, /const cutoff = Date\.now\(\) - POSTED_ROW_GRACE_MS;/);
  assert.match(prune, /entry\.at < cutoff \|\| entry\.workspaceId !== activeWorkspaceId/);
  const open = between(dashboard, "const keepShell = app.dataset.state", "if (keepShell) renderChannel");
  assert.match(open, /postedSinceReset\.clear\(\);/, "a workspace change empties the record");
  assert.match(load, /\.sort\(\(a, b\) => b\.createdAt\.localeCompare\(a\.createdAt\)\);/,
    "the feed is newest-first, so the rows put back must be too");
  assert.match(load, /forgetFetchedPostedIds\(page\.rows\);/);
  assert.match(load, /signals = \[\.\.\.arrivedWhileFetching, \.\.\.page\.rows\];/);
  /* And the send is what records them, so only rows this browser posted are kept. */
  const applied = between(dashboard, "const visible = posted.filter(showsOnScreen);", "clearComposerDraft();");
  assert.match(
    applied,
    /for \(const row of visible\) \{\s*\n\s*postedSinceReset\.set\(row\.id, \{ row, workspaceId, at: Date\.now\(\) \}\);/,
  );
  /* The FAILURE path prepends rows too, and only the success path was recording them, so a
     partial failure during a channel click lost the hop that had landed. */
  const failedRows = between(dashboard, "const visibleOnFailure = posted.filter", "const keptOnFailure");
  assert.match(
    failedRows,
    /for \(const row of visibleOnFailure\) \{\s*\n\s*postedSinceReset\.set\(row\.id, \{ row, workspaceId, at: Date\.now\(\) \}\);/,
  );
  /* An id leaves the set as soon as a fetched page carries it, so the set cannot grow for as
     long as the reader stays in one channel. Both arms raised that. */
  assert.match(dashboard, /const forgetFetchedPostedIds = \(rows: readonly Signal\[\]\): void =>/);
  const poll = between(dashboard, "const refreshLatestSignals = async (", "\n    };");
  assert.match(poll, /forgetFetchedPostedIds\(page\.rows\);/);
});

test("the channel commands send exactly the keys the command edge accepts", () => {
  /*
   * Generated from the edge's own `required` / `optional` arrays — the arrays its
   * `exactKeys` check reads — so adding a field to the edge fails this test rather than
   * leaving the browser sending a body the edge refuses.
   */
  const bodies: Record<string, string> = {
    channel_create: between(client, "export async function createChannel", "export async function renameChannel"),
    channel_rename: between(client, "export async function renameChannel", "export async function archiveChannel"),
    channel_archive: between(client, "export async function archiveChannel", "/** Reads receipts"),
  };
  for (const [kind, body] of Object.entries(bodies)) {
    const command = between(body, `kind: "${kind}"`, '"CommonSwarm did not');
    const { required, optional } = edgeKeys(kind);
    assert.ok(required.length > 0, `${kind}: the edge's required list must resolve`);
    const sent = sentKeys(command);
    for (const key of required) {
      assert.ok(sent.includes(key), `${kind} must send ${key}; it sends ${sent.join(", ")}`);
    }
    /* The other half of exactKeys: the edge refuses ANY key it did not list, so a key the
       browser sends that is on neither list is a 400 waiting to happen. */
    for (const key of sent) {
      if (key === "kind") continue;
      assert.ok(
        required.includes(key) || optional.includes(key),
        `${kind} sends ${key}, which the edge does not accept`,
      );
    }
    for (const key of optional) {
      /* An optional key is sent only when it has a value. Sending it as null would make the
         browser's body a different shape from an installed client's for no reason. */
      assert.match(
        command,
        new RegExp(`\\.\\.\\.\\([^)]*\\?\\s*\\{\\}\\s*:\\s*\\{ ${key} \\}\\)`),
        `${kind}: ${key} must be sent only when it has a value`,
      );
    }
  }
  /* Byte-exact against the suite that runs these bodies against a real edge. */
  assert.ok(serverSuite.includes('kind: "channel_create"'), "server suite anchor");
  assert.ok(serverSuite.includes('{ kind: "channel_create", slug }'), "server suite create body");
  assert.ok(serverSuite.includes('kind: "channel_archive"'), "server suite archive body");
  assert.ok(serverSuite.includes("channel_archive takes channel_id"), "server suite field message");
});

test("post_signal's chat keys each travel in their own group", () => {
  /*
   * The whole compatibility argument of the schema lane, on this side of the wire:
   * `modernKeys` is an all-or-nothing pair every installed client sends, so folding a new
   * optional key into it returns 400 on every post. Each chat key is spread on its own test
   * here, and a body that sends none is byte-identical to the one this app sent before.
   */
  const helper = between(client, "export async function postBrowserSignal", "/** Best-effort command write");
  for (const [field, wire] of [
    ["channel", "channel"],
    ["threadRootId", "thread_root_id"],
    ["broadcastToChannel", "broadcast_to_channel"],
  ]) {
    assert.match(
      helper,
      new RegExp(
        `\\.\\.\\.\\(placement\\.${field} === undefined[\\s\\S]{0,120}?\\?\\s*\\{\\}\\s*:\\s*\\{ ${wire}:`,
      ),
      field,
    );
  }
  assert.match(helper, /placement: BrowserSignalPlacement = \{\}/);
  /* The unchanged four keys are still unconditional, so an empty placement produces the
     body an installed client sends. */
  for (const key of ["to_user_id:", "to_agent_principal_id:", "in_reply_to: null", "about: null"]) {
    assert.ok(helper.includes(key), key);
  }
});

test("channel refusals show the server's sentence and the app reads no message", () => {
  const command = between(client, "async function channelCommand(", "export async function createChannel");
  assert.match(command, /throw new Error\(channelRefusalMessage\(status, body, fallback\)\)/);
  /* D-053: a message is presentation. Nothing here may branch on one. */
  assert.doesNotMatch(command, /body\.message\s*[=!]==?\s*"/);
  assert.doesNotMatch(command, /message\.(includes|match|startsWith|indexOf)/);
  assert.doesNotMatch(client, /channelRefusalMessage[^;]*\.includes\(/);
  const dialog = between(dashboard, "const submitChannelCreate = async (", "const submitChannelRename");
  assert.match(dialog, /setChannelDialogError\(readableError\(error\)\)/);
});

test("archiving is a second press, because nothing un-archives it", () => {
  const archive = between(dashboard, "const submitChannelArchive = async (", "for (const button of all<HTMLButtonElement>(\"[data-channel-place]\")");
  assert.match(archive, /if \(channelArchiveArmed !== channel\.channelId\)/);
  assert.match(archive, /Press again to confirm/);
  assert.match(archive, /Its messages still read/);
  /* The named bound: the reserved slug list is the edge's, and the archived channel's
     messages stay readable in the view this sentence names. */
  assert.ok(RESERVED_CHANNEL_SLUGS.includes("all-signals"));
  assert.ok(CHANNEL_SLUG_MAX > 0);
});

/**
 * The permission claim, in one place, so the sweep and the constants test refuse the same
 * sentences. "cannot read" is in it because a review arm found exactly that sentence: the
 * app told a reader a channel might be one they cannot read, and no such channel exists.
 */
const PRIVACY_CLAIM =
  /\bprivate\b|\bsecret\b|\bencrypted\b|\bonly\b[^.]{0,40}\b(see|sees|read|reads)\b|no one else|cannot read|can(no|')t read|not allowed to (see|read)|hidden from/i;

test("no channel copy in the dashboard implies privacy, and none uses an em-dash", () => {
  /*
   * BOUND, stated and widened after a review arm named what the first version could not see.
   * It now reads BOTH double-quoted and backtick strings in the eight script surfaces below,
   * AND the two pieces of Astro markup this lane added (the composer's reply bar and the
   * channel dialog), AND the composer's own refusal sentences.
   *
   * What it still cannot see, named rather than implied: a channel `purpose`, which a member
   * types and the head renders verbatim. No source sweep can constrain that, and nothing in
   * this product should: it is the member's own words about their own channel.
   */
  const surfaces = [
    "const renderChannelHead = (",
    "const renderUnknownChannel = (",
    "const renderChannelDialog = (",
    "const syncComposerPlacement = (",
    "const submitChannelArchive = async (",
    "const submitChannelCreate = async (",
    "const submitChannelRename = async (",
    "const selectChannel = (",
  ];
  const blocks = surfaces.map((anchor) => [anchor, between(dashboard, anchor, "\n    };")] as const);
  blocks.push([
    "channel dialog (markup)",
    between(dashboard, '<dialog\n    class="dashboard__channel-dialog"', "</dialog>"),
  ]);
  blocks.push([
    "composer refusals",
    between(dashboard, "if (unknownChannelId !== null) {\n        /* The hidden composer", "const recipients ="),
  ]);
  let checked = 0;
  for (const [anchor, rawBlock] of blocks) {
    /* Comments first. This repo keeps retired wording and reasoning beside the code, and both
       legitimately contain em-dashes and the word "private". What is being swept is the copy
       a reader can see, which is the string literals. */
    const block = rawBlock
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const strings = [
      ...[...block.matchAll(/"([^"\\]{12,})"/g)].map((match) => match[1]!),
      ...[...block.matchAll(/`([^`\\]{12,})`/g)].map((match) => match[1]!),
    ];
    for (const value of strings) {
      checked += 1;
      assert.doesNotMatch(value, PRIVACY_CLAIM, `${anchor}: ${value}`);
      assert.doesNotMatch(value, /—/, `${anchor}: em-dash in ${value}`);
    }
  }
  /* A positive control on the sweep itself: a sweep that found no strings would pass in
     silence, which is the confident zero this project keeps measuring. */
  assert.ok(checked >= 20, `the sweep must actually read strings; it read ${checked}`);
});

test("the unresolved-channel copy names no permission the product does not have", () => {
  /*
   * Every member of a workspace reads every channel in it. So a ?c= that resolves to nothing
   * has exactly two honest causes: the id names no channel HERE, or the channel list did not
   * load. It is never "a channel you may not read", and an earlier version of this lane said
   * exactly that.
   */
  const channels = readFileSync(join(siteRoot, "src", "lib", "channels.ts"), "utf8");
  const block = between(channels, "export const unknownChannelText", "export const channelRefusalMessage");
  for (const value of [...block.matchAll(/`([^`\\]+)`/g)].map((match) => match[1]!)) {
    assert.doesNotMatch(value, PRIVACY_CLAIM, value);
  }
  assert.match(block, /Every channel in a workspace is readable by every member of it/);
  assert.match(block, /channelListFailed\s*\?/, "the failed-list case is a case, not a guess");
  /* And the name of the unfiltered view inside those sentences is the constant. */
  assert.match(block, /\$\{ALL_SIGNALS_SLUG\}/);
  assert.doesNotMatch(block, /all-signals/, "the slug is interpolated, never typed");
});

test("an unresolved channel has no composer, and a submit into one is refused", () => {
  /* The composer was reachable in that state, and a post from it went to the unfiltered feed
     while the head said Channel not found; renderFeed then discarded the pending row, so the
     writer saw nothing at all. Found by a review arm. Two controls: the affordance is gone,
     and the rule holds without it. */
  const show = between(dashboard, 'const composer = one<HTMLFormElement>("[data-composer]");', "app.dataset.channelView = name;");
  assert.match(show, /composer\.hidden = unknownChannelId !== null \|\|/);
  const submit = between(
    dashboard,
    'one<HTMLFormElement>("[data-composer]")?.addEventListener("submit"',
    "const workspaceId = activeWorkspaceId;",
  );
  assert.match(submit, /if \(unknownChannelId !== null\) \{/);
  assert.match(submit, /there is nowhere to post/);
  assert.match(submit, /return;/);
});

test("no view but the feed leaves a channel marked current in the rail", () => {
  /* Files and Brain are not a channel. The channel buttons carry no data-workspace-view on
     purpose, so activateWorkspaceView's own loop never reached them and the rail claimed a
     current channel while the head said Files. Found by a review arm. */
  const activate = between(dashboard, "const activateWorkspaceView = (", "const closeConnect =");
  assert.match(
    activate,
    /if \(view !== "signals"\) \{\s*for \(const button of all<HTMLButtonElement>\("\[data-channel-place\]"\)\) \{\s*button\.removeAttribute\("aria-current"\);/,
  );
});

test("the name of the unfiltered view is typed in exactly one place, and that place is a storage key", () => {
  /*
   * Generated everywhere a reader sees it: the rail, the head, the phone control, the empty
   * state, the unresolved-channel sentences. The single exception is the composer draft's
   * storage key segment, which names drafts already saved in readers' browsers and must NOT
   * follow the constant: doing so would orphan every saved draft the day it changed.
   *
   * BOUND: comments are stripped first. This repo keeps retired wording in comments on
   * purpose, and a sweep that failed on its own doctrine would be deleted rather than fixed.
   */
  const code = dashboard
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const hits = [...code.matchAll(/all-signals/g)];
  assert.equal(hits.length, 1, `all-signals is typed ${hits.length} times outside comments`);
  assert.match(code, /const COMPOSER_DRAFT_SCOPE = "all-signals";/);
  /* And the markup builds its three from the constant. */
  assert.match(dashboard, /<span>\{ALL_SIGNALS_SLUG\}<\/span>/);
  assert.match(dashboard, /data-channel-name tabindex="-1">\{channelLabel\(ALL_SIGNALS_SLUG\)\}<\/h1>/);
  assert.match(dashboard, /<span data-channel-switch-label>\{channelLabel\(ALL_SIGNALS_SLUG\)\}<\/span>/);
  /* ~~COMPOSER_STREAM~~ renamed with the vocabulary: "stream" is the wire's word for the
     event log and this lane retired it from the app. */
  assert.doesNotMatch(code, /COMPOSER_STREAM/);
});
