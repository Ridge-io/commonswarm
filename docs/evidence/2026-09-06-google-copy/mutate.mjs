/*
 * Mutation harness for the google-copy lane. Not shipped: run from the worktree root with
 * `node docs/evidence/2026-09-06-google-copy/mutate.mjs`.
 *
 * Each entry names one control, breaks the exact thing that control claims to defend, and
 * requires the named test to go RED and then back to GREEN when the file is restored. A
 * control that stays green under its own mutation is defending nothing.
 *
 * `rebuild` re-runs `npm run build` in site/ around the mutated run, for controls that read
 * `site/dist`. The controls that read the per-provider fixtures need no flag: that suite builds
 * its own three fixtures from source on every run.
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

const AP = "site/src/lib/auth-providers.ts";
const PRIV = "site/src/pages/privacy.astro";
const TERMS = "site/src/pages/terms.astro";
const DASH = "site/src/components/app/LiveDashboard.astro";
const BUTTONS = "site/src/components/auth/ProviderButtons.astro";
const PB = "site/src/components/auth/provider-buttons.observer.test.ts";
const SO = "site/src/components/app/app-signed-out.observer.test.ts";

const mutations = [
  // ── the sweep, in every provider state
  {
    test: PB,
    target: PRIV,
    from: "You sign in through ${entities}.",
    to: "You sign in through ${providers[0]?.legalEntity ?? \"\"}.",
    control: "sign-in copy names the providers this build renders, in every provider state",
    why: "the processor entry names ONE provider while the build renders two — the defect a review arm found on the previous SHA",
  },
  {
    test: PB,
    target: PRIV,
    from: "You sign in with ${doors}, you join a workspace",
    to: "You sign in with GitHub, you join a workspace",
    control: "sign-in copy names the providers this build renders, in every provider state",
    why: "a typed provider name in the privacy summary",
  },
  {
    test: PB,
    target: TERMS,
    from: "governed by them: today, ${entities}.",
    to: "governed by them: today, GitHub, Inc.",
    control: "sign-in copy names the providers this build renders, in every provider state",
    why: "a typed entity list in the terms third-party clause",
  },
  {
    test: PB,
    target: AP,
    from: '    legalEntity: "Google LLC",',
    to: '    legalEntity: "Google, Inc.",',
    control: "sign-in copy names the providers this build renders, in every provider state",
    why: "NEGATIVE CONTROL for the abbreviation guard: with Google's entity ALSO carrying a period, the guard must still keep both names in one sentence rather than let the split hide one",
    expectRed: false,
  },

  // ── the source control for copy the HTML sweep cannot see
  {
    test: PB,
    target: DASH,
    from:
      "        const choices = listSentence(renderedProviderNames());\n" +
      "        return choices\n" +
      "          ? `Email sign-in is busy right now. Sign in with ${choices}, or try email again in a little while.`\n" +
      '          : "Email sign-in is busy right now. Try email again in a little while.";',
    to: '        return "Email sign-in is busy right now. Use GitHub, or try email again in a little while.";',
    control: "no sign-in surface types a provider name into its markup or its script",
    why: "the exact /app rate-limit sentence a review arm found still saying GitHub",
  },

  // ── the guard on the sweep's own sentence boundary
  {
    test: PB,
    target: PB,
    from: '(?<!\\\\b(?:${SENTENCE_ABBREVIATIONS.join("|")})\\\\.)(?<=[.!?])\\\\s+',
    to: '(?<!\\\\b(?:${SENTENCE_ABBREVIATIONS.join("|")}))(?<=[.!?])\\\\s+',
    control: "a company abbreviation does not end a sentence, and a full stop still does",
    why: "the lookbehind without its period, which is inert and reads like a working guard",
  },

  // ── the helper that must never produce an empty enumeration
  {
    test: PB,
    target: AP,
    from: "  return listSentence([...providers.map((provider) => provider.name), EMAIL_SIGNIN_DOOR]);",
    to: "  return listSentence(providers.map((provider) => provider.name));",
    control: "every sentence-list helper reads as a sentence in every provider state",
    why: '"You sign in with , you join a workspace" on a build with no OAuth provider',
  },

  // ── the hand-written-control sweep
  {
    test: PB,
    target: DASH,
    from: '          <ProviderButtons buttonClass="dashboard__rail-add" />',
    to: '          <button class="dashboard__rail-add" type="button" data-signin-github>Sign in again</button>',
    control: "only ProviderButtons renders a sign-in button, apart from named debt",
    why: "a hand-written provider control put back on /app",
  },

  // ── the signed-out panel
  {
    test: SO,
    target: DASH,
    from:
      "        <ProviderButtons\n" +
      '          buttonClass="dashboard__button dashboard__button--secondary"\n' +
      '          listClass="dashboard__providers"\n' +
      "        >\n" +
      '          <div slot="before" class="dashboard__auth-divider" aria-hidden="true"><span>or</span></div>\n' +
      "        </ProviderButtons>\n",
    to: "",
    control: "signed-out /app onramp is cold-stranger, email-first, free, draft-legal",
    why: "the signed-out panel with no OAuth control at all",
  },
  {
    test: SO,
    target: DASH,
    from: '    for (const button of all<HTMLButtonElement>("[data-signed-out-onramp] [data-signin-provider]")) {',
    to: '    for (const button of all<HTMLButtonElement>("[data-member-reauth] [data-signin-provider]")) {',
    control: "signed-out /app onramp is cold-stranger, email-first, free, draft-legal",
    why: "the panel's handler bound to another panel's buttons — the loose assertion this replaced stayed green here",
  },
  {
    test: SO,
    target: BUTTONS,
    from: "          {provider.label}",
    to: "          {provider.name}",
    control: "the built signed-out panel offers generated provider buttons",
    why: "the built button label no longer the label the constant carries",
    rebuild: true,
  },
];

async function testRun(file) {
  try {
    const { stdout } = await run("node", ["--import", "tsx", "--test", file], {
      cwd: process.cwd(),
      maxBuffer: 64 * 1024 * 1024,
    });
    return { red: false, names: "", out: stdout };
  } catch (error) {
    const out = String(error.stdout ?? "");
    return {
      red: true,
      names: out
        .split("\n")
        .filter((line) => line.startsWith("✖ ") && !line.includes("failing tests"))
        .map((line) => line.replace(/^✖ /, "").replace(/ \(\d.*$/, ""))
        .filter((name, index, all) => all.indexOf(name) === index)
        .join(" | "),
      out,
    };
  }
}

async function build() {
  await run("npm", ["--prefix", "site", "run", "build"], {
    cwd: process.cwd(),
    maxBuffer: 64 * 1024 * 1024,
  });
}

const rows = [];
let failures = 0;

// BASELINE. Every mutated run below is read against this; without it a suite that is already
// red would make every mutation look discriminating.
await build();
for (const file of [PB, SO]) {
  const baseline = await testRun(file);
  rows.push([baseline.red ? "FAIL" : "PASS", `BASELINE ${file}`, baseline.red ? baseline.names : "green"]);
  if (baseline.red) failures += 1;
}

for (const mutation of mutations) {
  const expectRed = mutation.expectRed !== false;
  const original = readFileSync(mutation.target, "utf8");
  if (!original.includes(mutation.from)) {
    rows.push(["ANCHOR-MISSING", mutation.control, mutation.target]);
    failures += 1;
    continue;
  }
  if (original.split(mutation.from).length !== 2) {
    rows.push(["ANCHOR-AMBIGUOUS", mutation.control, mutation.target]);
    failures += 1;
    continue;
  }

  writeFileSync(mutation.target, original.replace(mutation.from, mutation.to));
  let mutated;
  try {
    if (mutation.rebuild) await build();
    mutated = await testRun(mutation.test);
  } finally {
    writeFileSync(mutation.target, original);
    if (mutation.rebuild) await build();
  }
  const restored = await testRun(mutation.test);

  const namedRed = mutated.names.includes(mutation.control);
  const verdict = expectRed
    ? mutated.red && namedRed && !restored.red
      ? "PASS"
      : "FAIL"
    : !mutated.red && !restored.red
      ? "PASS"
      : "FAIL";
  if (verdict === "FAIL") failures += 1;
  rows.push([
    verdict,
    `${expectRed ? "" : "NEGATIVE "}${mutation.control}`,
    mutation.why,
    mutated.red ? `RED: ${mutated.names}` : "stayed green",
    restored.red ? "DID NOT RESTORE" : "restored green",
  ]);
}

for (const row of rows) console.log(row.join("  ::  "));
console.log(`\n${mutations.length} mutations, ${failures} not discriminating`);
process.exit(failures === 0 ? 0 : 1);
