/** Reached by `npm --prefix site test` through the recursive component-observer glob. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

type ComposerArtifact = {
  builtClient: string;
  builtCss: string;
  builtDashboard: string;
  builtHtml: string;
  builtLimit: string;
  client: string;
  dashboard: string;
  sharedLimit: string;
};

const componentDirectory = fileURLToPath(new URL(".", import.meta.url));
const siteRoot = join(componentDirectory, "..", "..", "..");
const distRoot = join(siteRoot, "dist");

const read = (url: URL): string => readFileSync(url, "utf8");

const builtHtml = readFileSync(join(distRoot, "app", "index.html"), "utf8");

const builtAsset = (owner: string, pattern: RegExp, label: string): string => {
  const path = owner.match(pattern)?.[1];
  assert.ok(path, `artifact-reach: built /app does not reference ${label}`);
  const referenced = path.replace(/^\/+/, "");
  const relative = referenced.startsWith("_astro/") ? referenced : `_astro/${referenced}`;
  assert.match(relative, /^_astro\//, `artifact-reach: ${label} escaped dist/_astro`);
  return readFileSync(join(distRoot, relative), "utf8");
};

const builtDashboard = builtAsset(
  builtHtml,
  /<script type="module" src="([^"]*LiveDashboard[^"]*\.js)">/,
  "the LiveDashboard bundle",
);
const builtCss = builtAsset(
  builtHtml,
  /<link rel="stylesheet" href="([^"]*\/app\.[^"]*\.css)">/,
  "the app stylesheet",
);
const builtClient = builtAsset(
  builtDashboard,
  /from["']\.\/(commonswarm\.[^"']+\.js)["']/,
  "the commonswarm client bundle",
);
const builtLimit = builtAsset(
  builtDashboard,
  /from["']\.\/(signal-text\.[^"']+\.js)["']/,
  "the shared signal-text bundle",
);

const artifact: ComposerArtifact = {
  builtClient,
  builtCss,
  builtDashboard,
  builtHtml,
  builtLimit,
  client: read(new URL("../../lib/commonswarm.ts", import.meta.url)),
  dashboard: read(new URL("./LiveDashboard.astro", import.meta.url)),
  sharedLimit: read(
    new URL("../../../../supabase/functions/_shared/signal-text.ts", import.meta.url),
  ),
};

const withoutBlockComments = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/<!--[\s\S]*?-->/g, "");

const between = (
  source: string,
  start: string,
  end: string,
  label: string,
): string => {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(startAt, -1, `${label}: missing start anchor ${start}`);
  assert.notEqual(endAt, -1, `${label}: missing end anchor ${end}`);
  return source.slice(startAt, endAt);
};

const occurrences = (source: string, needle: string): number =>
  source.split(needle).length - 1;

const assertOrder = (
  source: string,
  first: string,
  second: string,
  label: string,
): void => {
  const firstAt = source.indexOf(first);
  const secondAt = source.indexOf(second);
  assert.ok(firstAt >= 0, `${label}: missing first action ${first}`);
  assert.ok(secondAt >= 0, `${label}: missing second action ${second}`);
  assert.ok(firstAt < secondAt, `${label}: ${first} must happen before ${second}`);
};

const assertComposerSprint = (value: ComposerArtifact): void => {
  const dashboard = withoutBlockComments(value.dashboard);
  const client = withoutBlockComments(value.client);
  const markup = between(
    dashboard,
    '<form class="dashboard__composer"',
    "</form>",
    "composer-markup",
  );
  const builtMarkup = between(
    value.builtHtml,
    '<form class="dashboard__composer"',
    "</form>",
    "built-composer-markup",
  );
  const submit = between(
    dashboard,
    'one<HTMLFormElement>("[data-composer]")?.addEventListener("submit"',
    'one<HTMLButtonElement>("[data-composer-retry]")?.addEventListener("click"',
    "composer-submit",
  );
  const failed = between(
    submit,
    "} catch (caught) {",
    "} finally {",
    "failed-send",
  );
  const sending = between(
    dashboard,
    "const setComposerSending =",
    "const restoreComposerDraft =",
    "sending-state",
  );
  const controls = between(
    dashboard,
    "const syncComposerControls =",
    "const setComposerSending =",
    "composer-controls",
  );
  const paste = between(
    dashboard,
    'one<HTMLTextAreaElement>("[data-composer-input]")?.addEventListener(\n      "paste"',
    'one<HTMLTextAreaElement>("[data-composer-input]")?.addEventListener(\n      "keydown"',
    "full-paste",
  );
  const resize = between(
    dashboard,
    "const resizeComposerInput =",
    "const setComposerStatus =",
    "autosize",
  );
  const textareaCss = between(
    dashboard,
    ".dashboard__composer textarea {",
    ".dashboard__composer textarea::placeholder",
    "autosize-css",
  );
  const sendCss = between(
    dashboard,
    ".dashboard__composer-send {",
    ".dashboard__composer-send:hover",
    "send-target",
  );
  const removeCss = between(
    dashboard,
    ".dashboard__mention-remove {",
    ".dashboard__mention-entity:focus-visible",
    "remove-target",
  );
  const picker = between(
    dashboard,
    "const renderMentionPicker =",
    "const resetComposer =",
    "combobox-open",
  );
  const pickerClose = between(
    dashboard,
    "const closeMentionPicker =",
    "const renderComposerAudience =",
    "combobox-close",
  );
  const draft = between(
    dashboard,
    "const COMPOSER_COUNTER_THRESHOLD",
    "const focusComposerOnEntry",
    "draft-scope",
  );
  const viewport = between(
    dashboard,
    "const syncDashboardViewport =",
    "const closeMentionPicker =",
    "viewport-containment",
  );
  const renderFeed = between(
    dashboard,
    'const renderFeed = (change: "history" | "latest" = "history")',
    "const syncConnectWorkspace =",
    "reader-scroll",
  );

  /* The build itself is part of the gate. These strings are in the emitted /app assets, not only
   * in source which Astro might fail to ship. */
  assert.match(builtMarkup, /maxlength="8000"/, "built-limit: /app must emit the 8,000 limit");
  assert.match(builtMarkup, /role="combobox"/, "built-combobox: /app must emit the combobox role");
  assert.match(
    builtMarkup,
    /aria-controls="dashboard-composer-mention-picker"/,
    "built-combobox: /app must connect the textarea to its listbox",
  );
  assert.match(builtMarkup, /data-composer-retry/, "built-retry: /app must emit an explicit retry");
  assert.match(
    value.builtDashboard,
    /commonswarm:composer-draft:/,
    "built-draft: the emitted client must contain the scoped draft store",
  );
  assert.match(
    value.builtDashboard,
    /composer-pending-/,
    "built-optimistic: the emitted client must contain the pending row path",
  );
  assert.match(
    value.builtDashboard,
    /--dashboard-viewport-height/,
    "built-viewport: the emitted client must apply visualViewport height",
  );
  assert.match(
    value.builtCss,
    /max-block-size:min\(40dvh,20rem\)/,
    "built-autosize: the emitted textarea must retain its 40dvh cap",
  );
  assert.match(value.builtLimit, /8e3/, "built-limit: the shared bundle must emit 8,000");

  /* A failed request restores the exact, untrimmed draft and the exact recipient snapshot. The
   * optimistic row is removed first, then the retry affordance is made visible. */
  assert.match(failed, /input\.value = rawBody;/, "failed-send-body: restore the exact body");
  assert.match(
    failed,
    /composerAudience = \{ \.\.\.audience \};/,
    "failed-send-audience: restore the exact audience snapshot",
  );
  assert.match(
    failed,
    /composerMention = mentions\[0\] \?\? null;/,
    "failed-send-audience: restore the exact mention chip",
  );
  assert.match(failed, /persistComposerDraft\(\);/, "failed-send-body: persist the restored draft");
  assert.match(
    failed,
    /setComposerStatus\(readableError\(caught\), "error"\);/,
    "failed-send-error: announce the rejection inline",
  );
  assert.match(failed, /retry\.hidden = false;/, "retry-path: reveal retry after rejection");
  assert.match(
    dashboard,
    /data-composer-retry[^]*?addEventListener\("click", \(\) => \{\s*one<HTMLFormElement>\("\[data-composer\]"\)\?\.requestSubmit\(\);/,
    "retry-path: retry must resubmit the restored form",
  );
  assertOrder(failed, "signals = signals.filter", "input.value = rawBody;", "failed-send-body");

  /* The in-flight flag gates a second submit before the single network seam is reached. Busy is
   * visible and announced through the same button that initiated the send. */
  assert.match(
    submit,
    /!input \|\|\s*composerSending \|\|\s*body === ""/,
    "double-submit: an in-flight submit must stop at the behavior gate",
  );
  assert.equal(
    occurrences(submit, "await postBrowserSignal("),
    1,
    "double-submit: the submit path must have one post seam",
  );
  assertOrder(submit, "setComposerSending(true);", "await postBrowserSignal(", "double-submit");
  assert.match(sending, /input\.readOnly = sending;/,
    "inflight-input-lock: lock editing without dropping textarea focus");
  assert.match(
    sending,
    /send\.dataset\.state = sending \? "posting" : "ready";/,
    "visible-busy: expose posting state to the spinner",
  );
  assert.match(
    sending,
    /send\.setAttribute\("aria-busy", "true"\)/,
    "visible-busy: announce the in-flight state",
  );
  assert.match(
    dashboard,
    /\.dashboard__composer-send\[data-state="posting"\] \.dashboard__composer-send-progress \{\s*display: block;/,
    "visible-busy: the posting state must show progress",
  );

  /* The pending row renders before the await. Acceptance replaces that row and advances the same
   * receipt cache from posting to accepted; neither phase may claim delivery. */
  assert.match(submit, /const pendingId = `composer-pending-\$\{intent\.commandId\}`;/,
    "optimistic-posting: use one stable pending row id");
  assert.match(
    submit,
    /deliveryReceiptCache\.set\(pendingId, \{ result: null, checkedAt: 0, phase: "posting" \}\);/,
    "optimistic-posting: pending row must use the receipt model",
  );
  assertOrder(submit, "signals.unshift(optimisticSignal);", "await postBrowserSignal(", "optimistic-posting");
  assertOrder(submit, 'renderFeed("latest");', "await postBrowserSignal(", "optimistic-posting");
  assert.match(
    submit,
    /deliveryReceiptCache\.set\(signal\.id, \{ result: null, checkedAt: 0, phase: "accepted" \}\);/,
    "optimistic-accepted: accepted response must stay in the receipt model",
  );
  const postingIndicator = between(
    client,
    "export function browserPostingDeliveryIndicator",
    "export function browserAcceptedDeliveryIndicator",
    "posting-claim",
  );
  const acceptedIndicator = between(
    client,
    "export function browserAcceptedDeliveryIndicator",
    "export async function postBrowserSignal",
    "accepted-claim",
  );
  assert.match(
    postingIndicator,
    /This is still in progress; delivery is not confirmed yet\./,
    "posting-not-delivered: posting copy must state what is not established",
  );
  assert.match(
    acceptedIndicator,
    /Accepted by CommonSwarm\. The delivery receipt is loading; delivery is not confirmed yet\./,
    "accepted-not-delivered: acceptance must not claim delivery",
  );
  assert.doesNotMatch(
    acceptedIndicator,
    /label:\s*"Delivered"/,
    "accepted-not-delivered: accepted is not delivered",
  );
  assert.match(value.builtClient, /delivery is not confirmed yet/,
    "built-claim: emitted receipt copy must deny unconfirmed delivery");

  /* One shared constant owns the field, counter, persistence cap, and send gate. Programmatic
   * setRangeText deliberately bypasses native maxlength so a large paste remains whole and gets a
   * visible, firm explanation instead of silent truncation. */
  assert.match(
    value.sharedLimit,
    /export const SIGNAL_BODY_MAX = 8_000;/,
    "shared-limit: the authority must remain 8,000",
  );
  assert.match(
    dashboard,
    /import \{ SIGNAL_BODY_MAX \} from "\.\.\/\.\.\/\.\.\/\.\.\/supabase\/functions\/_shared\/signal-text";/,
    "shared-limit: dashboard must import the authority",
  );
  assert.match(markup, /maxlength=\{SIGNAL_BODY_MAX\}/,
    "shared-limit: textarea must consume the authority");
  assert.match(draft, /COMPOSER_DRAFT_STORAGE_MAX = SIGNAL_BODY_MAX \* 2;/,
    "full-paste: the local draft cap must retain a useful over-limit paste");
  assert.match(paste, /event\.preventDefault\(\);/, "full-paste: replace native truncation");
  assert.match(
    paste,
    /input\.setRangeText\(\s*pasted,\s*input\.selectionStart/,
    "full-paste: insert every pasted character",
  );
  assert.doesNotMatch(paste, /pasted\.(?:slice|substring)/,
    "full-paste: pasted text must not be cut to the limit");
  assert.match(controls, /const remaining = SIGNAL_BODY_MAX - length;/,
    "shared-limit: counter must use the authority");
  assert.match(controls, /const overLimit = length > SIGNAL_BODY_MAX;/,
    "shared-limit: send gate must use the authority");
  assert.match(controls, /send\.disabled = composerSending \|\| empty \|\| overLimit;/,
    "shared-limit: over-limit input must be unsendable");
  assert.match(dashboard, /\.dashboard__composer-count\[data-state="firm"\] \{\s*color: var\(--danger\);/,
    "firm-counter: the limit state must be visually firm");

  /* JS follows scrollHeight without a second ceiling. CSS owns the viewport-relative cap and
   * turns excess height into internal textarea scrolling. */
  assert.match(resize, /input\.style\.blockSize = `\$\{input\.scrollHeight\}px`;/,
    "autosize-max: autosize must follow content height");
  assert.doesNotMatch(resize, /Math\.min|144/,
    "autosize-max: JS must not bring back the old 144px ceiling");
  assert.match(textareaCss, /max-block-size: min\(40dvh, 20rem\);/,
    "autosize-max: CSS must cap growth at 40dvh");
  assert.match(textareaCss, /overflow-y: auto;/,
    "autosize-scroll: overflow must scroll inside the textarea");
  assert.doesNotMatch(dashboard, /syncComposerClearance|--composer-height/,
    "autosize-clearance: the separate composer grid row must not be reserved a second time");
  assert.match(dashboard, /\.dashboard__feed\s*\{[^}]*padding: 0 0 var\(--s-3\);/,
    "autosize-clearance: the transcript keeps only its normal 12px bottom rhythm");

  /* 390x430 is inside both mobile conditions. visualViewport writes 430px to the product shell,
   * the frame consumes that exact height, and the channel grid keeps the composer in its auto row
   * instead of placing it below the usable viewport. */
  const viewportWidthRem = 390 / 16;
  const viewportHeightRem = 430 / 16;
  assert.ok(viewportWidthRem <= 52 && viewportHeightRem <= 36,
    "viewport-containment: 390x430 must exercise the short mobile branch");
  assert.match(viewport, /window\.visualViewport\?\.height \?\? window\.innerHeight/,
    "viewport-containment: measure the usable viewport");
  assert.match(viewport, /--dashboard-viewport-height/,
    "viewport-containment: publish the measured height");
  assert.match(viewport, /visualViewport\?\.addEventListener\("resize", syncDashboardViewport\)/,
    "viewport-containment: keyboard resize must refresh the height");
  assert.match(
    dashboard,
    /\.dashboard__product \{[^}]*block-size: var\(--dashboard-viewport-height, 100dvh\);[^}]*overflow: hidden;/,
    "viewport-containment: product shell must consume the measured height",
  );
  assert.match(
    dashboard,
    /\.dashboard__frame \{[^}]*block-size: 100%;[^}]*min-block-size: 0;/,
    "viewport-containment: frame must shrink inside the product shell",
  );
  assert.match(
    dashboard,
    /\.dashboard__channel-body \{[^}]*grid-template-rows: minmax\(0, 1fr\) auto;[^}]*overflow: hidden;/,
    "viewport-containment: composer must own the visible grid's auto row",
  );
  assert.match(
    dashboard,
    /@media \(max-width: 52rem\) and \(max-height: 36rem\)[^]*?\.dashboard__composer \{[^}]*padding-block-end: calc\(var\(--s-[12]\) \+ env\(safe-area-inset-bottom\)\);/,
    "viewport-containment: 390x430 must use the compact safe-area composer",
  );
  assert.match(
    dashboard,
    /@media \(max-width: 52rem\)[^]*?\.dashboard__composer textarea \{\s*font-size: 16px;/,
    "viewport-containment: mobile input must not trigger iOS zoom",
  );

  /* The textarea owns focus while the listbox exposes the active option. Open, arrow movement,
   * Escape, and selection all update one combobox state. */
  assert.match(markup, /role="combobox"/, "combobox: textarea must own the combobox role");
  assert.match(markup, /aria-autocomplete="list"/, "combobox: autocomplete mode must be a list");
  assert.match(markup, /aria-controls="dashboard-composer-mention-picker"/,
    "combobox: textarea must control the listbox");
  assert.match(picker, /button\.id = `dashboard-composer-mention-option-\$\{index\}`;/,
    "combobox: every option needs a stable active-descendant id");
  assert.match(picker, /button\.setAttribute\("aria-selected", String\(index === mentionPickerIndex\)\)/,
    "combobox: visible active row must match keyboard state");
  assert.match(picker, /input\?\.setAttribute\("aria-expanded", "true"\);/,
    "combobox: open picker must announce expansion");
  assert.match(picker, /input\?\.setAttribute\(\s*"aria-activedescendant"/,
    "combobox: open picker must announce the active row");
  assert.match(pickerClose, /aria-expanded", "false"/,
    "combobox: closed picker must announce collapse");
  assert.match(pickerClose, /removeAttribute\("aria-activedescendant"\)/,
    "combobox: closed picker must clear stale active state");
  const sendWidth = Number(sendCss.match(/inline-size: ([\d.]+)rem;/)?.[1]);
  const sendHeight = Number(sendCss.match(/block-size: ([\d.]+)rem;/)?.[1]);
  const composerTarget = Number(dashboard.match(/--composer-target: ([\d.]+)rem;/)?.[1]);
  const resolveTarget = (value: string | undefined): number =>
    value === "var(--composer-target)" ? composerTarget : Number(value?.replace("rem", ""));
  const removeWidth = resolveTarget(removeCss.match(/min-inline-size: ([^;]+);/)?.[1]);
  const removeHeight = resolveTarget(removeCss.match(/min-block-size: ([^;]+);/)?.[1]);
  assert.ok(sendWidth * 16 >= 44 && sendHeight * 16 >= 44,
    "send-target: send must be at least 44x44px");
  assert.ok(removeWidth * 16 >= 44 && removeHeight * 16 >= 44,
    "remove-target: mention remove must be at least 44x44px");
  assert.match(markup, /data-composer-send[^>]*aria-label="Post signal"/,
    "send-name: send must have an accessible name");

  /* Draft identity includes all three ownership axes. Storage survives reset/error and is cleared
   * by the accepted response only. */
  assert.match(
    draft,
    /`commonswarm:composer-draft:\$\{owner\}:\$\{activeWorkspaceId\}:\$\{COMPOSER_STREAM\}`/,
    "draft-scope: key must include user, workspace, and stream",
  );
  assert.match(draft, /COMPOSER_STREAM = "all-signals";/,
    "draft-scope: stream identity must be explicit");
  assert.match(
    draft,
    /JSON\.stringify\(\{\s*body,\s*audienceKey,\s*\.\.\.\(agentNote \? \{ agentNote: true \} : \{\}\),\s*\.\.\.\(hadAttachments/,
    "draft-audience: body, audience, no-wake choice, and lost-attachment marker must persist together",
  );
  assert.match(draft, /input\.value = draft\.body;/,
    "draft-restore: reload must restore the exact body");
  assert.match(draft, /composerAudienceFromKey\(draft\.audienceKey\)/,
    "draft-restore: reload must restore the saved audience");
  assert.match(
    draft,
    /composerPostAgentNote = composerAudience\.kind === "agent" && draft\.agentNote === true;/,
    "draft-agent-note: reload must restore an explicit no-wake choice",
  );
  assert.equal(occurrences(dashboard, "clearComposerDraft();"), 1,
    "draft-clear: only the accepted send path may clear the draft");
  assertOrder(submit, "await postBrowserSignal(", "clearComposerDraft();", "draft-clear");
  assert.doesNotMatch(failed, /clearComposerDraft\(\)/,
    "draft-clear: failed sends must retain the saved draft");
  assert.match(
    submit,
    /intent\.attachmentKey !== attachmentKey \|\| intent\.signalKind !== signalKind/,
    "retry-kind: changing ask/note mode must create a new intent",
  );

  /* Latest rows append visually at the bottom because the source array reverses for display. A
   * reader already in history keeps the exact old scrollTop; only readers near the bottom follow
   * the new row. */
  assertOrder(renderFeed, "const wasAtBottom = atBottom();", "list.replaceChildren();",
    "reader-scroll");
  assert.match(renderFeed, /for \(const signal of \[\.\.\.visibleSignals\]\.reverse\(\)\)/,
    "reader-scroll: newest source row must render last");
  assert.match(
    renderFeed,
    /if \(wasAtBottom\) \{\s*scrollToNewest\(\);\s*\} else \{[^]*?change === "latest"[^]*?el\.scrollTop = topBefore;/,
    "reader-scroll: latest append must preserve an upward reader's position",
  );
  assert.match(renderFeed, /el\.scrollTop = topBefore \+ \(el\.scrollHeight - heightBefore\);/,
    "reader-scroll: history prepend must preserve the visible row by height delta");
  assert.match(submit, /signals\.unshift\(optimisticSignal\);[^]*?renderFeed\("latest"\);/,
    "reader-scroll: optimistic append must use latest-row anchoring");
};

type Mutation = {
  expectedFailure: string;
  key: keyof ComposerArtifact;
  name: string;
  replacement: string;
  target: string;
};

const mutations: Mutation[] = [
  {
    name: "failed send drops its exact audience",
    key: "dashboard",
    target: "composerAudience = { ...audience };",
    replacement: 'composerAudience = { kind: "everyone" };',
    expectedFailure: "failed-send-audience",
  },
  {
    name: "retry stops resubmitting the restored draft",
    key: "dashboard",
    target: 'one<HTMLFormElement>("[data-composer]")?.requestSubmit();\n    });\n    syncComposerControls();',
    replacement: 'one<HTMLFormElement>("[data-composer]")?.reset();\n    });\n    syncComposerControls();',
    expectedFailure: "retry-path",
  },
  {
    name: "a second submit passes the in-flight behavior gate",
    key: "dashboard",
    target: '!input ||\n        composerSending ||\n        body === ""',
    replacement: '!input ||\n        body === ""',
    expectedFailure: "double-submit",
  },
  {
    name: "busy state is no longer announced",
    key: "dashboard",
    target: 'if (sending) send.setAttribute("aria-busy", "true");',
    replacement: "if (sending) send.removeAttribute(\"aria-busy\");",
    expectedFailure: "visible-busy",
  },
  {
    name: "the in-flight textarea accepts a second draft",
    key: "dashboard",
    target: "input.readOnly = sending;",
    replacement: "input.readOnly = false;",
    expectedFailure: "inflight-input-lock",
  },
  {
    name: "optimistic row skips the posting receipt phase",
    key: "dashboard",
    target: 'deliveryReceiptCache.set(pendingId, { result: null, checkedAt: 0, phase: "posting" });',
    replacement: 'deliveryReceiptCache.set(pendingId, { result: null, checkedAt: 0, phase: "accepted" });',
    expectedFailure: "optimistic-posting",
  },
  {
    name: "accepted copy falsely claims delivery",
    key: "client",
    target: 'detail: "Accepted by CommonSwarm. The delivery receipt is loading; delivery is not confirmed yet.",',
    replacement: 'detail: "Accepted and delivered by CommonSwarm.",',
    expectedFailure: "accepted-not-delivered",
  },
  {
    name: "shared body authority drifts from 8,000",
    key: "sharedLimit",
    target: "export const SIGNAL_BODY_MAX = 8_000;",
    replacement: "export const SIGNAL_BODY_MAX = 8_001;",
    expectedFailure: "shared-limit",
  },
  {
    name: "large paste is silently sliced",
    key: "dashboard",
    target: "input.setRangeText(\n          pasted,",
    replacement: "input.setRangeText(\n          pasted.slice(0, SIGNAL_BODY_MAX),",
    expectedFailure: "full-paste",
  },
  {
    name: "autosize returns to a fixed ceiling",
    key: "dashboard",
    target: "max-block-size: min(40dvh, 20rem);",
    replacement: "max-block-size: 9rem;",
    expectedFailure: "autosize-max",
  },
  {
    name: "keyboard resize no longer reaches the shell",
    key: "dashboard",
    target: 'window.visualViewport?.addEventListener("resize", syncDashboardViewport);',
    replacement: 'window.visualViewport?.removeEventListener("resize", syncDashboardViewport);',
    expectedFailure: "viewport-containment",
  },
  {
    name: "picker opens without announcing expansion",
    key: "dashboard",
    target: 'input?.setAttribute("aria-expanded", "true");',
    replacement: 'input?.setAttribute("aria-expanded", "false");',
    expectedFailure: "combobox",
  },
  {
    name: "send target shrinks below 44px",
    key: "dashboard",
    target: ".dashboard__composer-send {\n    flex: 0 0 auto;\n    inline-size: 2.75rem;",
    replacement: ".dashboard__composer-send {\n    flex: 0 0 auto;\n    inline-size: 2rem;",
    expectedFailure: "send-target",
  },
  {
    name: "mention remove target shrinks below 44px",
    key: "dashboard",
    target: "min-inline-size: var(--composer-target);\n    min-block-size: var(--composer-target);",
    replacement: "min-inline-size: 2rem;\n    min-block-size: var(--composer-target);",
    expectedFailure: "remove-target",
  },
  {
    name: "draft key loses user ownership",
    key: "dashboard",
    target: "`commonswarm:composer-draft:${owner}:${activeWorkspaceId}:${COMPOSER_STREAM}`",
    replacement: "`commonswarm:composer-draft:${activeWorkspaceId}:${COMPOSER_STREAM}`",
    expectedFailure: "draft-scope",
  },
  {
    name: "draft loses the explicit no-wake choice",
    key: "dashboard",
    target: 'composerPostAgentNote = composerAudience.kind === "agent" && draft.agentNote === true;',
    replacement: "composerPostAgentNote = false;",
    expectedFailure: "draft-agent-note",
  },
  {
    name: "retry reuses an intent after ask/note mode changes",
    key: "dashboard",
    target: "intent.attachmentKey !== attachmentKey || intent.signalKind !== signalKind",
    replacement: "intent.attachmentKey !== attachmentKey",
    expectedFailure: "retry-kind",
  },
  {
    name: "latest append yanks an upward reader to the bottom",
    key: "dashboard",
    target: "if (el && change === \"latest\") {\n          el.scrollTop = topBefore;",
    replacement: "if (el && change === \"latest\") {\n          el.scrollTop = el.scrollHeight;",
    expectedFailure: "reader-scroll",
  },
  {
    name: "built /app advertises the wrong limit",
    key: "builtHtml",
    target: 'maxlength="8000"',
    replacement: 'maxlength="7999"',
    expectedFailure: "built-limit",
  },
  {
    name: "built /app loses the viewport-relative autosize cap",
    key: "builtCss",
    target: "max-block-size:min(40dvh,20rem)",
    replacement: "max-block-size:9rem",
    expectedFailure: "built-autosize",
  },
];

const mutateAndRestore = (mutation: Mutation): void => {
  const original = artifact[mutation.key];
  assert.equal(
    occurrences(original, mutation.target),
    1,
    `mutation-reach: ${mutation.name} must resolve exactly one target`,
  );
  artifact[mutation.key] = original.replace(mutation.target, mutation.replacement);
  try {
    assert.throws(
      () => assertComposerSprint(artifact),
      (error: unknown) => {
        assert.ok(error instanceof assert.AssertionError,
          `mutation-reach: ${mutation.name} failed outside an observer assertion`);
        assert.match(error.message, new RegExp(mutation.expectedFailure),
          `mutation-reach: ${mutation.name} failed for the wrong reason`);
        return true;
      },
      `mutation-reach: ${mutation.name} did not make its observer fail`,
    );
  } finally {
    artifact[mutation.key] = original;
  }
  assert.equal(artifact[mutation.key], original,
    `mutation-revert: ${mutation.name} did not restore exact artifact bytes`);
  assertComposerSprint(artifact);
};

test("composer sprint is present in source and the built /app artifact", () => {
  assertComposerSprint(artifact);
});

test("composer sprint controls fail on adversarial mutations and restore after each one", () => {
  for (const mutation of mutations) mutateAndRestore(mutation);
});
