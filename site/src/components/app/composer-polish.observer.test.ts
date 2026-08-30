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
  audience: Rect;
  audienceTextDelta: number;
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
    audience: Rect;
    chip: Rect | null;
    chipCenterDelta: number | null;
    chipText: string;
    input: Rect;
    mentionHost: string;
    send: Rect;
    shell: Rect;
  };
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
    const runMeasurement = async () => {
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
          doc.querySelector("[data-composer-audience]")?.options.length >= 6,
        "sample composer",
      );
      await doc.fonts.ready;
      const form = doc.querySelector("[data-composer]");
      const audience = doc.querySelector(".dashboard__composer-audience");
      const select = doc.querySelector("[data-composer-audience]");
      const mentions = doc.querySelector("[data-composer-mentions]");
      const shell = doc.querySelector(".dashboard__composer-input");
      const input = doc.querySelector("[data-composer-input]");
      const send = doc.querySelector("[data-composer-send]");
      const status = doc.querySelector("[data-composer-status]");
      const feedback = doc.querySelector("[data-composer-feedback]");
      if (!form || !audience || !select || !mentions || !shell || !input || !send || !status || !feedback) {
        throw new Error("Composer fixture is incomplete");
      }

      if (${JSON.stringify(variant)} === "reverted") {
        shell.insertBefore(mentions, input);
        const style = doc.createElement("style");
        style.textContent = [
          ".dashboard__composer-audience { padding-inline: 0 !important; }",
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

      const setAudience = (value) => {
        select.hidden = false;
        select.value = value;
        select.dispatchEvent(new view.Event("change", { bubbles: true }));
      };
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

      setAudience("everyone");
      setInput("");
      if (${JSON.stringify(variant)} === "reverted") {
        input.style.setProperty("min-block-size", "0", "important");
        input.style.setProperty("block-size", "37px", "important");
        input.style.transform = "translateY(4px)";
      }
      input.blur();
      await settle();
      const shellBox = shell.getBoundingClientRect();
      const inputBox = input.getBoundingClientRect();
      const audienceBox = audience.getBoundingClientRect();
      const sendBox = send.getBoundingClientRect();
      const shellStyle = view.getComputedStyle(shell);
      const audienceStyle = view.getComputedStyle(audience);
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
      const audienceContentLeft = audienceBox.left +
        Number.parseFloat(audienceStyle.borderLeftWidth) +
        Number.parseFloat(audienceStyle.paddingLeft);
      const topTextInset = lineTop - shellInnerTop;
      const bottomTextInset = shellInnerBottom - lineBottom;
      const textLeft = inputBox.left + inputBorderLeft + inputPaddingLeft;
      const textLeftInset = textLeft - shellInnerLeft;
      const sendRightInset = shellInnerRight - sendBox.right;
      const rest = {
        audience: readRect(audience),
        audienceTextDelta: Math.abs(audienceContentLeft - textLeft),
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
      input.focus();
      await settle();
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
      await settle();

      setAudience("agent:sample-river");
      setInput("First line\\nSecond line");
      input.blur();
      await settle();
      const chip = doc.querySelector("[data-composer-mentions] .dashboard__mention-chip");
      const chipBox = chip?.getBoundingClientRect() ?? null;
      const twoLineAudienceBox = audience.getBoundingClientRect();
      const twoLine = {
        audience: readRect(audience),
        chip: chip ? readRect(chip) : null,
        chipCenterDelta: chipBox
          ? Math.abs((chipBox.top + chipBox.bottom) / 2 -
            (twoLineAudienceBox.top + twoLineAudienceBox.bottom) / 2)
          : null,
        chipText: chip?.textContent ?? "",
        input: readRect(input),
        mentionHost: mentions.parentElement === audience
          ? "audience"
          : mentions.parentElement === shell
          ? "input-shell"
          : mentions.parentElement?.className ?? "unknown",
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
      document.documentElement.dataset.composerPolishMeasurement = btoa(unescape(encodeURIComponent(JSON.stringify({ focus, rest, success, twoLine,
        variant: ${JSON.stringify(variant)},
        viewport: { height: view.innerHeight, width: view.innerWidth },
      }))));
    };
    const start = () => void runMeasurement().catch((error) => reportError(error?.stack ?? error));
    frame.addEventListener("load", start, { once: true });
    if (frame.contentDocument?.readyState === "complete" && frame.contentWindow?.location.pathname === "/app") start();
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

const geometryFailures = (measurement: PolishMeasurement): string[] => {
  const failures: string[] = [];
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
  if (measurement.rest.audienceTextDelta > 1) {
    failures.push(`TO row offset ${measurement.rest.audienceTextDelta.toFixed(2)}px from text column`);
  }
  if (measurement.rest.sendInsetDelta > 1) {
    failures.push(`send/text inset delta ${measurement.rest.sendInsetDelta.toFixed(2)}px > 1px`);
  }
  if (measurement.twoLine.mentionHost !== "audience") {
    failures.push(`mention chip is in ${measurement.twoLine.mentionHost}, not the TO row`);
  }
  if (measurement.twoLine.chipCenterDelta === null || measurement.twoLine.chipCenterDelta > 1) {
    failures.push(`mention chip is not vertically centred in the TO row`);
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
        revertedFailures.some((failure) => failure.includes("TO row offset")) &&
        revertedFailures.some((failure) => failure.includes("send/text inset")) &&
        revertedFailures.some((failure) => failure.includes("not the TO row")) &&
        revertedFailures.some((failure) => failure.includes("visible status text")),
      `geometry reversion control did not exercise every defect:\n${revertedFailures.join("\n")}`,
    );
  } finally {
    await server.close();
  }
});
