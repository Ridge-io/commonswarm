/*
 * Mutation harness for lane/composer-to-field. Not shipped: run from the worktree root.
 *
 *   node docs/evidence/2026-09-05-composer-to/mutate.mjs
 *
 * Each entry breaks ONE thing a test claims to defend and requires the named test file to go
 * red and then green again when the file is restored. A control that cannot fail is not a
 * control, and a control that fails for the wrong reason is not one either, so every entry
 * carries the text its failure must contain.
 *
 * THAT TEXT IS AN ASSERTION, NEVER A TEST TITLE. A review arm found several entries matching
 * the title of the file's browser test, which every failure of that file prints: the harness
 * could not tell a wrong reason from the named one. Each `expected` below is the assertion
 * message or the exact value the mutation moves.
 *
 * Entries marked `rebuild` change the dashboard, which the browser observer reads out of
 * `site/dist`. Those rebuild the site between the mutation and the run; the source-reading
 * observers do not need it.
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

const DASH = "site/src/components/app/LiveDashboard.astro";
const ADDR = "site/src/lib/composer-address.ts";
const CLIENT = "site/src/lib/commonswarm.ts";

const PURE = "site/src/lib/composer-address.test.mjs";
const FIELD = "site/src/components/app/composer-to-field.observer.test.ts";
const ADDRESSING = "site/src/components/app/composer-addressing.observer.test.ts";

/** [test file, source file, target, replacement, what the control defends, expected text] */
const mutations = [
  // ── the wake bound ────────────────────────────────────────────────────────────────────
  [PURE, ADDR,
    "export const NOTIFIED_POSITION = SCALAR_POSITION;",
    "export const NOTIFIED_POSITION = 1;",
    "the wake follows the position the scalar column is filled from",
    "only the recipient at the notified position is woken"],
  [PURE, ADDR,
    'return front !== undefined && front.kind === "agent" ? front : null;',
    "return front ?? null;",
    "a person at the front wakes nobody, however many agents follow",
    "only the recipient at the notified position is woken"],
  [PURE, ADDR,
    'notified === null ? "No agent is notified." : `${nameOf(notified)} is notified.`,',
    '"Everyone in To: is notified.",',
    "the note never claims more than one recipient is woken",
    "the note names who is notified"],

  // ── the cap ───────────────────────────────────────────────────────────────────────────
  [PURE, ADDR,
    "export const COMPOSER_TO_MAX = SIGNAL_RECIPIENT_MAX;",
    "export const COMPOSER_TO_MAX = 12;",
    "the composer's cap is the server's cap",
    "the composer's cap is the server's cap"],
  [PURE, ADDR,
    "    if (recipients.length >= COMPOSER_TO_MAX) {\n      refused.push({ ...entity });\n      continue;\n    }",
    "    if (false) {\n      refused.push({ ...entity });\n      continue;\n    }",
    "a name past the cap is named rather than dropped in silence",
    "adding keeps order, adds nobody twice, and names what the cap refused"],

  // ── the set ───────────────────────────────────────────────────────────────────────────
  [PURE, ADDR,
    "    if (seen.has(key)) continue;",
    "    if (false) continue;",
    "nobody joins the set twice",
    "adding keeps order, adds nobody twice, and names what the cap refused"],
  [PURE, ADDR,
    "  const applied = new Set(input.applied.filter((key) => taggedKeys.has(key)));",
    "  const applied = new Set();",
    "a removed chip does not come back while its tag is still in the body",
    "a removed chip does not come back"],
  [PURE, ADDR,
    "  if (found === undefined) return [...current];",
    "  if (found === undefined) return [entity, ...current];",
    "promoting edits the set; it never addresses somebody new",
    "removing, promoting and pruning are the whole edit surface"],

  // ── the wire ──────────────────────────────────────────────────────────────────────────
  [FIELD, CLIENT,
    "    to_user_id: null,\n    to_agent_principal_id: null,\n    in_reply_to: null,",
    "    to_user_id: scalarRecipientFields(recipients).toUserId,\n" +
      "    to_agent_principal_id: scalarRecipientFields(recipients).toAgentPrincipalId,\n" +
      "    in_reply_to: null,",
    "the scalar pair travels null, because the edge refuses a body that also sets one",
    "directed body: `to` carries the set"],
  [FIELD, CLIENT,
    "    ...(recipients.length === 0 ? {} : { to: toWireRecipients(recipients) }),",
    "    ...({}),",
    "the To: set reaches the wire at all",
    "directed body: `to` carries the set"],
  [FIELD, CLIENT,
    "  return notifiedRecipient(recipients) !== null && !postAgentNote ? \"ask\" : \"note\";",
    "  return recipients.length > 0 && !postAgentNote ? \"ask\" : \"note\";",
    "the kind follows recipient 0, so a person in front does not wake the agent behind them",
    "signal_kind: a person in front makes this a note"],
  [FIELD, ADDR,
    "      `Only the ${positionWord(NOTIFIED_POSITION)} recipient is notified. ` +",
    '      "Only the first recipient is notified. " +',
    "the sentence about the front of the list is built from the index the code reads",
    "the note is generated from the cap and the wake position"],

  // ── the rendered row (these read site/dist, so they rebuild) ──────────────────────────
  [FIELD, DASH,
    "    const composerRecipients = (): ComposerRecipient[] => composerTo;",
    "    const composerRecipients = (): ComposerRecipient[] => [];",
    "the send reads the chips and nothing else",
    "afterSend: one signal, addressed to the chips", true],
  [FIELD, DASH,
    "        remembered: readRememberedComposerTo(),",
    "        remembered: [],",
    "the next message opens addressed to the last message's recipients",
    "afterReload: a reload opens addressed to", true],
  /* NOT CONTROLLED, and said so rather than claimed: breaking the WRITE of the remembered
     set changes nothing a reader sees, because `pagehide` flushes the live chips into the
     draft and the draft restores them. The READ above is controlled, and it is what proves
     the remembered set is used at all. */
  [FIELD, DASH,
    "        chip.dataset.composerToNotified = \"\";",
    "        void chip;",
    "the chip and the sentence agree about who is woken",
    "notifiedMark: the chip carrying the notified mark", true],
  [FIELD, DASH,
    "        chip.textContent = BROADCAST_CHIP_LABEL;",
    '        chip.textContent = "";',
    "a broadcast is named rather than shown as an empty row",
    "atRest: the row at rest is a named broadcast", true],
  [FIELD, DASH,
    "      cancelComposerToPass();\n      syncComposerAddress();\n      const workspaceId",
    "      const workspaceId",
    "a tag typed just before Enter is still a recipient",
    "taggedThenSentAtOnce: a tag typed just before Enter", true],
  [FIELD, DASH,
    "    const composerRosterKnown = (): boolean => agents.length > 0 || members.length > 0;",
    "    const composerRosterKnown = (): boolean => true;",
    "an empty roster is not read as a workspace with nobody in it",
    "empty-roster guard: the predicate that separates", true],
  [FIELD, ADDR,
    "  if (!input.rosterKnown || input.sending) return held;",
    "  if (input.sending) return held;",
    "nothing is committed against a roster that is not known yet",
    "the pass commits against an unknown roster", true],
  [PURE, ADDR,
    "  if (!input.rosterKnown || input.sending) return held;",
    "  if (!input.rosterKnown) return held;",
    "nothing moves the address while its own message is on the wire",
    "the address was rewritten mid-send"],
  [PURE, ADDR,
    "  `To: holds ${COMPOSER_TO_MAX} ${countNoun(COMPOSER_TO_MAX, \"recipient\")}, so ${\n    joinNames(names)\n  }",
    "  `To: holds ${COMPOSER_TO_MAX} ${countNoun(COMPOSER_TO_MAX, \"recipient\")}, so ${\n    \"somebody\"\n  }",
    "the over-cap notice names who did not fit",
    "adding keeps order, adds nobody twice, and names what the cap refused"],
  [FIELD, ADDR,
    "  const overCap = [...state.refused.map(nameOf), ...parsed.overflow];",
    "  const overCap = [...state.refused.map(nameOf)];",
    "a tag the parser gave up on is named, not dropped out of the message",
    "both ways a tag can be over the cap must reach the notice"],
  [PURE, ADDR,
    "  `${count} ${countNoun(count, \"recipient\")} left this workspace, so ${",
    "  `${count} recipients left this workspace, so ${",
    "the pruned count and its noun are built together",
    "a recipient the roster lost is reported"],
  [PURE, ADDR,
    "    announcedPrune: source === \"live\"\n      ? (input.announcedPrune ?? 0) + removed\n      : 0,",
    "    announcedPrune: 0,",
    "a recipient the roster lost is removed without a word about it",
    "a chip vanished from under the reader with no word"],
  [PURE, ADDR,
    "    announcedPrune: source === \"live\"\n      ? (input.announcedPrune ?? 0) + removed\n      : 0,",
    "    announcedPrune: (input.announcedPrune ?? 0) + removed,",
    "arriving in a workspace does not announce a prune the reader never saw",
    "arriving in a workspace announced an old prune"],
  [FIELD, ADDR,
    "    ? `Put ${name} ${front}, so ${name} is notified`\n    : `Put ${name} ${front}. No agent is notified while a person is ${front}`;",
    "    ? `Put ${name} ${front}, so ${name} is notified`\n    : `Put ${name} ${front}, so ${name} is notified`;",
    "a chip's own control never promises a wake a person cannot get",
    "personFirst: a person in front wakes nobody", true],
  [PURE, ADDR,
    "  const afterPromotion = notifiedRecipient(promoteComposerRecipient(current, entity));",
    "  const afterPromotion = entity;",
    "the chip label asks the same function the row asks",
    "chip label: promoting a person must not promise a wake"],
  [FIELD, ADDR,
    "  const chosen = input.live ?? input.draft;",
    "  const chosen = input.live;",
    "a draft's own address beats the set the last message went to",
    "removalSurvivesReload: a recipient removed by hand", true],
  [FIELD, DASH,
    "          syncComposerAddress();\n          /* AND A SENT MESSAGE IS NOT ONE BEING WRITTEN.",
    "          /* AND A SENT MESSAGE IS NOT ONE BEING WRITTEN.",
    "the send settles the address once its own message is off the wire",
    "the send never settles the address", true],
  [FIELD, DASH,
    "      restoreComposerOnEntry();\n      syncComposerAddress();",
    "      restoreComposerOnEntry();\n      syncComposerAddress();\n      syncComposerAddress();",
    "one pass owns the address, and nothing else calls it",
    "the pass is called from somewhere new", true],
  [FIELD, DASH,
    "      if (composerSending) return;\n      const entity = composerTo.find",
    "      const entity = composerTo.find",
    "the address is not editable while its own message is on the wire",
    "a chip can be edited while the message it addresses is being posted", true],
  [FIELD, DASH,
    "          : { to: stored.to ?? null, applied: stored.applied ?? [] },",
    "          : { to: null, applied: stored.applied ?? [] },",
    "a draft carries the set it was being written to, and the pass reads it",
    "afterReloadWithDraft: a saved draft's own tags", true],
  [FIELD, DASH,
    "          : { to: stored.to ?? null, applied: stored.applied ?? [] },",
    "          : { to: stored.to ?? null, applied: [] },",
    "a removal survives a reload, because the applied record travels with the draft",
    "removalSurvivesReload: a recipient removed by hand", true],
  [FIELD, ADDR,
    "  const front = positionWord(NOTIFIED_POSITION);",
    '  const front = "first";',
    "the chip label takes its position word from the wake index",
    "chip label position is not built from the constant"],
  [FIELD, DASH,
    "            to: composerTo,",
    "            ...(composerTo.length === 0 ? {} : { to: composerTo }),",
    "an emptied To: is stored as a broadcast the reader chose, not as a missing set",
    "broadcastSurvivesReload: an emptied To: is a broadcast", true],
  [PURE, ADDR,
    "  const recorded = chosen !== null && chosen.to !== null;",
    "  const recorded = chosen !== null && chosen.to !== null && chosen.to.length > 0;",
    "an emptied To: is READ BACK as the broadcast the reader chose",
    "an emptied To: came back addressed to last-sent"],
  [ADDRESSING, DASH,
    "          ? removeComposerRecipient(composerTo, entity)\n          : promoteComposerRecipient(composerTo, entity),",
    "          ? composerTo\n          : promoteComposerRecipient(composerTo, entity),",
    "the remove control removes the recipient",
    "Timed out waiting for an empty To: set", true],
  /* ── the five things round four left open, each driven through its own transition ────── */
  /* (1) a workspace switch loses a draft's address */
  [FIELD, ADDR,
    "  if (!input.rosterKnown || input.sending) return held;",
    "  if (input.sending) return held;",
    "a workspace switch keeps the draft's own address across the roster gap",
    "chipEditSurvivesSwitch: a chip edit made with nothing else", true],
  [FIELD, DASH,
    "      composerToLive = true;",
    "      composerToLive = composerTo.length > 0;",
    "an emptied To: stays empty rather than filling from what was stored",
    "afterSend: one signal, addressed to the chips", true],
  /* (2) a chip edit never reaches storage on its own, and a switch does not flush.
     ONE CONTROL for the two routes that reach the same write. The pass writes the pair on
     every live edit and the workspace switch flushes before it empties the box; either alone
     carries a chip edit across a switch, so a mutation of one is masked by the other. What
     nothing else can substitute for is the WRITE, so that is what this breaks. */
  [FIELD, DASH,
    "            to: composerTo,",
    "            ...({}),",
    "the stored draft carries the To: set at all",
    "afterReloadWithDraft: a saved draft's own tags", true],
  [FIELD, DASH,
    "        const addressChosen = composerToLive &&",
    "        const addressChosen = false &&",
    "an address the reader chose is a draft, even with nothing typed",
    "emptyBodyEditSurvivesSwitch: an address edited with nothing typed", true],
  [PURE, ADDR,
    "  return key(recipients) !== key(pruneComposerRecipients(remembered, known));",
    "  return key(recipients) !== key(remembered);",
    "a set arrival pruned is not stored as a set the reader chose",
    "a set that is only the remembered one, pruned, was stored as a choice"],
  /* (3) a roster prune during an in-flight send */
  [FIELD, DASH,
    "        sending: composerSending,",
    "        sending: false,",
    "the pass is told when the message it addresses is on the wire",
    "the pass is not told when a send is in flight"],
  /* (4) a tag refused by the cap cannot be re-added by making room */
  [PURE, ADDR,
    "    if (!refusedKeys.has(recipientKey(entity))) applied.add(recipientKey(entity));",
    "    applied.add(recipientKey(entity));",
    "a name the cap refused stays eligible, so making room adds it",
    "a name the cap refused was written off as applied"],
  [FIELD, ADDR,
    "    if (!refusedKeys.has(recipientKey(entity))) applied.add(recipientKey(entity));",
    "    applied.add(recipientKey(entity));",
    "making room on the row is the way back from a refusal",
    "capAfterRoom: a refused name did not join the set", true],
  /* (5) the notified mark answers for itself rather than through another claim */
  [FIELD, DASH,
    "      if (notified !== null && recipientKey(notified) === recipientKey(entity)) {",
    "      if (notified !== null && recipientKey(notified) !== recipientKey(entity)) {",
    "the mark goes on the recipient the sentence names, and on no other",
    "notifiedMark: the chip carrying the notified mark", true],
];

const buildSite = () => run("npm", ["--prefix", "site", "run", "build"], { cwd: process.cwd() });

const runTest = async (file) => {
  try {
    const { stdout } = await run("node", ["--import", "tsx", "--test", file], {
      cwd: process.cwd(),
      maxBuffer: 40 * 1024 * 1024,
    });
    return { ok: true, output: stdout };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
};

const rows = [];
let failures = 0;

/* Baseline first: every named test file must be GREEN before anything is broken, or a red
 * below would say nothing about the mutation. */
await buildSite();
for (const file of [...new Set(mutations.map(([test]) => test))]) {
  const result = await runTest(file);
  rows.push(`BASELINE ${result.ok ? "green" : "RED"}  ${file}`);
  if (!result.ok) {
    failures += 1;
    console.error(result.output.slice(-2_000));
  }
}

for (const [testFile, sourceFile, target, replacement, defends, expected, rebuild] of mutations) {
  const original = readFileSync(sourceFile, "utf8");
  const count = original.split(target).length - 1;
  if (count !== 1) {
    rows.push(`UNRESOLVED (${count} matches)  ${defends}`);
    failures += 1;
    continue;
  }
  writeFileSync(sourceFile, original.replace(target, replacement));
  try {
    if (rebuild) await buildSite();
    const broken = await runTest(testFile);
    const reached = !broken.ok && broken.output.includes(expected);
    rows.push(
      `${broken.ok ? "NOT CAUGHT" : reached ? "red" : "RED, WRONG REASON"}  ${defends}`,
    );
    if (!reached) {
      failures += 1;
      console.error(`${defends}\n${broken.output.slice(-1_500)}`);
    }
  } finally {
    writeFileSync(sourceFile, original);
  }
  if (rebuild) await buildSite();
  const restored = await runTest(testFile);
  rows.push(`  restored ${restored.ok ? "green" : "RED"}  ${testFile}`);
  if (!restored.ok) {
    failures += 1;
    console.error(restored.output.slice(-2_000));
  }
}

console.log(rows.join("\n"));
console.log(`\n${mutations.length} mutations, ${failures} problems`);
process.exit(failures === 0 ? 0 : 1);
