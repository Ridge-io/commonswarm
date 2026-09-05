/** Reached by `npm --prefix site test` through the recursive component-observer glob. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { findChrome } from "./participant-rail.fixture.js";
import { startComposerPolishServer } from "./composer-polish.fixture.js";

const run = promisify(execFile);

type Rect = {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
};

type RestGeometry = {
  composer: Rect;
  bottomTextInset: number;
  lineBottom: number;
  lineHeight: number;
  lineTop: number;
  send: Rect;
  sendInsetDelta: number;
  sendRightInset: number;
  shell: Rect;
  textLeft: number;
  textLeftInset: number;
  topTextInset: number;
  verticalAsymmetry: number;
};

type PolishMeasurement = {
  focus: {
    matchesFocusVisible: boolean;
    shellBorderBlurred: string;
    shellBorderFocused: string;
    shellBoxShadow: string;
    textareaBoxShadow: string;
    textareaOutlineStyle: string;
    textareaOutlineWidth: string;
  };
  rest: RestGeometry;
  success: {
    feedbackHidden: boolean;
    statusText: string;
    statusVisible: boolean;
  };
  twoLine: {
    composer: Rect;
    input: Rect;
    send: Rect;
    shell: Rect;
  };
  runs: number;
  variant: "current" | "reverted";
  viewport: { height: number; width: number };
};

const measurementPage = (url: URL): string | null => {
  if (url.pathname !== "/__measure") return null;
  const width = Number.parseInt(url.searchParams.get("width") ?? "", 10);
  const height = Number.parseInt(url.searchParams.get("height") ?? "", 10);
  const variant = url.searchParams.get("variant");
  if (
    !Number.isSafeInteger(width) || width <= 0 ||
    !Number.isSafeInteger(height) || height <= 0 ||
    (variant !== "current" && variant !== "reverted")
  ) return "<!doctype html><title>Invalid measurement</title>";

  return `<!doctype html><html><body style="margin:0"><iframe title="Composer measurement viewport" src="/app" style="border:0;width:${width}px;height:${height}px"></iframe><script>
    const frame = document.querySelector("iframe");
    const reportError = (value) => {
      document.documentElement.dataset.composerPolishError = btoa(unescape(encodeURIComponent(String(value))));
    };
    let measurementRuns = 0;
    const runMeasurement = async () => {
      measurementRuns += 1;
      const doc = frame.contentDocument;
      const view = frame.contentWindow;
      const waitFor = async (predicate, label) => {
        for (let attempt = 0; attempt < 160; attempt += 1) {
          if (predicate()) return;
          await new Promise((resolve) => view.setTimeout(resolve, 25));
        }
        throw new Error("Timed out waiting for " + label);
      };
      const settle = async () => {
        await new Promise((resolve) => view.setTimeout(resolve, 40));
      };
      await waitFor(
        () => !doc.querySelector("[data-composer]")?.hidden &&
          doc.querySelectorAll("[data-feed-list] > li").length > 0,
        "sample composer",
      );
      await doc.fonts.ready;
      const form = doc.querySelector("[data-composer]");
      const shell = doc.querySelector(".dashboard__composer-input");
      const input = doc.querySelector("[data-composer-input]");
      const send = doc.querySelector("[data-composer-send]");
      const status = doc.querySelector("[data-composer-status]");
      const feedback = doc.querySelector("[data-composer-feedback]");
      const focusSink = doc.querySelector("[data-channel-name]");
      if (!form || !shell || !input || !send || !status || !feedback || !focusSink) {
        throw new Error("Composer fixture is incomplete");
      }

      /* The dashboard queues its initial desktop autofocus in requestAnimationFrame. A single
       * blur plus timeout can lose to that callback and read the accent border as the blurred
       * border. Reclaim focus until the requested state survives three separate turns. */
      const settleFocus = async (target, predicate, label) => {
        let stableTurns = 0;
        for (let attempt = 0; attempt < 160; attempt += 1) {
          target.focus();
          await new Promise((resolve) => view.setTimeout(resolve, 25));
          stableTurns = predicate() ? stableTurns + 1 : 0;
          if (stableTurns >= 3) return;
        }
        throw new Error("Timed out waiting for stable " + label);
      };

      if (${JSON.stringify(variant)} === "reverted") {
        const style = doc.createElement("style");
        style.textContent = [
          /* The pre-sprint bar: a taller, looser input shell. It is the control for both the
             alignment claims and the 80px budget below. */
          ".dashboard__composer { padding-block: var(--s-4) !important; }",
          ".dashboard__composer-input {",
          "display: flex !important;",
          "align-items: flex-end !important;",
          "flex-wrap: wrap !important;",
          "gap: var(--s-2) !important;",
          "padding: var(--s-2) !important;",
          "}",
          ".dashboard__composer textarea {",
          "flex: 1 1 14rem !important;",
          "min-block-size: 2rem !important;",
          "padding: 0.34rem var(--s-2) !important;",
          "line-height: var(--lh-base) !important;",
          "}",
          ".dashboard__composer-send { border-radius: 50% !important; }",
        ].join("");
        doc.head.append(style);
      }

      const setInput = (value) => {
        input.value = value;
        input.setSelectionRange(value.length, value.length);
        input.dispatchEvent(new view.InputEvent("input", { bubbles: true, inputType: "insertText" }));
      };
      const readRect = (element) => {
        const box = element.getBoundingClientRect();
        return {
          bottom: box.bottom,
          height: box.height,
          left: box.left,
          right: box.right,
          top: box.top,
          width: box.width,
        };
      };

      setInput("");
      if (${JSON.stringify(variant)} === "reverted") {
        input.style.setProperty("min-block-size", "0", "important");
        input.style.setProperty("block-size", "37px", "important");
        input.style.transform = "translateY(4px)";
      }
      input.blur();
      focusSink.setAttribute("tabindex", "-1");
      await settleFocus(
        focusSink,
        () => doc.activeElement === focusSink && !shell.matches(":focus-within"),
        "blurred composer",
      );
      const shellBox = shell.getBoundingClientRect();
      const inputBox = input.getBoundingClientRect();
      const sendBox = send.getBoundingClientRect();
      const shellStyle = view.getComputedStyle(shell);
      const inputStyle = view.getComputedStyle(input);
      const shellBorderTop = Number.parseFloat(shellStyle.borderTopWidth);
      const shellBorderRight = Number.parseFloat(shellStyle.borderRightWidth);
      const shellBorderBottom = Number.parseFloat(shellStyle.borderBottomWidth);
      const shellBorderLeft = Number.parseFloat(shellStyle.borderLeftWidth);
      const inputBorderTop = Number.parseFloat(inputStyle.borderTopWidth);
      const inputBorderLeft = Number.parseFloat(inputStyle.borderLeftWidth);
      const inputPaddingTop = Number.parseFloat(inputStyle.paddingTop);
      const inputPaddingLeft = Number.parseFloat(inputStyle.paddingLeft);
      const lineHeight = Number.parseFloat(inputStyle.lineHeight);
      const lineTop = inputBox.top + inputBorderTop + inputPaddingTop;
      const lineBottom = lineTop + lineHeight;
      const shellInnerTop = shellBox.top + shellBorderTop;
      const shellInnerRight = shellBox.right - shellBorderRight;
      const shellInnerBottom = shellBox.bottom - shellBorderBottom;
      const shellInnerLeft = shellBox.left + shellBorderLeft;
      const topTextInset = lineTop - shellInnerTop;
      const bottomTextInset = shellInnerBottom - lineBottom;
      const textLeft = inputBox.left + inputBorderLeft + inputPaddingLeft;
      const textLeftInset = textLeft - shellInnerLeft;
      const sendRightInset = shellInnerRight - sendBox.right;
      const rest = {
        composer: readRect(form),
        bottomTextInset,
        lineBottom,
        lineHeight,
        lineTop,
        send: readRect(send),
        sendInsetDelta: Math.abs(textLeftInset - sendRightInset),
        sendRightInset,
        shell: readRect(shell),
        textLeft,
        textLeftInset,
        topTextInset,
        verticalAsymmetry: Math.abs(topTextInset - bottomTextInset),
      };

      /* Operator complaint, twice: clicking the box drew an aggressive ring.
       * Chrome treats a focused TEXT FIELD as :focus-visible even on click, so
       * this must be measured on the rendered page, not reasoned about. The
       * indicator that MUST remain is the shell border colour change. */
      /* The border-color change animates over --dur-1; reading mid-transition
       * made the probe report "no change" while the real page changes fine
       * (verified in an isolated reproduction). Transitions are suppressed for
       * this read so the probe measures the destination, not an interpolation
       * frame. */
      const killTransitions = doc.createElement("style");
      killTransitions.textContent = "* { transition: none !important; }";
      doc.head.append(killTransitions);
      const shellBorderBlurred = view.getComputedStyle(shell).borderTopColor;
      await settleFocus(
        input,
        () => doc.activeElement === input && shell.matches(":focus-within"),
        "focused composer",
      );
      const focusedInputStyle = view.getComputedStyle(input);
      const focusedShellStyle = view.getComputedStyle(shell);
      const focus = {
        matchesFocusVisible: input.matches(":focus-visible"),
        shellBorderBlurred,
        shellBorderFocused: focusedShellStyle.borderTopColor,
        shellBoxShadow: focusedShellStyle.boxShadow,
        textareaBoxShadow: focusedInputStyle.boxShadow,
        textareaOutlineStyle: focusedInputStyle.outlineStyle,
        textareaOutlineWidth: focusedInputStyle.outlineWidth,
      };
      input.blur();
      killTransitions.remove();
      await settleFocus(
        focusSink,
        () => doc.activeElement === focusSink && !shell.matches(":focus-within"),
        "composer blur after focus check",
      );

      /* A tagged, two-line message. The tag is a word in the text now, so this measures the
         box growing with the content rather than a chip finding a home beside it. */
      setInput("@River First line\\nSecond line");
      input.blur();
      await settle();
      const twoLine = {
        composer: readRect(form),
        input: readRect(input),
        send: readRect(send),
        shell: readRect(shell),
      };

      setInput("Successful sample post");
      form.requestSubmit();
      await settle();
      await waitFor(() => !send.hasAttribute("aria-busy"), "successful sample post");
      if (${JSON.stringify(variant)} === "reverted") {
        status.textContent = "Posted.";
        feedback.hidden = false;
      }
      await settle();
      const success = {
        feedbackHidden: feedback.hidden,
        statusText: status.textContent ?? "",
        statusVisible: !feedback.hidden && view.getComputedStyle(status).display !== "none",
      };
      document.documentElement.dataset.composerPolishMeasurement = btoa(unescape(encodeURIComponent(JSON.stringify({ focus, rest, runs: measurementRuns, success, twoLine,
        variant: ${JSON.stringify(variant)},
        viewport: { height: view.innerHeight, width: view.innerWidth },
      }))));
    };
    /* The iframe can already be complete when this script runs and still deliver its queued
     * load event. Without this guard both paths mutate and measure the same composer at once,
     * which produced the observed 52px inset and already-focused-border flakes. */
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      void runMeasurement().catch((error) => reportError(error?.stack ?? error));
    };
    /* Call the start gate twice on purpose. This is the positive control for the race: removing
     * the gate now deterministically launches two writers against the same measurement DOM. */
    const triggerStart = () => {
      start();
      start();
    };
    frame.addEventListener("load", triggerStart, { once: true });
    if (frame.contentDocument?.readyState === "complete" && frame.contentWindow?.location.pathname === "/app") triggerStart();
  </script></body></html>`;
};

const measure = async (
  chrome: string,
  origin: string,
  width: number,
  height: number,
  variant: "current" | "reverted",
): Promise<PolishMeasurement> => {
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
    `${origin}/__measure?width=${width}&height=${height}&variant=${variant}`,
  ], {
    maxBuffer: 12 * 1024 * 1024,
    timeout: 25_000,
    killSignal: "SIGKILL",
  });
  const encoded = stdout.match(/data-composer-polish-measurement="([^"]+)"/)?.[1];
  const encodedError = stdout.match(/data-composer-polish-error="([^"]+)"/)?.[1];
  assert.ok(
    encoded,
    `${width}px/${variant}: Chrome returned no polish measurement\n` +
      `page error: ${encodedError
        ? decodeURIComponent(escape(Buffer.from(encodedError, "base64").toString("utf8")))
        : "none"}\n` +
      `stderr: ${stderr.slice(-1_000)}\nDOM: ${stdout.slice(-2_000)}`,
  );
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as PolishMeasurement;
};

/**
 * The composer's height ceilings, measured on this build rather than chosen. Both are just
 * above what the current bar actually is and well below the reverted control, so the pair
 * still discriminates: see the comments at each use.
 *
 * BOUND, stated because a review arm asked for it: this file opens 1440x900 and 390x844 and
 * no other viewport. The old comment said the budget held "on every screen" and never
 * measured the smallest one. At 320x568 the composer rests at 128.81px, ABOVE the number
 * below, which is recorded with its screenshot in
 * docs/evidence/2026-09-05-composer-to/mobile-measurements.json rather than gated here.
 */
const COMPOSER_REST_BUDGET_PX = 108;
const COMPOSER_TWO_LINE_BUDGET_PX = 130;

const geometryFailures = (measurement: PolishMeasurement): string[] => {
  const failures: string[] = [];
  if (measurement.runs !== 1) {
    failures.push(`measurement ran ${measurement.runs} times against one frame`);
  }
  const focus = measurement.focus;
  if (focus.textareaOutlineStyle !== "none" && focus.textareaOutlineWidth !== "0px") {
    failures.push(
      `focused textarea draws the global outline (${focus.textareaOutlineStyle} ${focus.textareaOutlineWidth})`,
    );
  }
  if (focus.textareaBoxShadow !== "none") {
    failures.push(`focused textarea draws a box-shadow halo (${focus.textareaBoxShadow})`);
  }
  if (focus.shellBoxShadow !== "none") {
    failures.push(`focused shell draws a focus ring (${focus.shellBoxShadow})`);
  }
  if (focus.shellBorderFocused === focus.shellBorderBlurred) {
    failures.push(
      "shell border does not change on focus - the quiet indicator is missing, which removes the focus indicator entirely",
    );
  }
  if (measurement.rest.verticalAsymmetry > 1) {
    failures.push(`text vertical asymmetry ${measurement.rest.verticalAsymmetry.toFixed(2)}px > 1px`);
  }
  /* THE RESTING BUDGET, renegotiated 2026-09-05 and MEASURED, not guessed.
   *
   * RETIRED: "the operator's budget (2026-09-04): this bar is 80px at rest, on every screen.
   * The TO row and the note checkbox were removed to make that possible." The operator asked
   * for the To: row back on 2026-09-05, so the 80px it bought is spent. Measured on this
   * build: 104.44px desktop, 99.38px mobile. The ceiling is set just above the larger of the
   * two rather than at a round number, so a row that grows again fails here.
   *
   * The reverted control still fails it at 128.44px / 131.38px, which is what keeps this
   * number a gate rather than a record of whatever the composer happens to be. */
  if (measurement.rest.composer.height > COMPOSER_REST_BUDGET_PX) {
    failures.push(
      `composer is ${measurement.rest.composer.height.toFixed(2)}px at rest, over the ` +
        `${COMPOSER_REST_BUDGET_PX}px budget`,
    );
  }
  if (measurement.rest.sendInsetDelta > 1) {
    failures.push(`send/text inset delta ${measurement.rest.sendInsetDelta.toFixed(2)}px > 1px`);
  }
  /* Two lines of text may grow the box, but not past a third of a phone screen. Measured
   * 2026-09-05 with the To: row: 124.44px desktop, 119.38px mobile; the reverted control is
   * 147.44px / 150.38px, so the ceiling still separates them. */
  if (measurement.twoLine.composer.height > COMPOSER_TWO_LINE_BUDGET_PX) {
    failures.push(
      `two-line composer is ${measurement.twoLine.composer.height.toFixed(2)}px, over ` +
        `${COMPOSER_TWO_LINE_BUDGET_PX}px`,
    );
  }
  if (measurement.success.statusText.trim() !== "") {
    failures.push(`successful send left visible status text: ${JSON.stringify(measurement.success.statusText)}`);
  }
  if (measurement.success.statusVisible) {
    failures.push("successful send left the status area visible");
  }
  if (!measurement.success.feedbackHidden) {
    failures.push("successful send left the feedback row open");
  }
  return failures;
};

test("Slack-shaped composer geometry stays aligned in real Chrome", async () => {
  const chrome = await findChrome();
  const server = await startComposerPolishServer(measurementPage);
  try {
    const current = {
      desktop: await measure(chrome, server.origin, 1440, 900, "current"),
      mobile: await measure(chrome, server.origin, 390, 844, "current"),
    };
    const reverted = {
      desktop: await measure(chrome, server.origin, 1440, 900, "reverted"),
      mobile: await measure(chrome, server.origin, 390, 844, "reverted"),
    };
    const currentFailures = Object.entries(current).flatMap(([viewport, measurement]) =>
      geometryFailures(measurement).map((failure) => `${viewport}: ${failure}`)
    );
    const revertedFailures = Object.entries(reverted).flatMap(([viewport, measurement]) =>
      geometryFailures(measurement).map((failure) => `${viewport}: ${failure}`)
    );
    console.log(`composer-polish-current ${JSON.stringify(current)}`);
    console.log(`composer-polish-reverted ${JSON.stringify({ measurements: reverted, failures: revertedFailures })}`);
    assert.deepEqual(currentFailures, [], `composer polish drifted:\n${currentFailures.join("\n")}`);
    assert.ok(
      revertedFailures.some((failure) => failure.includes("vertical asymmetry")) &&
        revertedFailures.some((failure) =>
          failure.includes(`over the ${COMPOSER_REST_BUDGET_PX}px budget`)
        ) &&
        /* The two-line ceiling needs its own reverted failure or the number is a record of
           the current build rather than a gate. A review arm found it unasserted. */
        revertedFailures.some((failure) =>
          failure.includes(`over ${COMPOSER_TWO_LINE_BUDGET_PX}px`)
        ) &&
        revertedFailures.some((failure) => failure.includes("send/text inset")) &&
        revertedFailures.some((failure) => failure.includes("visible status text")),
      `geometry reversion control did not exercise every defect:\n${revertedFailures.join("\n")}`,
    );
  } finally {
    await server.close();
  }
});
