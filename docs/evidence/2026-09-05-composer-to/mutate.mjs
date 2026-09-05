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
    "        rememberComposerTo(recipients);",
    "        void recipients;",
    "the next message opens addressed to the last message's recipients",
    "afterReload: a reload opens addressed to", true],
  [FIELD, DASH,
    "        chip.dataset.composerToNotified = \"\";",
    "        void chip;",
    "the chip and the sentence agree about who is woken",
    "secondTag: a second tag adds rather than replacing", true],
  [FIELD, DASH,
    "        chip.textContent = BROADCAST_CHIP_LABEL;",
    '        chip.textContent = "";',
    "a broadcast is named rather than shown as an empty row",
    "atRest: the row at rest is a named broadcast", true],
  [FIELD, DASH,
    "      cancelComposerToPass();\n      applyComposerMentions();\n      const workspaceId",
    "      const workspaceId",
    "a tag typed just before Enter is still a recipient",
    "taggedThenSentAtOnce: a tag typed just before Enter", true],
  [FIELD, DASH,
    "    const composerRosterKnown = (): boolean => agents.length > 0 || members.length > 0;",
    "    const composerRosterKnown = (): boolean => true;",
    "an empty roster is not read as a workspace with nobody in it",
    "an empty roster is not read as a workspace with nobody in it", true],
  [FIELD, DASH,
    "      if (composerRosterKnown()) {\n        const pruned = pruneComposerRecipients(composerTo, composerRecipientKnown);",
    "      if (true) {\n        const pruned = pruneComposerRecipients(composerTo, composerRecipientKnown);",
    "the chips are not pruned against a roster that is not known yet",
    "the chips are pruned against a roster that is not known yet", true],
  [PURE, ADDR,
    "  `To: holds ${COMPOSER_TO_MAX} ${countNoun(COMPOSER_TO_MAX, \"recipient\")}, so ${\n    joinNames(names)\n  }",
    "  `To: holds ${COMPOSER_TO_MAX} ${countNoun(COMPOSER_TO_MAX, \"recipient\")}, so ${\n    \"somebody\"\n  }",
    "the over-cap notice names who did not fit",
    "adding keeps order, adds nobody twice, and names what the cap refused"],
  [FIELD, DASH,
    "        ...address.overflow,\n      ];",
    "      ];",
    "a tag the parser gave up on is named, not dropped out of the message",
    "both ways a tag can be over the cap must reach the notice", true],
  [PURE, ADDR,
    "  `${count} ${countNoun(count, \"recipient\")} left this workspace, so ${",
    "  `${count} recipients left this workspace, so ${",
    "the pruned count and its noun are built together",
    "a recipient the roster lost is reported"],
  [FIELD, DASH,
    "          composerToNotice = composerPrunedNotice(composerTo.length - pruned.length);",
    "          void composerPrunedNotice;",
    "a recipient the roster lost is removed without a word about it",
    "a recipient the roster lost is removed without a word about it", true],
  [FIELD, ADDR,
    "    ? `Put ${name} first, so ${name} is notified`\n    : `Put ${name} first. No agent is notified while a person is first`;",
    "    ? `Put ${name} first, so ${name} is notified`\n    : `Put ${name} first, so ${name} is notified`;",
    "a chip's own control never promises a wake a person cannot get",
    "personFirst: a person in front wakes nobody", true],
  [PURE, ADDR,
    "  const afterPromotion = notifiedRecipient(promoteComposerRecipient(current, entity));",
    "  const afterPromotion = entity;",
    "the chip label asks the same function the row asks",
    "chip label: promoting a person must not promise a wake"],
  [FIELD, DASH,
    "      restoreComposerToOnEntry();\n      restoreComposerDraft();\n      applyComposerMentions();",
    "      restoreComposerDraft();\n      restoreComposerToOnEntry();",
    "a saved draft's tags are on the row after a reload, not lifted in at send time",
    "afterReloadWithDraft: a saved draft's own tags", true],
  [FIELD, DASH,
    "        composerToApplied = [];\n        composerIntent = null;",
    "        composerIntent = null;",
    "the applied record is cleared when the body is gone, so a tag typed again addresses again",
    "the applied record is never cleared on success", true],
  [ADDRESSING, DASH,
    "          ? removeComposerRecipient(composerTo, entity)\n          : promoteComposerRecipient(composerTo, entity),",
    "          ? composerTo\n          : promoteComposerRecipient(composerTo, entity),",
    "the remove control removes the recipient",
    "rendered composer addresses several agents", true],
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
