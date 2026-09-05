// Mutation harness for the chat-app-channels lane. Not shipped: run from the worktree root.
// Each entry names one control, breaks the thing it claims to defend, and requires the named
// test to go red and back to green.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);
const DASH = "site/src/components/app/LiveDashboard.astro";
const CH = "site/src/lib/channels.ts";
const FEED = "site/src/lib/signal-feed.ts";
const CLIENT = "site/src/lib/commonswarm.ts";
const OBS = "site/src/components/app/chat-channels.observer.test.ts";
const CHT = "site/src/lib/channels.test.mjs";

const mutations = [
  // ── site/src/lib/channels.test.mjs
  [CHT, CH, 'export const ALL_SIGNALS_SLUG = "all-signals";', 'export const ALL_SIGNALS_SLUG = "general";',
    "the unfiltered view's name is one the edge refuses"],
  [CHT, CH, "`${CHANNEL_SLUG_RULE_TEXT} ${RESERVED_CHANNEL_SLUG_TEXT}`", "`${CHANNEL_SLUG_RULE_TEXT}`",
    "every rule sentence the app shows is the edge's own"],
  [CHT, CH, "export const channelSubmitProblem = (raw: string): string | null =>\n  channelSlugProblem(raw);",
    "export const channelSubmitProblem = (raw: string): string | null => (raw ? null : null);",
    "the app refuses a name for exactly the reasons the edge does"],
  [CHT, CH, "  if (typeof message === \"string\" && message.trim() !== \"\") return message;",
    "  if (false) return String(message);",
    "a refusal shows the server's sentence"],
  [CHT, CH, "    .filter((channel) => channel.archivedAt === null)", "    .filter(() => true)",
    "the rail lists live channels in one order"],
  [CHT, CH, '"Every member of this workspace reads every channel, and messages in a channel expire the same way they do anywhere else. A channel is the address of a message, not who gets woken.";',
    '"Only the people in this channel see it. A channel is private, and messages expire, not who gets woken.";',
    "the three facts the design puts in the UI"],
  [CHT, CH, "export const channelNameHint = (): string =>\n  `${CHANNEL_SLUG_RULE_TEXT} ${RESERVED_CHANNEL_SLUG_TEXT}`;",
    'export const channelNameHint = (): string =>\n  "A channel name uses lowercase letters. Reserved names: all-signals.";',
    "the module imports its rules and does not restate them"],

  // ── site/src/components/app/chat-channels.observer.test.ts
  [OBS, DASH, '<h2 id="dashboard-channels-label">CHANNELS</h2>', '<h2 id="dashboard-channels-label">STREAMS</h2>',
    "the rail names channels"],
  [OBS, DASH, "  .dashboard__channel-switch {\n    display: none;\n  }", "  .dashboard__channel-switch {\n    display: flex;\n  }",
    "the phone reaches channels without a second standing header row"],
  [OBS, DASH, '      if (channelId !== null) query = query.eq("channel_id", channelId);', "      void channelId;",
    "the channel narrowing is the query's"],
  [OBS, DASH, "        const rowChannel = activeChannelId === null && signal.channelId !== null",
    "        const rowChannel = signal.channelId !== null",
    "all-signals shows every message and names the channel"],
  [OBS, DASH, "      input.placeholder = `Message ${channelLabel(channel.slug)}`;",
    '      input.placeholder = "What are you about to do?";',
    "the composer stamps the channel being read"],
  [OBS, DASH, "      if (unknownChannelId !== null) {\n        renderUnknownChannel();\n        return;\n      }",
    "      if (false) {\n        renderUnknownChannel();\n        return;\n      }",
    "a ?c= that names no readable channel never shows the unfiltered feed"],
  [OBS, DASH, "        const bootWorkspace =\n          workspaces.find((workspace) => workspace.id === requestedWorkspaceId) ??\n            workspaces[0]!;",
    "        const bootWorkspace = { id: requestedWorkspaceId ?? workspaces[0]!.id };",
    "the URL round-trips the workspace and the channel by id"],
  [OBS, CLIENT, '      ...(purpose === null || purpose === "" ? {} : { purpose }),', "      purpose,",
    "the channel commands send exactly the keys"],
  [OBS, CLIENT, "      ...(placement.channel === undefined || placement.channel === null\n        ? {}\n        : { channel: placement.channel }),",
    "      channel: placement.channel ?? null,",
    "post_signal's chat keys each travel in their own group"],
  [OBS, CLIENT, "    throw new Error(channelRefusalMessage(status, body, fallback));",
    '    throw new Error(String(body.message ?? "").includes("already") ? "taken" : fallback);',
    "channel refusals show the server's sentence"],
  [OBS, DASH, "      if (channelArchiveArmed !== channel.channelId) {", "      if (false) {",
    "archiving is a second press"],
  /* Mutated in renderChannelDialog, whose sentences NO other test pins: this is the only
     control standing between a privacy claim and the reader. An earlier version of this
     mutation hit a sentence the ?c= test also asserts, so the suite went red for the wrong
     reason and the sweep's own regex was never exercised. */
  [OBS, DASH, '"Archiving hides a channel from this list and refuses new messages. Nothing is deleted, and its messages still read.";',
    '"Archiving makes a channel private so only members can see it.";',
    "no channel copy in the dashboard implies privacy"],

  // ── round two: the four controls added after both review arms failed the first SHA
  [OBS, CH, "    : `No channel in this workspace has that id. It may belong to another workspace, or it may have been created after this link was made. Every channel in a workspace is readable by every member of it.`;",
    "    : `This link names a channel that is not in this workspace, or one you cannot read.`;",
    "the unresolved-channel copy names no permission"],
  [OBS, DASH, "        composer.hidden = unknownChannelId !== null ||\n          (name !== \"feed\" && name !== \"feed-empty\");",
    '        composer.hidden = name !== "feed" && name !== "feed-empty";',
    "an unresolved channel has no composer"],
  [OBS, DASH, '      if (view !== "signals") {\n        for (const button of all<HTMLButtonElement>("[data-channel-place]")) {\n          button.removeAttribute("aria-current");\n        }\n      }\n',
    "",
    "no view but the feed leaves a channel marked current"],
  [OBS, DASH, "              <span>{ALL_SIGNALS_SLUG}</span>", "              <span>all-signals</span>",
    "the name of the unfiltered view is typed in exactly one place"],

  // ── round three: the four controls added after the second SHA failed both arms
  [OBS, DASH, '        (forWorkspace !== null && forWorkspace !== workspaceId)\n',
    "        false\n",
    "the URL is written on every workspace open"],
  [OBS, DASH, "        applyChannelFromUrl(selected.id);\n        syncChannelUrl();",
    "        applyChannelFromUrl(selected.id);",
    "the URL is written on every workspace open"],
  [OBS, DASH, "      channels = next;\n      channelListFailed = false;",
    "      channels = next;",
    "the channel list flag follows the latest read"],
  [OBS, DASH, "        if (sampleMode) sampleSignals = [...posted, ...sampleSignals];\n",
    "",
    "a sample post joins the sample set"],
  [CHT, CH, '"Every member of this workspace reads every channel, and messages in a channel expire the same way they do anywhere else. A channel is the address of a message, not who gets woken.";',
    '"Every member of this workspace reads every channel. A channel is the address of a message, not who gets woken.";',
    "the three facts the design puts in the UI"],

  // ── round four: the three controls added after the third SHA failed both arms
  [OBS, DASH, "      for (const button of all<HTMLButtonElement>(\"[data-workspace-view]\")) {\n        if (button.dataset.workspaceView === \"signals\") button.setAttribute(\"aria-current\", \"page\");\n        else button.removeAttribute(\"aria-current\");\n      }\n      renderChannelRail();\n      renderChannelHead();\n",
    "      renderChannelRail();\n      renderChannelHead();\n      for (const button of all<HTMLButtonElement>(\"[data-workspace-view]\")) {\n        if (button.dataset.workspaceView === \"signals\") button.setAttribute(\"aria-current\", \"page\");\n        else button.removeAttribute(\"aria-current\");\n      }\n",
    "the workspace open leaves the rail's current mark"],
  [OBS, DASH, "      const generation = ++channelReadGeneration;\n      const current = (): boolean =>\n        generation === channelReadGeneration && version === requestVersion &&\n        workspaceId === activeWorkspaceId;",
    "      const current = (): boolean =>\n        version === requestVersion && workspaceId === activeWorkspaceId;",
    "only the newest channel read is applied"],
  [OBS, DASH, "      const channelGeneration = ++channelReadGeneration;\n      try {",
    "      try {",
    "only the newest channel read is applied"],
  [OBS, DASH, "        if (channelGeneration === channelReadGeneration) {\n          channels = nextChannels.value;\n          channelListFailed = nextChannels.failed;\n        }",
    "        channels = nextChannels.value;\n        channelListFailed = nextChannels.failed;",
    "only the newest channel read is applied"],

  // ── round six: the controls added after the fifth SHA failed both arms
  [OBS, DASH, "        const visible = posted.filter(showsOnScreen);", "        const visible = posted;",
    "a post belongs to the channel it was sent from"],
  [OBS, DASH, "      const placementChannelId = intent.placementChannelId;", "      const placementChannelId = freshPlacementChannelId;",
    "a post belongs to the channel it was sent from"],
  [OBS, DASH, "      closeChannelDialog();\n      one<SecretHoldingAgentConnect>(\"agent-connect\")?.clearPrompt(false);",
    "      one<SecretHoldingAgentConnect>(\"agent-connect\")?.clearPrompt(false);",
    "an auth change closes the channel dialog"],
  [OBS, DASH, "      if (unknownChannelId !== null && channelById(channels, unknownChannelId) !== null) {\n        selectChannel(unknownChannelId);\n        return;\n      }\n",
    "",
    "a later channel read gives an unresolved link one more chance"],

  // ── round seven: the controls added after the thread cut
  [OBS, DASH, "        const resumable = unsent && addressStillActive;", "        const resumable = unsent;",
    "an unfinished send is not resumed into a channel"],
  [OBS, DASH, "        if (retry && resumable) retry.hidden = false;", "        if (retry && unsent) retry.hidden = false;",
    "an unfinished send is not resumed into a channel"],
  [OBS, DASH, "        const arrivedWhileFetching = signals.filter(\n          (row) => postedSinceReset.has(row.id) && !fetched.has(row.id) && rowShowsOnScreen(row),\n        );\n        forgetFetchedPostedIds(page.rows);\n        signals = [...arrivedWhileFetching, ...page.rows];",
    "        signals = page.rows;",
    "a page fetched before a post landed does not drop that post"],
  [OBS, DASH, "        for (const id of visibleIds) postedSinceReset.add(id);\n", "",
    "a page fetched before a post landed does not drop that post"],

  // ── round nine: the controls added after the eighth SHA failed both arms
  [OBS, DASH, "      if (addressMoved && composerIntent !== null) {", "      if (composerIntent !== null) {",
    "an unfinished send is not resumed into a channel"],
  [OBS, DASH, "        for (const id of visibleFailureIds) postedSinceReset.add(id);\n", "",
    "a page fetched before a post landed does not drop that post"],
  [OBS, DASH, "        forgetFetchedPostedIds(page.rows);\n        const known = new Set(page.rows.map((signal) => signal.id));",
    "        const known = new Set(page.rows.map((signal) => signal.id));",
    "a page fetched before a post landed does not drop that post"],

  // ── round eleven: the controls added after the tenth SHA failed both arms
  [OBS, DASH, "        : { channel: placementChannel.slug };", "        : { channel: activeChannel()?.slug ?? \"\" };",
    "the composer stamps the channel being read"],
  [OBS, DASH, "      const addressMoved = next !== previousPlace;", "      const addressMoved = next !== activeChannelId;",
    "an unfinished send is not resumed into a channel"],
  [OBS, DASH, "!fetched.has(row.id) && rowShowsOnScreen(row),", "!fetched.has(row.id),",
    "a page fetched before a post landed does not drop that post"],
];

const testFor = (file) => file;
let failures = 0;
const rows = [];

for (const [testFile, target, from, to, name] of mutations) {
  const original = readFileSync(target, "utf8");
  if (!original.includes(from)) {
    rows.push(["ANCHOR-MISSING", name, target]);
    failures += 1;
    continue;
  }
  if (original.split(from).length !== 2) {
    rows.push(["ANCHOR-AMBIGUOUS", name, target]);
    failures += 1;
    continue;
  }
  writeFileSync(target, original.replace(from, to));
  let red = false;
  let redName = "";
  try {
    await run("node", ["--import", "tsx", "--test", testFor(testFile)], { cwd: process.cwd() });
  } catch (error) {
    red = true;
    redName = String(error.stdout ?? "")
      .split("\n")
      .filter((line) => line.startsWith("✖ ") && !line.includes("failing tests"))
      .join(" | ");
  } finally {
    writeFileSync(target, original);
  }
  let green = false;
  try {
    await run("node", ["--import", "tsx", "--test", testFor(testFile)], { cwd: process.cwd() });
    green = true;
  } catch {
    green = false;
  }
  const named = redName.toLowerCase().includes(name.toLowerCase().slice(0, 40));
  const verdict = red && green && named ? "PASS" : "FAIL";
  if (verdict === "FAIL") failures += 1;
  rows.push([verdict, name, red ? redName.slice(0, 120) : "(stayed green)"]);
}

for (const row of rows) console.log(row.join("  ::  "));
console.log(`\n${rows.length} mutations, ${failures} not discriminating`);
process.exit(failures === 0 ? 0 : 1);
