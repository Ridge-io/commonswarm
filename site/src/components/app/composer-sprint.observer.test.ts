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
  /* The write itself moved into `applyComposerResize` when the autogrow was taken off the
     keystroke (2026-09-04, for INP): the forced layout now happens in an animation frame after
     the handler returns, not inside it. The slice follows the write. */
  const resize = between(
    dashboard,
    "const applyComposerResize =",
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
  const picker = between(
    dashboard,
    "const renderMentionPicker =",
    "const resetComposer =",
    "combobox-open",
  );
  const pickerClose = between(
    dashboard,
    "const closeMentionPicker =",
    "const mentionSearch =",
    "combobox-close",
  );
  const draft = between(
    dashboard,
    "const COMPOSER_COUNTER_THRESHOLD",
    "const focusComposerOnEntry",
    "draft-scope",
  );
  const caret = between(
    dashboard,
    "let composerCaret = { end: 0, start: 0 };",
    "let viewportSyncFrame = 0;",
    "caret-survival",
  );
  const reset = between(
    dashboard,
    "const resetComposer =",
    "const workspaceMenuItems =",
    "composer-reset",
  );
  const viewport = between(
    dashboard,
    "let viewportSyncFrame = 0;",
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
    /max-block-size:min\(calc\(var\(--dashboard-viewport-height,100dvh\) \* \.4\), 20rem\)/,
    "built-autosize: the emitted textarea must cap against the MEASURED visible viewport",
  );
  assert.match(value.builtLimit, /8e3/, "built-limit: the shared bundle must emit 8,000");

  /* A failed request restores the exact, untrimmed draft and the exact recipient snapshot. The
   * optimistic row is removed first, then the retry affordance is made visible. */
  assert.match(failed, /input\.value = rawBody;/, "failed-send-body: restore the exact body");
  /* RETIRED (2026-09-04): "restore only the recipients that did not send". There is no address
   * to restore any more — the tags are in the body, and the body goes back whole. What keeps a
   * retry from posting twice is the command id: every id is kept, so the sends that already
   * landed replay idempotently instead of arriving again. */
  /* The rewritten intent gained `placement` / `placementChannelId` on 2026-09-05: without
     them a retry after a partial failure posted UNFILED, because the replay reads
     the address and a missing one defaults to `{}`. The address is the channel ID, resolved to
     a slug at send time, because a frozen slug made a Retry after a rename name the wrong
     channel. It is written back only when the
     send is still `resumable` — unsent AND still addressed to the channel on screen — because
     a channel change retires it and the catch was putting it back. The property here is
     unchanged: when there IS a retry, every command id is kept. */
  assert.match(
    failed,
    /composerIntent = resumable[\s\S]{0,400}?commandIds,\s*\n\s*body: rawBody,\s*\n\s*audienceKey,\s*\n\s*attachmentKey,\s*\n\s*signalKind,\s*\n\s*placementChannelId,/,
    "failed-send-audience: a retry must reuse every command id, not mint new ones",
  );
  assert.match(
    failed,
    /const resumable = unsent && addressStillActive;/,
    "failed-send-audience: a retry is offered only where it can finish what it started",
  );
  assert.doesNotMatch(failed, /composerAudience|composerMention|remaining/);
  assert.match(failed, /persistComposerDraft\(\);/, "failed-send-body: persist the restored draft");
  /* ~~`: sent < recipients.length ?`~~ 2026-09-05: the partial-send sentence is now gated on
     `resumable`, which is that same condition AND the send still being addressed to the
     channel on screen. The reader who moved gets a different, true sentence instead of one
     inviting them to press send again into a channel that cannot finish it. The property
     here is unchanged: the rejection is announced inline with the counts. */
  assert.match(
    failed,
    /\? `Sent to \$\{sent\} of \$\{recipients\.length\}\. \$\{readableError\(caught\)\}/,
    "failed-send-error: announce the rejection inline",
  );
  /* A partly-sent fan-out must say how many went, or the reader cannot tell whether pressing
   * send again repeats a message that already arrived. */
  assert.match(
    failed,
    /Press send again to finish it; the ones that went will not go twice\./,
    "failed-send-error: say what pressing send again will and will not repeat",
  );
  /* When every recipient already posted there is nothing to press send for, and saying there is
   * would invite a duplicate the reader did not intend. */
  assert.match(
    failed,
    /All \$\{sent\} went out\. \$\{readableError\(caught\)\} `\s*\+\s*"Nothing is left to send/,
    "failed-send-error: a fully-sent failure must not ask for another send",
  );
  /* A finished send must also leave the saved draft empty and its preview URLs revoked. Without
   * that, the reload the copy suggests brings the sent message back with no intent, and the next
   * send mints fresh command ids and posts all of it again. */
  /* And it must not offer Retry either, or the sentence and the button disagree.
     ~~`retry && unsent`~~ 2026-09-05: `resumable` is `unsent` AND the send still addressed to
     the channel on screen. Retry cannot finish a message addressed to a channel the reader
     has left, so it is not offered there and the sentence says where the message was going. */
  assert.match(
    failed,
    /if \(retry && resumable\) retry\.hidden = false;/,
    "retry-path: no retry when every recipient already posted",
  );
  assert.match(failed, /retry\.hidden = false;/, "retry-path: reveal retry after rejection");
  assert.match(
    dashboard,
    /data-composer-retry[^]*?addEventListener\("click", \(\) => \{\s*one<HTMLFormElement>\("\[data-composer\]"\)\?\.requestSubmit\(\);/,
    "retry-path: retry must resubmit the restored form",
  );
  /* Every pending row leaves the feed before the body comes back, so a failed fan-out cannot
   * leave a ghost row beside the restored draft. */
  assertOrder(
    failed,
    "!pendingSet.has(signal.id)",
    "input.value = rawBody;",
    "failed-send-body",
  );

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
  assert.match(
    submit,
    /const pendingIds = commandIds\.map\(\(commandId\) => `composer-pending-\$\{commandId\}`\);/,
    "optimistic-posting: use one stable pending row id",
  );
  assert.match(
    submit,
    /deliveryReceiptCache\.set\(pendingId, \{ result: null, checkedAt: 0, phase: "posting" \}\);/,
    "optimistic-posting: pending row must use the receipt model",
  );
  assertOrder(submit, "signals.unshift(...optimisticSignals);", "await postBrowserSignal(", "optimistic-posting");
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
  /* Against --dashboard-viewport-height, which is measured from visualViewport, and NOT
     against dvh: on iOS Safari the dynamic viewport is the LAYOUT viewport and does not shrink
     when the keyboard opens, so a dvh cap lets the box grow behind the keyboard. */
  assert.match(
    textareaCss,
    /max-block-size: min\(calc\(var\(--dashboard-viewport-height, 100dvh\) \* 0\.4\), 20rem\);/,
    "autosize-max: CSS must cap growth against the measured visible viewport",
  );
  assert.doesNotMatch(textareaCss, /max-block-size: min\(40dvh/,
    "autosize-max: the cap is back on dvh, which does not shrink for the keyboard");
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

  /* THE CARET SURVIVES THE KEYBOARD. Showing and hiding a software keyboard moves focus off
     the textarea and back, and the browser restores neither the selection nor the field's own
     scroll position; what the operator met was a composer he could not return to the end of.
     Three parts, and the third is what makes the other two safe: a caret nobody ever chose is
     not a caret to put back. Without it the first focus that did not follow a tap — tabbing
     into a draft the page restored — writes position 0 over the reader's own sentence, which
     is the same defect in a different path. */
  assert.match(caret, /composerCaretKnown = true;/,
    "caret-survival: nothing records that a caret was ever remembered");
  assert.match(caret, /if \(!input \|\| !composerCaretKnown\) return;/,
    "caret-survival: the restore runs with a caret nobody chose, so focus arriving without a " +
      "tap moves the reader to the start of a sentence they had already written");
  assert.match(caret, /input\.setSelectionRange\(/,
    "caret-survival: the remembered selection is never put back");
  assert.match(dashboard, /if \(Date\.now\(\) - composerPointerAt < 500\) return;/,
    "caret-survival: focus that followed a tap must keep where the tap landed");
  /* A caret remembered in OTHER text is not a caret in this text. Two places replace the whole
     body without the reader typing, and both drop it, or the restore puts them at a position
     they never chose: the draft restore that follows a workspace switch, and `resetComposer`,
     which that switch and session teardown call. A SEND is not one of them and must not be:
     see the next comment. */
  assert.match(
    dashboard,
    /input\.value = draft\.body;[\s\S]{0,60}composerCaretKnown = false;/,
    "caret-survival: a restored draft keeps a caret that was remembered in different text",
  );
  /* resetComposer is NOT the send path — the only callers are the workspace change and
     session teardown. A send empties the box in its own handler and keeps the caret on
     purpose, because a FAILED send puts the body back and the reader's place in it with it. */
  assert.match(
    dashboard,
    /input\.style\.blockSize = "auto";[\s\S]{0,420}composerCaretKnown = false;/,
    "caret-survival: leaving a workspace keeps the caret it had in that workspace's text",
  );
  assert.equal(
    occurrences(dashboard, "resetComposer();"),
    2,
    "caret-survival: resetComposer has gained a caller, so check it is not the send before " +
      "the comments and messages here keep saying it is not",
  );

  /* EVERY DEBOUNCED TIMER DIES IN `resetComposer`, which the workspace change and session
     teardown call and a send does not. A draft timer armed against the old workspace would
     otherwise fire afterwards, read an empty box against the NEW key, and remove the draft the
     reader is about to be shown. `blur` covers a pointer switch because it flushes first; a
     switch that never blurred does not. The mention timer already died here through
     closeMentionPicker. */
  assert.match(reset, /cancelComposerDraftTimer\(\);/,
    "composer-reset: a debounced draft write survives the composer being emptied, so it can " +
      "land against another workspace's key");
  assert.match(reset, /closeMentionPicker\(\);/,
    "composer-reset: the mention picker survives the composer being emptied");

  /* A KEY THAT DECIDES ON THE PICKER MUST SEE THE PICKER. The list is debounced off the
     keystroke, so it can still be closed when Enter arrives. Typing "@ri" and pressing Enter
     inside 150ms sent the raw text instead of picking the name, and the recipient rides inside
     the body. Only these four keys flush, so the debounce still holds on the typing path. */
  assert.match(
    dashboard,
    /mentionPickerTimer &&\s*\(event\.key === "Enter" \|\| event\.key === "Escape" \|\|\s*event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"\)/,
    "combobox-flush: no key flushes the pending mention render, so Enter can send raw @text",
  );
  assert.match(
    dashboard,
    /cancelMentionPickerRender\(\);\s*renderMentionPicker\(\);/,
    "combobox-flush: the pending render is cancelled without being run",
  );
  /* Leaving the field must also disarm it, or a render armed by the last keystroke opens a
     list of names under a composer nobody is in. */
  assert.match(
    dashboard,
    /cancelMentionPickerRender\(\);\s*flushComposerDraft\(\);/,
    "combobox-flush: a pending mention render survives blur and opens under an empty focus",
  );
  /* The usable viewport is visualViewport and ONLY visualViewport. `window.innerHeight` used
     to be the fallback; on iOS Safari it reports the layout viewport, which does not shrink
     when the keyboard opens, so it wrote a height that was too tall at exactly the moment a
     shorter one was needed. With no visualViewport the property stays unset and the
     stylesheet's own 100dvh applies. */
  assert.match(viewport, /const viewport = window\.visualViewport;/,
    "viewport-containment: measure the usable viewport");
  assert.doesNotMatch(viewport, /window\.innerHeight/,
    "viewport-containment: innerHeight is back, and it describes the wrong viewport");
  assert.match(viewport, /window\.scrollTo\(0, 0\)/,
    "viewport-containment: the layout-viewport scroll the keyboard causes is not undone");
  assert.match(viewport, /--dashboard-viewport-height/,
    "viewport-containment: publish the measured height");
  assert.match(
    viewport,
    /visualViewport\?\.addEventListener\("resize", requestDashboardViewportSync\)/,
    "viewport-containment: keyboard resize must refresh the height",
  );
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
  assert.ok(sendWidth * 16 >= 44 && sendHeight * 16 >= 44,
    "send-target: send must be at least 44x44px");
  /* RETIRED (2026-09-04): the 44px mention-remove target. No JS creates that button any more —
     a tag is a word in the message, removed by editing the text — and the CSS is deleted, so a
     pin on its size measured nothing. */
  assert.doesNotMatch(dashboard, /dashboard__mention-remove/);
  assert.match(markup, /data-composer-send[^>]*aria-label="Post signal"/,
    "send-name: send must have an accessible name");

  /* Draft identity includes all three ownership axes. Storage survives reset/error and is cleared
   * by the accepted response only. */
  assert.match(
    draft,
    /`commonswarm:composer-draft:\$\{owner\}:\$\{activeWorkspaceId\}:\$\{COMPOSER_DRAFT_SCOPE\}`/,
    "draft-scope: key must include user, workspace, and stream",
  );
  /* The name changed with the vocabulary on 2026-09-05; "stream" is the event log on the
     wire and this lane retired that word from the app. The VALUE is frozen because it names
     drafts already saved in readers' browsers. */
  assert.match(draft, /COMPOSER_DRAFT_SCOPE = "all-signals";/,
    "draft-scope: stream identity must be explicit");
  /* The draft is the body and one attachment marker. The address used to be saved beside it —
   * audienceKey, extra agent ids, the no-wake choice — and all three are gone, because the
   * address is inside the body the draft already holds. */
  assert.match(
    draft,
    /JSON\.stringify\(\{\s*body,\s*\.\.\.\(hadAttachments \? \{ hadAttachments: true \} : \{\}\),/,
    "draft-audience: body and the lost-attachment marker must persist together",
  );
  assert.match(draft, /input\.value = draft\.body;/,
    "draft-restore: reload must restore the exact body");
  assert.doesNotMatch(draft, /audienceKey|extraAgentIds|agentNote/);
  /* Two callers, and both mean the same thing: the send FINISHED. The second is the failure
     that arrives after every recipient already posted — a render fault, not a rejection — where
     leaving the draft would let a reload bring the sent message back. */
  assert.equal(occurrences(dashboard, "clearComposerDraft();"), 2,
    "draft-clear: only a finished send may clear the draft");
  assertOrder(submit, "await postBrowserSignal(", "clearComposerDraft();", "draft-clear");
  /* RETIRED (2026-09-04): "failed sends must retain the saved draft", unconditionally. It is
     still true of a rejected send — that is the partial branch above, which persists the draft.
     It is false of a failure that arrives after every recipient already posted: there the send
     finished, and keeping the draft would let a reload bring the sent message back. The clear
     is inside the !unsent branch, and only there. */
  /* Read the !unsent BLOCK, not the whole catch: a [\s\S]* match would still pass if the clear
     were moved out below the block, where a rejected send would reach it too. */
  const finished = between(
    failed,
    "if (!unsent) {",
    "\n        }",
    "finished-send-cleanup",
  );
  assert.match(finished, /clearComposerDraft\(\);/,
    "draft-clear: a finished send must clear the draft");
  assert.match(finished, /composerAttachmentsMissingAfterReload = false;/,
    "draft-clear: a finished send must clear the lost-attachment marker too");
  assert.match(finished, /URL\.revokeObjectURL/,
    "draft-clear: a finished send must free its preview URLs");
  assert.doesNotMatch(
    failed.replace(finished, ""),
    /clearComposerDraft\(\)/,
    "draft-clear: a rejected send must retain the saved draft",
  );
  /* ~~`!postedIds.has(signal.id)`~~ 2026-09-05: the id set the failure path removes is now
     the set it is about to put back, which is the posted rows the list ON SCREEN would show.
     Removing every posted id was wrong once channels existed: a row the success path had
     already added, or a page had already fetched, was deleted from a list it was not going
     to be re-added to. The property this line defends — a late throw must not show a row
     twice — is unchanged, and it is the same id set on both sides of the operation. */
  assert.match(
    failed,
    /!pendingSet\.has\(signal\.id\) && !visibleFailureIds\.has\(signal\.id\)/,
    "failed-send-body: a late throw must not prepend rows the success path already added",
  );
  assert.match(
    failed,
    /const visibleOnFailure = posted\.filter\(showsOnScreen\);/,
    "failed-send-body: the rows put back are the ones the list on screen would show",
  );
  assert.match(
    failed,
    /signals = \[\.\.\.visibleOnFailure, \.\.\.keptOnFailure\];/,
    "failed-send-body: and they are the same set that was removed",
  );
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
  assert.match(submit, /signals\.unshift\(\.\.\.optimisticSignals\);[^]*?renderFeed\("latest"\);/,
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
    name: "a retry mints fresh command ids and reposts what already landed",
    key: "dashboard",
    target: "            commandIds,\n            body: rawBody,",
    replacement: "            commandIds: commandIds.map(() => uuid()),\n            body: rawBody,",
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
    target: "max-block-size: min(calc(var(--dashboard-viewport-height, 100dvh) * 0.4), 20rem);",
    replacement: "max-block-size: 9rem;",
    expectedFailure: "autosize-max",
  },
  {
    name: "the caret restore runs with a caret nobody chose",
    key: "dashboard",
    target: "if (!input || !composerCaretKnown) return;",
    replacement: "if (!input) return;",
    expectedFailure: "caret-survival",
  },
  {
    name: "the emptied composer leaves a debounced draft write armed",
    key: "dashboard",
    target: 'cancelComposerDraftTimer();\n      setComposerStatus("");',
    replacement: 'setComposerStatus("");',
    expectedFailure: "composer-reset",
  },
  {
    name: "a pending mention render survives leaving the field",
    key: "dashboard",
    target: "cancelMentionPickerRender();\n      flushComposerDraft();",
    replacement: "flushComposerDraft();",
    expectedFailure: "combobox-flush",
  },
  {
    name: "Enter is judged against a mention picker that has not rendered yet",
    key: "dashboard",
    target: "cancelMentionPickerRender();\n          renderMentionPicker();",
    replacement: "cancelMentionPickerRender();",
    expectedFailure: "combobox-flush",
  },
  {
    name: "a restored draft inherits a caret from different text",
    key: "dashboard",
    target: 'composerCaretKnown = false;\n      composerIntent = null;',
    replacement: "composerIntent = null;",
    expectedFailure: "caret-survival",
  },
  {
    name: "leaving a workspace keeps the caret it had in that workspace's text",
    key: "dashboard",
    target: "workspace's draft. */\n      composerCaretKnown = false;",
    replacement: "workspace's draft. */",
    expectedFailure: "caret-survival",
  },
  {
    name: "a tap in the text is overwritten by the remembered caret",
    key: "dashboard",
    target: "if (Date.now() - composerPointerAt < 500) return;",
    replacement: "if (false) return;",
    expectedFailure: "caret-survival",
  },
  {
    name: "keyboard resize no longer reaches the shell",
    key: "dashboard",
    target: 'window.visualViewport?.addEventListener("resize", requestDashboardViewportSync);',
    replacement: 'window.visualViewport?.removeEventListener("resize", requestDashboardViewportSync);',
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
    name: "draft key loses user ownership",
    key: "dashboard",
    target: "`commonswarm:composer-draft:${owner}:${activeWorkspaceId}:${COMPOSER_DRAFT_SCOPE}`",
    replacement: "`commonswarm:composer-draft:${activeWorkspaceId}:${COMPOSER_DRAFT_SCOPE}`",
    expectedFailure: "draft-scope",
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
    target: "max-block-size:min(calc(var(--dashboard-viewport-height,100dvh) * .4), 20rem)",
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
