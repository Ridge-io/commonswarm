import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { build } from "esbuild";
import { findChrome } from "./participant-rail.fixture.js";

/* Reached by site/package.json's recursive component observer-test glob.
 *
 * A hand-made node stub is not enough here: the pass walks a tree the SANITIZER built, and the
 * defects it must not have -- a control inside a fenced block, a control nested in a link, a cue
 * leaking across a <br> -- only exist in a real document. So the live message renderer and the
 * live linkifier both run in a browser. */

const run = promisify(execFile);
const componentDir = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(componentDir, "..", "..", "..");

/** One body carrying every case the gate has to separate. */
const BODY = [
  "There is a brain topic for commonswarm-roadmap now.",
  "The brain roadmap slipped, and made-up-topic is not a topic.",
  "Read shared-host before the next release.",
  "The ritual is `releases`, and [shared-host](https://example.com/shared-host) links out.",
  "Docs sit at https://example.com/api?topic=brain-how-to&v=2#shared-host today.",
  "Run `curl https://example.com/api?topic=commonswarm-roadmap` to check.",
  "Then `cswarm brain get shared-host` and `releases` are different cases.",
  "",
  "```sh",
  "cswarm brain get brain-how-to",
  "```",
].join("\n");

const TOPICS = [
  "brain-how-to",
  "commonswarm-roadmap",
  "shared-host",
  "releases",
  "roadmap",
  /* Legal under canonicalBrainTopic, and the reason the code-span rule is equality: a span
     that merely CONTAINED a name would put a control on "brain" and "get" inside a command. */
  "brain",
  "get",
];

interface Snapshot {
  clicked: string[];
  codeSpanUrlControlCount: number;
  codeSpanUrlText: string;
  commandSpanControls: string[];
  commandSpanText: string;
  loneSpanControls: string[];
  controlTopics: string[];
  controlWords: string[];
  controlsInsideAnchor: number;
  controlsInsidePre: number;
  firstControlTag: string;
  firstControlType: string;
  madeUpTopicIsPlainText: boolean;
  preText: string;
  proseRoadmapIsPlainText: boolean;
}

const snapshotPromise = (async (): Promise<Snapshot> => {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-brain-links-"));
  const fixture = join(directory, "index.html");
  const bundleOf = async (entry: string, globalName: string): Promise<string> => {
    const bundle = await build({
      absWorkingDir: siteRoot,
      bundle: true,
      entryPoints: [entry],
      format: "iife",
      globalName,
      platform: "browser",
      write: false,
    });
    const script = bundle.outputFiles[0]?.text;
    assert.ok(script, `${entry} must bundle for its browser fixture`);
    return script;
  };
  const markdownScript = await bundleOf("src/lib/message-markdown.ts", "MessageMarkdown");
  const linkScript = await bundleOf("src/lib/brain-links.ts", "BrainLinks");

  const html = `<!doctype html>
<html>
  <body>
    <div class="dashboard__message-markdown" data-message></div>
    <script>${markdownScript}</script>
    <script>${linkScript}</script>
    <script>
      const host = document.querySelector("[data-message]");
      const clicked = [];
      MessageMarkdown.setSanitizedMessageMarkdown(host, ${JSON.stringify(BODY)}, { headingOffset: 1 });
      const created = BrainLinks.linkifyBrainTopics(host, {
        topics: ${JSON.stringify(TOPICS)},
        open: (topic) => clicked.push(topic),
      });
      const controls = Array.from(host.querySelectorAll("[data-brain-link]"));
      const codeSpans = Array.from(host.querySelectorAll("code"));
      const curlSpan = codeSpans.find((span) => span.textContent.startsWith("curl "));
      const commandSpan = codeSpans.find((span) => span.textContent.startsWith("cswarm "));
      const loneSpan = codeSpans.find((span) => span.textContent === "releases");
      const spanControls = (span) =>
        span
          ? Array.from(span.querySelectorAll("[data-brain-link]")).map((c) => c.dataset.brainLink)
          : ["NO SUCH SPAN"];
      const first = controls[0];
      if (first) first.click();
      const snapshot = {
        clicked,
        created,
        codeSpanUrlControlCount: curlSpan
          ? curlSpan.querySelectorAll("[data-brain-link]").length
          : -1,
        codeSpanUrlText: curlSpan ? curlSpan.textContent : "",
        commandSpanControls: spanControls(commandSpan),
        commandSpanText: commandSpan ? commandSpan.textContent : "",
        loneSpanControls: spanControls(loneSpan),
        controlTopics: controls.map((control) => control.dataset.brainLink),
        controlWords: controls.map((control) => control.textContent),
        controlsInsideAnchor: host.querySelectorAll("a [data-brain-link]").length,
        controlsInsidePre: host.querySelectorAll("pre [data-brain-link]").length,
        firstControlTag: first ? first.tagName : "",
        firstControlType: first ? first.type : "",
        /* controls.length > 0 is load-bearing, not decoration: Array.every is vacuously true on
           an empty array, so without it a render that produced NO controls at all -- the feature
           entirely broken -- would satisfy every negative assertion below. A review arm found
           exactly that. */
        madeUpTopicIsPlainText: controls.length > 0
          && host.textContent.includes("made-up-topic")
          && controls.every((control) => control.textContent !== "made-up-topic"),
        preText: host.querySelector("pre").textContent,
        proseRoadmapIsPlainText: controls.length > 0
          && controls.every((control) => control.textContent !== "roadmap"),
      };
      document.documentElement.dataset.fixture = btoa(JSON.stringify(snapshot));
    </script>
  </body>
</html>`;

  try {
    await writeFile(fixture, html, "utf8");
    const chrome = await findChrome();
    const { stdout } = await run(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--single-process",
      "--no-zygote",
      "--allow-file-access-from-files",
      "--dump-dom",
      `file://${fixture}`,
    ], { maxBuffer: 10 * 1024 * 1024, timeout: 20_000, killSignal: "SIGKILL" });
    const encoded = stdout.match(/data-fixture="([^"]+)"/)?.[1];
    assert.ok(encoded, "headless Chrome must return the brain-link snapshot");
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Snapshot;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
})();

test("only the validated, gated mentions become controls in a real rendered message", async () => {
  const snapshot = await snapshotPromise;
  assert.deepEqual(
    snapshot.controlTopics,
    ["commonswarm-roadmap", "shared-host", "releases", "shared-host", "releases"],
    "bare slugs, the slug inside a quoted command, and each span that IS a one-word name",
  );
  assert.deepEqual(
    snapshot.controlWords,
    ["commonswarm-roadmap", "shared-host", "releases", "shared-host", "releases"],
  );
});

test("NEGATIVE CONTROL: a name that is not a topic stays plain text in the DOM", async () => {
  const snapshot = await snapshotPromise;
  assert.ok(snapshot.controlTopics.length > 0, "controls must exist for a negative to mean anything");
  assert.equal(
    snapshot.madeUpTopicIsPlainText,
    true,
    "made-up-topic is slug-shaped, so validation is the only thing that can keep it plain",
  );
});

test("a one-word topic stays prose no matter what words sit around it", async () => {
  const snapshot = await snapshotPromise;
  /* Line 2 of the body reads "The brain roadmap slipped": "roadmap" is a live one-word topic
     with the word "brain" immediately in front of it, in the same text node. Only a code span
     that IS the name admits a one-word topic, and this one is prose. An earlier revision of
     this fixture put "brain" on line 1 and the bare word on line 2, so the comment described a
     case the fixture did not contain -- the same class of defect this lane was failed for. */
  assert.ok(snapshot.controlTopics.length > 0, "controls must exist for a negative to mean anything");
  assert.equal(snapshot.proseRoadmapIsPlainText, true);
});

test("a code span must BE a one-word topic, not merely contain it", async () => {
  const snapshot = await snapshotPromise;
  /* "brain" and "get" are live one-word topics in this fixture. The span
     `cswarm brain get shared-host` contains both, and must offer neither: only the slug-shaped
     name in it links. A span-contains rule would drop controls into a command a reader copies. */
  assert.equal(snapshot.commandSpanText, "cswarm brain get shared-host");
  assert.deepEqual(snapshot.commandSpanControls, ["shared-host"]);
  /* The same word alone in its own span still links, so the rule is equality, not a ban. */
  assert.deepEqual(snapshot.loneSpanControls, ["releases"]);
});

test("a topic name inside a URL query or fragment is left alone, even inside code", async () => {
  const snapshot = await snapshotPromise;
  /* A code span marks a one-word name as a literal, so the whole URL is scanned with the gate
     open. The run must swallow "?", "=", "&" and "#" or a button lands inside a command a reader
     is meant to copy.

     Count the CONTROLS, not the text. textContent walks into a button and returns the same
     string either way, so a text-only assertion would pass with a button sitting in the middle
     of the command -- it would not reach the path it claims to test. */
  assert.equal(snapshot.codeSpanUrlControlCount, 0, "no control inside the curl command");
  assert.equal(
    snapshot.codeSpanUrlText,
    "curl https://example.com/api?topic=commonswarm-roadmap",
    "and the command still reads exactly as written",
  );
});

test("a fenced block keeps the exact text the author typed", async () => {
  const snapshot = await snapshotPromise;
  assert.equal(snapshot.controlsInsidePre, 0);
  assert.equal(snapshot.preText, "cswarm brain get brain-how-to");
});

test("a control is never nested inside a link", async () => {
  const snapshot = await snapshotPromise;
  assert.equal(snapshot.controlsInsideAnchor, 0);
});

test("a control is a real button and clicking it asks for that canonical topic", async () => {
  const snapshot = await snapshotPromise;
  assert.equal(snapshot.firstControlTag, "BUTTON");
  assert.equal(snapshot.firstControlType, "button");
  assert.deepEqual(snapshot.clicked, ["commonswarm-roadmap"]);
});

test("neither the agent paragraph nor the design brief re-types the separator set", () => {
  /* The doctrine is that a list the code enforces must not be typed a second time. AGENTS.md
     cannot import BRAIN_SLUG_SEPARATORS, so the paragraph names the constant instead of the
     characters. This is the drift guard: re-adding a hand-typed list turns it red. */
  const agents = readFileSync(
    join(componentDir, "..", "..", "..", "..", "AGENTS.md"),
    "utf8",
  );
  const paragraph = agents.slice(agents.indexOf("**Save the durable object, then name it.**"));
  const brainParagraph = paragraph.slice(0, paragraph.indexOf("\n\n"));
  assert.ok(brainParagraph.length > 0, "the paragraph must still be there to guard");
  assert.match(
    brainParagraph,
    /BRAIN_SLUG_SEPARATORS/u,
    "it must point at the constant that enforces the set",
  );
  assert.doesNotMatch(
    brainParagraph,
    /`-`(,| or)/u,
    "and must not re-type the separators; they would drift the moment the constant changed",
  );
  /* The brief is the other half of the claim family, and it hand-typed the same set. */
  const brief = readFileSync(
    join(componentDir, "..", "..", "..", "..", "docs", "design",
      "2026-09-04-BRAIN-LINKS-IN-SIGNALS.md"),
    "utf8",
  );
  assert.match(brief, /BRAIN_SLUG_SEPARATORS/u, "the brief must name the constant too");
  assert.doesNotMatch(brief, /`-`, `_`, `\.`/u, "and must not re-type the separators either");
});

test("the dashboard runs the pass after the sanitizer and opens the Brain panel", () => {
  const dashboard = readFileSync(join(componentDir, "LiveDashboard.astro"), "utf8");
  assert.match(
    dashboard,
    /setSanitizedMessageMarkdown\(markdown, signal\.body, \{ headingOffset: 1 \}\);[\s\S]{0,600}?linkifyBrainTopics\(markdown, \{/u,
    "the pass must run on the sanitized tree, not before it",
  );
  assert.match(
    dashboard,
    /brainTopics\(files, \(\) => ""\)\.map\(\(topic\) => topic\.topic\)/u,
    "the feed must derive its list from the same brainTopics the Brain panel opens",
  );
  /* A review arm found the pair above and below passing while the call site used a hardcoded
     list: nothing bound the derived names to the argument. This is that binding. */
  assert.match(
    dashboard,
    /linkifyBrainTopics\(markdown, \{\s*topics: brainTopicNames\(\),/u,
    "the call site must pass the derived list, not a literal one",
  );
  /* The click must RE-READ before it decides. A control is rendered from a snapshot, so
     deciding against that snapshot is what let a deleted topic keep a working-looking control.
     The outcome itself is pinned by brainLinkClickOutcome's unit tests; this pins the order. */
  const clickBody = dashboard.slice(
    dashboard.indexOf("const openBrainTopic"),
    dashboard.indexOf("const kindLabel"),
  );
  assert.ok(clickBody.length > 0, "openBrainTopic must still be there to guard");
  assert.match(
    clickBody,
    /const listIsFresh = await refreshBrainTopics\(true\);[\s\S]{0,600}?brainLinkClickOutcome\(/u,
    "a click must re-read the topic list before it decides what to open",
  );
  /* And it must hand that value over as the THIRD argument. Reading the list freshly and then
     passing a constant in its place would leave every assertion above green while the decision
     ran on a claim nothing established -- the same shape of hole as the fourth argument. Both
     positions are pinned by ONE match so their ORDER is pinned too, not just their presence. */
  assert.match(
    clickBody,
    /brainLinkClickOutcome\(\s*\n\s*topic,\s*\n\s*brainTopicNames\(\),\s*\n\s*listIsFresh,\s*\n\s*version === requestVersion && workspaceId === activeWorkspaceId,\s*\n\s*\);/u,
    "listIsFresh must be the third argument and the context comparison the fourth",
  );
  /*
   * CAPTURE BEFORE THE AWAIT, COMPARE AFTER -- the shape every other continuation in this file
   * uses, and the one openBrainTopic did not have. This is the WEAK form of the control and it is
   * deliberate: the decision itself is pure and pinned by brain-links.test.mjs
   * ("a click abandoned by a workspace switch opens nothing and says nothing"), which goes red if
   * the abandoned branch is removed. What a source assertion adds is the half a pure test cannot
   * reach -- that the CALL SITE actually feeds it the comparison rather than a constant. Driving
   * a real workspace switch through a live dashboard would need a backend the observer fixtures
   * do not have, and that gap is recorded in the brief's Bounds.
   */
  assert.match(
    clickBody,
    /const version = requestVersion;\s*\n\s*const workspaceId = activeWorkspaceId;[\s\S]*?await refreshBrainTopics\(true\)/u,
    "the click must capture requestVersion and activeWorkspaceId BEFORE it awaits",
  );
  assert.match(
    clickBody,
    /version === requestVersion && workspaceId === activeWorkspaceId,/u,
    "and must pass that comparison, not a constant, as contextIsCurrent",
  );
  /* Nothing rendered, nothing said, before the abandoned check. */
  assert.match(
    clickBody,
    /if \(outcome\.kind === "abandoned"\) return;[\s\S]{0,300}?renderBrain\(\);/u,
    "an abandoned click must return BEFORE the panel is rebuilt",
  );
  assert.doesNotMatch(
    clickBody.slice(0, clickBody.indexOf('if (outcome.kind === "abandoned") return;')),
    /setBrainNotice\(outcome/u,
    "and before any notice about it is written",
  );
  /* The serialization is the thing a review arm found broken: a plain in-flight boolean made the
     forced read a no-op whenever the cadence tick held the slot. createBrainTopicReader owns it
     now, and its behaviour is pinned by brain-links.test.mjs; this pins that the dashboard uses
     it rather than reintroducing a local flag. */
  assert.match(
    dashboard,
    /const brainTopicReader = createBrainTopicReader\(\{/u,
    "the dashboard must serialize reads through the tested reader",
  );
  assert.doesNotMatch(
    dashboard,
    /brainTopicRefreshInFlight/u,
    "the boolean in-flight guard let a click decide against a stale snapshot; it must not return",
  );
  /* A background read rebuilds NOTHING but the feed. An earlier revision rebuilt whichever panel
     was on screen -- the opposite of what its own comment promised, and the one case that costs a
     reader something (replaceChildren drops focus; setTopics can close a pane holding unsaved
     edits). Both panels are rebuilt on entry by activateWorkspaceView. */
  const readBody = dashboard.slice(
    dashboard.indexOf("const readBrainTopics"),
    dashboard.indexOf("const brainTopicReader"),
  );
  assert.ok(readBody.length > 0, "readBrainTopics must still be there to guard");
  assert.doesNotMatch(readBody, /renderFiles\(\)/u, "a background read must not rebuild Files");
  assert.doesNotMatch(readBody, /renderBrain\(\)/u, "a background read must not rebuild Brain");
  assert.match(readBody, /renderFeed\(\);/u, "it must still rebuild the feed, which carries links");
  /* Every early return must resolve FALSE, or the reader calls a list it never read "fresh". */
  assert.match(
    readBody,
    /workspaceId !== activeWorkspaceId\) return false;/u,
    "a read that bailed on a workspace switch must report NOT fresh",
  );
  assert.match(
    dashboard,
    /if \(sampleMode \|\| !activeWorkspaceId\) return false;/u,
    "and so must a read with nothing to read against",
  );
  /* The click owns rebuilding the panel it just sent the reader to -- but only once it knows the
     reader is still there, which is why the abandoned check sits between the two. */
  assert.match(
    clickBody,
    /const listIsFresh = await refreshBrainTopics\(true\);[\s\S]{0,700}?renderBrain\(\);/u,
    "the click must refresh the list it put on screen",
  );
  assert.match(
    dashboard,
    /outcome\.kind === "missing"[\s\S]{0,120}?setBrainNotice\(outcome\.message\)/u,
    "a missing topic must reach the reader as the notice, not as a download failure",
  );
  assert.match(
    dashboard,
    /void refreshBrainTopics\(false\);/u,
    "the feed tick must offer a bounded re-read so a deleted topic stops rendering a control",
  );
  assert.match(dashboard, /\.dashboard__brain-link \{/u, "the control must be styled");
});
