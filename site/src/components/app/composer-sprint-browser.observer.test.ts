/** Reached by `npm --prefix site test` through the recursive component-observer glob. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { findChrome } from "./participant-rail.fixture.js";

const run = promisify(execFile);
const siteRoot = join(import.meta.dirname, "..", "..", "..");
const distRoot = process.env.COMMONSWARM_COMPOSER_DIST_ROOT ?? join(siteRoot, "dist");
const auditOnly = process.env.COMMONSWARM_COMPOSER_AUDIT_ONLY === "1";

type Variant =
  | "current"
  | "autosize-reverted"
  | "double-reverted"
  | "failure"
  | "failure-reverted"
  | "keyboard-reverted"
  | "slow";

type Rect = {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
};

type GeometryMeasurement = {
  counter: {
    nearHidden: boolean;
    nearText: string;
    overHidden: boolean;
    overText: string;
    sendDisabled: boolean;
  } | null;
  draft: {
    audience: string;
    body: string;
    chip: string;
    stored: string;
  };
  escape: {
    activeId: string;
    expandedAfter: string;
    pickerClosed: boolean;
    text: string;
  };
  inputFontSize: number;
  paste: string;
  sizes: {
    max: { clientHeight: number; height: number; overflowY: string; scrollHeight: number };
    middle: { height: number; scrollHeight: number };
    oneLine: { height: number; scrollHeight: number };
  };
  targets: { remove: Rect; send: Rect };
  viewport: { height: number; width: number };
  whitespaceDisabled: boolean;
};

type FailureMeasurement = {
  audience: string;
  body: string;
  chip: string;
  error: string;
  matchingRows: number;
  retryVisible: boolean;
};

type DoubleMeasurement = {
  acceptedCount: number;
  busy: string;
  disabled: boolean;
  pendingCount: number;
  pendingReceipt: string;
  readOnly: boolean;
};

type KeyboardMeasurement = {
  audience: Rect;
  composer: Rect;
  input: Rect;
  inputFontSize: number;
  inputShell: Rect;
  send: Rect;
  viewport: { height: number; width: number };
};

type Measurement = DoubleMeasurement | FailureMeasurement | GeometryMeasurement | KeyboardMeasurement;

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const replaceOne = (
  source: string,
  pattern: RegExp,
  replacement: string | ((...values: string[]) => string),
  label: string,
): string => {
  const matches = source.match(new RegExp(pattern.source, pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`));
  if (matches?.length !== 1) {
    throw new Error(`${label}: expected one emitted target, found ${matches?.length ?? 0}`);
  }
  return source.replace(pattern, replacement as string);
};

const patchClient = (source: string, variant: Variant): string => {
  let result = source;
  if (["failure", "failure-reverted", "slow", "double-reverted"].includes(variant)) {
    const sample = /([A-Za-z_$][\w$]*)\?(\{id:`sample-composer-\$\{[^}]+\}`,[\s\S]*?createdAt:new Date\(\)\.toISOString\(\)\}):await /;
    result = replaceOne(result, sample, (...values: string[]) => {
      const owner = values[1]!;
      const signal = values[2]!;
      if (variant === "failure" || variant === "failure-reverted") {
        return `${owner}?await Promise.reject(new Error(\`Forced composer failure\`)):await `;
      }
      return `${owner}?await new Promise(resolve=>setTimeout(resolve,250)).then(()=>(${signal})):await `;
    }, "sample-post-control");
  }
  if (variant === "failure-reverted") {
    const restore = /,([A-Za-z_$][\w$]*)\.value=([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)=\{\.\.\.([A-Za-z_$][\w$]*)\},([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\[0\]\?\?null,/;
    result = replaceOne(result, restore, (...values: string[]) =>
      `,${values[1]}.value=\`\`,${values[3]}={...${values[4]}},${values[5]}=${values[6]}[0]??null,`,
    "text-survival-reversion");
  }
  if (variant === "double-reverted") {
    const gate = /if\(!([A-Za-z_$][\w$]*)\|\|([A-Za-z_$][\w$]*)\|\|([A-Za-z_$][\w$]*)===``\|\|/;
    result = replaceOne(result, gate, (...values: string[]) =>
      `if(!${values[1]}||${values[3]}===\`\`||`, "double-send-reversion");
  }
  if (variant === "autosize-reverted") {
    const growth = /([A-Za-z_$][\w$]*)\.style\.blockSize=`\$\{\1\.scrollHeight\}px`/;
    result = replaceOne(result, growth, (...values: string[]) => {
      const input = values[1]!;
      return `${input}.style.blockSize=\`\${Math.min(${input}.scrollHeight,144)}px\``;
    }, "autosize-reversion");
  }
  return result;
};

const patchStyles = (source: string, variant: Variant): string => {
  if (variant === "autosize-reverted") {
    return replaceOne(
      source,
      /max-block-size:min\(40dvh,20rem\)/,
      "max-block-size:9rem",
      "autosize-style-reversion",
    );
  }
  if (variant === "keyboard-reverted") {
    return `${source}.dashboard__product{block-size:844px!important;min-block-size:844px!important}`;
  }
  return source;
};

const frameScript = (scenario: string): string => `<script>
  const frame = document.querySelector("iframe");
  const encode = (value) => btoa(unescape(encodeURIComponent(JSON.stringify(value))));
  const reportError = (value) => {
    document.documentElement.dataset.composerBrowserError = encode(String(value));
  };
  const runMeasurement = async () => {
    let doc = frame.contentDocument;
    let view = frame.contentWindow;
    const wait = (milliseconds) => new Promise((resolve) => view.setTimeout(resolve, milliseconds));
    const waitFor = async (predicate, label) => {
      for (let attempt = 0; attempt < 160; attempt += 1) {
        if (predicate()) return;
        await wait(25);
      }
      throw new Error("Timed out waiting for " + label + ": " + doc.body?.innerText?.slice(0, 400));
    };
    const ready = () => !doc.querySelector("[data-composer]")?.hidden &&
      doc.querySelector("[data-composer-audience]")?.options.length >= 6;
    await waitFor(ready, "sample composer");
    const clearDrafts = () => {
      for (let index = view.localStorage.length - 1; index >= 0; index -= 1) {
        const key = view.localStorage.key(index);
        if (key?.startsWith("commonswarm:composer-draft:")) view.localStorage.removeItem(key);
      }
    };
    const rect = (element) => {
      const box = element.getBoundingClientRect();
      return { bottom: box.bottom, height: box.height, left: box.left, right: box.right,
        top: box.top, width: box.width };
    };
    const inputEvent = (input) => input.dispatchEvent(new view.InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
    }));
    const enter = (input) => {
      const event = new view.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" });
      input.dispatchEvent(event);
      return event;
    };
    clearDrafts();

    if (${JSON.stringify(scenario)} === "failure") {
      const input = doc.querySelector("[data-composer-input]");
      const select = doc.querySelector("[data-composer-audience]");
      const body = "  keep this line\\nand this exact ending  ";
      select.value = "agent:sample-river";
      select.dispatchEvent(new view.Event("change", { bubbles: true }));
      input.value = body;
      inputEvent(input);
      enter(input);
      await waitFor(
        () => !doc.querySelector("[data-composer-retry]")?.hidden,
        "failed-send retry",
      );
      const rows = [...doc.querySelectorAll(".dashboard__message-markdown")]
        .filter((row) => row.textContent === body);
      return {
        audience: select.value,
        body: input.value,
        chip: doc.querySelector("[data-composer-mentions]")?.textContent ?? "",
        error: doc.querySelector("[data-composer-status]")?.textContent ?? "",
        matchingRows: rows.length,
        retryVisible: !doc.querySelector("[data-composer-retry]")?.hidden,
      };
    }

    if (${JSON.stringify(scenario)} === "double") {
      const input = doc.querySelector("[data-composer-input]");
      const body = "one post despite two submit attempts";
      input.value = body;
      inputEvent(input);
      enter(input);
      await wait(20);
      input.value = body;
      inputEvent(input);
      enter(input);
      await wait(20);
      const rows = () => [...doc.querySelectorAll(".dashboard__message-markdown")]
        .filter((row) => row.textContent === body);
      const send = doc.querySelector("[data-composer-send]");
      const pendingCount = rows().length;
      const pendingReceipt = rows()[0]?.closest(".dashboard__message-body")
        ?.querySelector("[data-receipt-state]")?.dataset.receiptState ?? "";
      const busy = send.getAttribute("aria-busy") ?? "";
      const disabled = send.disabled;
      const readOnly = input.readOnly;
      await wait(300);
      return {
        acceptedCount: rows().length,
        busy,
        disabled,
        pendingCount,
        pendingReceipt,
        readOnly,
      };
    }

    if (${JSON.stringify(scenario)} === "keyboard") {
      await doc.fonts.ready;
      await wait(80);
      const input = doc.querySelector("[data-composer-input]");
      return {
        audience: rect(doc.querySelector(".dashboard__composer-audience")),
        composer: rect(doc.querySelector("[data-composer]")),
        input: rect(input),
        inputFontSize: Number.parseFloat(view.getComputedStyle(input).fontSize),
        inputShell: rect(doc.querySelector(".dashboard__composer-input")),
        send: rect(doc.querySelector("[data-composer-send]")),
        viewport: { height: view.innerHeight, width: view.innerWidth },
      };
    }

    const input = doc.querySelector("[data-composer-input]");
    const select = doc.querySelector("[data-composer-audience]");
    const send = doc.querySelector("[data-composer-send]");
    const size = async (value) => {
      input.value = value;
      inputEvent(input);
      await wait(40);
      return {
        clientHeight: input.clientHeight,
        height: rect(input).height,
        overflowY: view.getComputedStyle(input).overflowY,
        scrollHeight: input.scrollHeight,
      };
    };
    const oneLine = await size("one line");
    const middle = await size(Array.from({ length: 6 }, (_, index) => "line " + index).join("\\n"));
    const max = await size(Array.from({ length: 80 }, (_, index) => "long line " + index).join("\\n"));

    input.value = "alpha";
    input.setSelectionRange(input.value.length, input.value.length);
    const paste = new view.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: () => "\\nbeta\\ngamma" },
    });
    input.dispatchEvent(paste);
    await wait(20);
    const pasted = input.value;

    input.value = " \\n ";
    inputEvent(input);
    const whitespaceDisabled = send.disabled;

    let counter = null;
    const count = doc.querySelector("[data-composer-count]");
    if (count) {
      input.value = "x".repeat(7500);
      inputEvent(input);
      const nearHidden = count.hidden;
      const nearText = count.textContent ?? "";
      input.value = "x".repeat(8001);
      inputEvent(input);
      counter = {
        nearHidden,
        nearText,
        overHidden: count.hidden,
        overText: count.textContent ?? "",
        sendDisabled: send.disabled,
      };
    }

    const escapeText = "keep this @orb";
    input.value = escapeText;
    input.setSelectionRange(escapeText.length, escapeText.length);
    inputEvent(input);
    await waitFor(() => !doc.querySelector("[data-mention-picker]")?.hidden, "mention picker");
    const activeId = input.getAttribute("aria-activedescendant") ?? "";
    input.dispatchEvent(new view.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    }));
    const escape = {
      activeId,
      expandedAfter: input.getAttribute("aria-expanded") ?? "",
      pickerClosed: doc.querySelector("[data-mention-picker]")?.hidden === true,
      text: input.value,
    };

    input.value = "@orb";
    input.setSelectionRange(input.value.length, input.value.length);
    inputEvent(input);
    await waitFor(() => !doc.querySelector("[data-mention-picker]")?.hidden, "mention picker for chip");
    enter(input);
    await wait(20);
    const remove = doc.querySelector(".dashboard__mention-remove");
    const targets = { remove: rect(remove), send: rect(send) };
    const inputFontSize = Number.parseFloat(view.getComputedStyle(input).fontSize);

    const draftBody = "draft survives\\nwith its recipient";
    select.value = "agent:sample-river";
    select.dispatchEvent(new view.Event("change", { bubbles: true }));
    input.value = draftBody;
    inputEvent(input);
    const draftKey = Array.from({ length: view.localStorage.length }, (_, index) =>
      view.localStorage.key(index)).find((key) => key?.startsWith("commonswarm:composer-draft:"));
    const stored = draftKey ? view.localStorage.getItem(draftKey) ?? "" : "";
    if (draftKey) {
      const reloaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
      view.location.reload();
      await reloaded;
      doc = frame.contentDocument;
      view = frame.contentWindow;
      await waitFor(() => ready() && doc.querySelector("[data-composer-input]")?.value === draftBody,
        "restored composer draft");
    }

    return {
      counter,
      draft: {
        audience: doc.querySelector("[data-composer-audience]")?.value ?? "",
        body: doc.querySelector("[data-composer-input]")?.value ?? "",
        chip: doc.querySelector("[data-composer-mentions]")?.textContent ?? "",
        stored,
      },
      escape,
      inputFontSize,
      paste: pasted,
      sizes: { max, middle, oneLine },
      targets,
      viewport: { height: view.innerHeight, width: view.innerWidth },
      whitespaceDisabled,
    };
  };
  const start = () => void runMeasurement()
    .then((value) => { document.documentElement.dataset.composerBrowserMeasurement = encode(value); })
    .catch((error) => reportError(error?.stack ?? error));
  frame.addEventListener("load", start, { once: true });
  if (frame.contentDocument?.readyState === "complete" && frame.contentWindow?.location.pathname === "/app") start();
</script>`;

const startDistServer = async (): Promise<{ close(): Promise<void>; origin: string }> => {
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/__measure") {
        const width = Number.parseInt(url.searchParams.get("width") ?? "", 10);
        const height = Number.parseInt(url.searchParams.get("height") ?? "", 10);
        const variant = url.searchParams.get("variant") as Variant;
        const scenario = url.searchParams.get("scenario") ?? "";
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
          response.writeHead(400).end("Invalid dimensions");
          return;
        }
        response.writeHead(200, { "content-type": contentTypes[".html"] });
        response.end(`<!doctype html><html><body style="margin:0"><iframe title="Composer behavior viewport" src="/app?variant=${variant}" style="border:0;width:${width}px;height:${height}px"></iframe>${frameScript(scenario)}</body></html>`);
        return;
      }
      const relative = url.pathname === "/app" || url.pathname === "/app/"
        ? "app/index.html"
        : url.pathname.replace(/^\/+/, "");
      const filePath = normalize(join(distRoot, relative));
      if (!filePath.startsWith(`${distRoot}/`)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const stat = statSync(filePath);
      if (!stat.isFile()) throw new Error("not a file");
      const referer = request.headers.referer ? new URL(request.headers.referer) : null;
      const variant = (referer?.searchParams.get("variant") ?? "current") as Variant;
      if (extname(filePath) === ".js") {
        let body = readFileSync(filePath, "utf8").replace(
          /PUBLIC_SUPABASE_URL:`https:\/\/api\.commonswarm\.com`/g,
          "PUBLIC_SUPABASE_URL:``",
        );
        if (body.includes("composer-pending-")) body = patchClient(body, variant);
        response.writeHead(200, {
          "content-length": Buffer.byteLength(body),
          "content-type": contentTypes[".js"],
        });
        response.end(body);
        return;
      }
      if (extname(filePath) === ".css") {
        const body = patchStyles(readFileSync(filePath, "utf8"), variant);
        response.writeHead(200, {
          "content-length": Buffer.byteLength(body),
          "content-type": contentTypes[".css"],
        });
        response.end(body);
        return;
      }
      response.writeHead(200, {
        "content-length": stat.size,
        "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      });
      createReadStream(filePath).pipe(response);
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "composer browser observer must bind a port");
  return {
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
    origin: `http://127.0.0.1:${address.port}`,
  };
};

const measure = async <T extends Measurement>(
  chrome: string,
  origin: string,
  scenario: "double" | "failure" | "geometry" | "keyboard",
  variant: Variant,
  width: number,
  height: number,
): Promise<T> => {
  const { stdout, stderr } = await run(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--single-process",
    "--no-zygote",
    "--run-all-compositor-stages-before-draw",
    "--window-size=1600,1200",
    "--virtual-time-budget=12000",
    "--dump-dom",
    `${origin}/__measure?scenario=${scenario}&variant=${variant}&width=${width}&height=${height}`,
  ], {
    maxBuffer: 12 * 1024 * 1024,
    timeout: 25_000,
    killSignal: "SIGKILL",
  });
  const encoded = stdout.match(/data-composer-browser-measurement="([^"]+)"/)?.[1];
  const encodedError = stdout.match(/data-composer-browser-error="([^"]+)"/)?.[1];
  assert.ok(
    encoded,
    `${scenario}/${variant}: Chrome returned no composer measurement\n` +
      `page error: ${encodedError
        ? decodeURIComponent(escape(Buffer.from(encodedError, "base64").toString("utf8")))
        : "none"}\n` +
      `stderr: ${stderr.slice(-1_000)}\nDOM: ${stdout.slice(-2_000)}`,
  );
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as T;
};

const assertTextSurvival = (measurement: FailureMeasurement): void => {
  assert.equal(measurement.body, "  keep this line\nand this exact ending  ",
    "text-survival-control: failed send lost exact body bytes");
  assert.equal(measurement.audience, "agent:sample-river",
    "text-survival-control: failed send lost its recipient");
  assert.equal(measurement.chip, "@River×",
    "text-survival-control: failed send lost its recipient chip");
  assert.equal(measurement.matchingRows, 0,
    "text-survival-control: rejected optimistic row remained in the transcript");
  assert.equal(measurement.retryVisible, true,
    "text-survival-control: failed send has no retry affordance");
  assert.match(measurement.error, /Forced composer failure/,
    "text-survival-control: failure was not announced inline");
};

const assertDoubleSend = (measurement: DoubleMeasurement): void => {
  assert.equal(measurement.pendingCount, 1,
    "double-send-control: two submit attempts created duplicate pending rows");
  assert.equal(measurement.acceptedCount, 1,
    "double-send-control: two submit attempts created duplicate accepted rows");
  assert.equal(measurement.pendingReceipt, "pending",
    "double-send-control: optimistic row did not use the receipt state model");
  assert.equal(measurement.busy, "true",
    "double-send-control: in-flight state was not announced");
  assert.equal(measurement.disabled, true,
    "double-send-control: send stayed actionable in flight");
  assert.equal(measurement.readOnly, true,
    "double-send-control: the in-flight draft stayed editable");
};

const assertAutosize = (measurement: GeometryMeasurement): void => {
  assert.ok(measurement.sizes.middle.height > measurement.sizes.oneLine.height + 40,
    "autosize-control: multiline input did not grow");
  assert.ok(measurement.sizes.max.height >= 300 && measurement.sizes.max.height <= 320.5,
    `autosize-control: textarea did not reach the viewport cap: ${JSON.stringify(measurement.sizes)}`);
  assert.ok(measurement.sizes.max.scrollHeight > measurement.sizes.max.clientHeight + 100,
    "autosize-control: capped textarea has no internal overflow");
  assert.equal(measurement.sizes.max.overflowY, "auto",
    "autosize-control: capped textarea does not scroll internally");
};

const assertKeyboardContainment = (measurement: KeyboardMeasurement): void => {
  assert.deepEqual(measurement.viewport, { height: 430, width: 390 },
    "keyboard-control: simulated visual viewport drifted");
  for (const [name, box] of Object.entries({
    audience: measurement.audience,
    composer: measurement.composer,
    input: measurement.input,
    inputShell: measurement.inputShell,
    send: measurement.send,
  })) {
    assert.ok(
      box.top >= -0.1 && box.bottom <= measurement.viewport.height + 0.1 &&
        box.left >= -0.1 && box.right <= measurement.viewport.width + 0.1,
      `keyboard-control: ${name} left the visible viewport: ${JSON.stringify(measurement)}`,
    );
  }
  assert.ok(measurement.inputFontSize >= 16,
    "keyboard-control: mobile input can trigger iOS focus zoom");
};

test("real Chrome keeps composer mechanics and their four required controls", {
  skip: auditOnly,
}, async () => {
  const chrome = await findChrome();
  const server = await startDistServer();
  try {
    const geometry = await measure<GeometryMeasurement>(
      chrome, server.origin, "geometry", "current", 1440, 900,
    );
    const autosizeReverted = await measure<GeometryMeasurement>(
      chrome, server.origin, "geometry", "autosize-reverted", 1440, 900,
    );
    const failed = await measure<FailureMeasurement>(
      chrome, server.origin, "failure", "failure", 1440, 900,
    );
    const failureReverted = await measure<FailureMeasurement>(
      chrome, server.origin, "failure", "failure-reverted", 1440, 900,
    );
    const doubled = await measure<DoubleMeasurement>(
      chrome, server.origin, "double", "slow", 1440, 900,
    );
    const doubleReverted = await measure<DoubleMeasurement>(
      chrome, server.origin, "double", "double-reverted", 1440, 900,
    );
    const keyboard = await measure<KeyboardMeasurement>(
      chrome, server.origin, "keyboard", "current", 390, 430,
    );
    const keyboardReverted = await measure<KeyboardMeasurement>(
      chrome, server.origin, "keyboard", "keyboard-reverted", 390, 430,
    );

    assertAutosize(geometry);
    assert.throws(() => assertAutosize(autosizeReverted), /autosize-control/,
      "autosize-control: emitted reversion unexpectedly passed");
    assertTextSurvival(failed);
    assert.throws(() => assertTextSurvival(failureReverted), /text-survival-control/,
      "text-survival-control: emitted reversion unexpectedly passed");
    assertDoubleSend(doubled);
    assert.throws(() => assertDoubleSend(doubleReverted), /double-send-control/,
      "double-send-control: emitted reversion unexpectedly passed");
    assertKeyboardContainment(keyboard);
    assert.throws(() => assertKeyboardContainment(keyboardReverted), /keyboard-control/,
      "keyboard-control: emitted reversion unexpectedly passed");

    assert.equal(geometry.paste, "alpha\nbeta\ngamma",
      "paste-control: multiline paste changed newline bytes");
    assert.equal(geometry.whitespaceDisabled, true,
      "empty-control: whitespace-only input can send");
    assert.ok(geometry.counter, "limit-control: emitted app has no character counter");
    assert.equal(geometry.counter.nearHidden, false,
      "limit-control: counter stayed hidden at the 500-character threshold");
    assert.equal(geometry.counter.nearText, "500 characters left",
      "limit-control: near-limit explanation drifted");
    assert.equal(geometry.counter.overHidden, false,
      "limit-control: over-limit reason stayed hidden");
    assert.equal(geometry.counter.overText, "1 character over the 8,000-character limit",
      "limit-control: over-limit reason is not clear");
    assert.equal(geometry.counter.sendDisabled, true,
      "limit-control: over-limit input can send");
    assert.equal(geometry.escape.text, "keep this @orb",
      "escape-control: closing the picker changed draft text");
    assert.equal(geometry.escape.pickerClosed, true,
      "escape-control: Escape did not close the picker");
    assert.equal(geometry.escape.expandedAfter, "false",
      "escape-control: closed picker remained expanded to accessibility tools");
    assert.match(geometry.escape.activeId, /^dashboard-composer-mention-option-/,
      "escape-control: open picker did not expose its active option");
    assert.ok(geometry.targets.send.width >= 44 && geometry.targets.send.height >= 44,
      "target-control: send target is below 44px");
    assert.ok(geometry.targets.remove.width >= 44 && geometry.targets.remove.height >= 44,
      "target-control: mention remove target is below 44px");
    assert.equal(geometry.draft.body, "draft survives\nwith its recipient",
      "draft-control: reload lost the body");
    assert.equal(geometry.draft.audience, "agent:sample-river",
      "draft-control: reload lost the recipient");
    assert.equal(geometry.draft.chip, "@River×",
      "draft-control: reload lost the recipient chip");
    assert.match(geometry.draft.stored, /"audienceKey":"agent:sample-river"/,
      "draft-control: stored draft did not include its recipient");

    console.log(`composer-sprint-browser ${JSON.stringify({
      controls: {
        autosizeRevertedHeight: autosizeReverted.sizes.max.height,
        doubleRevertedPendingCount: doubleReverted.pendingCount,
        failureRevertedBody: failureReverted.body,
        keyboardRevertedComposerBottom: keyboardReverted.composer.bottom,
      },
      failed,
      geometry,
      keyboard,
    })}`);
  } finally {
    await server.close();
  }
});

test("baseline audit prints common rendered geometry", { skip: !auditOnly }, async () => {
  const chrome = await findChrome();
  const server = await startDistServer();
  try {
    const desktop = await measure<GeometryMeasurement>(
      chrome, server.origin, "geometry", "current", 1440, 900,
    );
    const mobile = await measure<KeyboardMeasurement>(
      chrome, server.origin, "keyboard", "current", 390, 430,
    );
    console.log(`composer-sprint-baseline ${JSON.stringify({ desktop, mobile })}`);
  } finally {
    await server.close();
  }
});
