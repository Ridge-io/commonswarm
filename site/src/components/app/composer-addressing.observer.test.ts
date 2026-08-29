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

type ComposerMeasurement = {
  broadcast: { option: string; status: string };
  mention: {
    chipCount: number;
    chipText: string;
    enterPrevented: boolean;
    selectedValue: string;
    status: string;
  };
  replacement: { chipCount: number; chipText: string; selectedValue: string };
  selectSync: { chipCount: number; chipText: string };
  plainEnter: { prevented: boolean; submitted: boolean };
  shiftEnter: { insertedNewline: boolean; prevented: boolean; submitted: boolean };
  metaEnter: { recipient: string; submitted: boolean };
  ctrlEnter: { recipient: string; submitted: boolean };
};

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const frameScript = `<script>
  const frame = document.querySelector("iframe");
  const reportError = (value) => {
    document.documentElement.dataset.composerError = btoa(String(value));
  };
  const runMeasurement = async () => {
    const doc = frame.contentDocument;
    const view = frame.contentWindow;
    const waitFor = async (predicate, label) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => view.setTimeout(resolve, 25));
      }
      throw new Error(
        "Timed out waiting for " + label + ": " + JSON.stringify({
          appState: doc.querySelector("live-dashboard")?.dataset.state,
          composerHidden: doc.querySelector("[data-composer]")?.hidden,
          optionCount: doc.querySelector("[data-composer-audience]")?.options.length,
          pageText: doc.body?.innerText?.slice(0, 300),
        }),
      );
    };
    await waitFor(
      () => !doc.querySelector("[data-composer]")?.hidden &&
        doc.querySelector("[data-composer-audience]")?.options.length >= 6,
      "the sample composer",
    );
    const form = doc.querySelector("[data-composer]");
    const input = doc.querySelector("[data-composer-input]");
    const select = doc.querySelector("[data-composer-audience]");
    const status = doc.querySelector("[data-composer-audience-count]");
    const list = doc.querySelector("[data-feed-list]");
    const chips = () => [...doc.querySelectorAll("[data-composer-mentions] .dashboard__mention-chip")];
    const chooseMention = async (query) => {
      input.value = "@" + query;
      input.setSelectionRange(input.value.length, input.value.length);
      input.dispatchEvent(new view.InputEvent("input", { bubbles: true, inputType: "insertText" }));
      await waitFor(() => !doc.querySelector("[data-mention-picker]")?.hidden, "mention picker");
      const event = new view.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      });
      input.dispatchEvent(event);
      await new Promise((resolve) => view.setTimeout(resolve, 0));
      return event.defaultPrevented;
    };
    const sendWith = async (modifier, body) => {
      select.value = "agent:sample-river";
      select.dispatchEvent(new view.Event("change", { bubbles: true }));
      input.value = body;
      input.setSelectionRange(body.length, body.length);
      input.dispatchEvent(new view.InputEvent("input", { bubbles: true, inputType: "insertText" }));
      const before = list.children.length;
      const event = new view.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        [modifier]: true,
      });
      input.dispatchEvent(event);
      for (let attempt = 0; attempt < 20 && list.children.length === before; attempt += 1) {
        await new Promise((resolve) => view.setTimeout(resolve, 10));
      }
      const row = list.children.length === before + 1 ? list.lastElementChild : null;
      return {
        recipient: row?.querySelector(".dashboard__message-target")?.textContent?.trim() ?? "",
        submitted: row?.querySelector(".dashboard__message-markdown")?.textContent === body,
      };
    };

    const broadcast = {
      option: select.selectedOptions[0]?.textContent ?? "",
      status: status.textContent ?? "",
    };
    const mentionEnterPrevented = await chooseMention("orb");
    const mention = {
      chipCount: chips().length,
      chipText: chips()[0]?.textContent ?? "",
      enterPrevented: mentionEnterPrevented,
      selectedValue: select.value,
      status: status.textContent ?? "",
    };
    await chooseMention("lum");
    const replacement = {
      chipCount: chips().length,
      chipText: chips()[0]?.textContent ?? "",
      selectedValue: select.value,
    };
    select.value = "person:sample-owner";
    select.dispatchEvent(new view.Event("change", { bubbles: true }));
    const selectSync = {
      chipCount: chips().length,
      chipText: chips()[0]?.textContent ?? "",
    };

    input.value = "sent with enter";
    input.setSelectionRange(input.value.length, input.value.length);
    const beforePlain = list.children.length;
    const plain = new view.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    });
    input.dispatchEvent(plain);
    await new Promise((resolve) => view.setTimeout(resolve, 0));
    const plainEnter = {
      prevented: plain.defaultPrevented,
      submitted: list.children.length === beforePlain + 1 &&
        list.lastElementChild?.querySelector(".dashboard__message-markdown")?.textContent === "sent with enter",
    };

    input.value = "line one";
    input.setSelectionRange(input.value.length, input.value.length);
    const beforeShift = list.children.length;
    const shift = new view.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      shiftKey: true,
    });
    const shiftDefaultAllowed = input.dispatchEvent(shift);
    if (shiftDefaultAllowed) {
      input.setRangeText("\\n", input.selectionStart, input.selectionEnd, "end");
      input.dispatchEvent(new view.InputEvent("input", { bubbles: true, inputType: "insertLineBreak" }));
    }
    const shiftEnter = {
      insertedNewline: input.value === "line one\\n",
      prevented: shift.defaultPrevented,
      submitted: list.children.length !== beforeShift,
    };
    const metaEnter = await sendWith("metaKey", "sent with command enter");
    const ctrlEnter = await sendWith("ctrlKey", "sent with control enter");

    document.documentElement.dataset.composerMeasurement = btoa(unescape(encodeURIComponent(JSON.stringify({
      broadcast,
      mention,
      replacement,
      selectSync,
      plainEnter,
      shiftEnter,
      metaEnter,
      ctrlEnter,
    }))));
  };
  const start = () => void runMeasurement().catch((error) => reportError(error?.stack ?? error));
  frame.addEventListener("load", start, { once: true });
  if (
    frame.contentDocument?.readyState === "complete" &&
    frame.contentWindow?.location.pathname === "/app"
  ) start();
</script>`;

const startDistServer = async (): Promise<{ close(): Promise<void>; origin: string }> => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__measure") {
      response.writeHead(200, { "content-type": contentTypes[".html"] });
      response.end(`<!doctype html><html><body><iframe src="/app"></iframe>${frameScript}</body></html>`);
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
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) throw new Error("not a file");
      if (extname(filePath) === ".js") {
        const body = readFileSync(filePath, "utf8").replace(
          /PUBLIC_SUPABASE_URL:`https:\/\/api\.commonswarm\.com`/g,
          "PUBLIC_SUPABASE_URL:``",
        );
        response.writeHead(200, {
          "content-length": Buffer.byteLength(body),
          "content-type": contentTypes[".js"],
        });
        response.end(body);
        return;
      }
      response.writeHead(200, {
        "content-length": stat.size,
        "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      });
      createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "composer observer must bind a port");
  return {
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
    origin: `http://127.0.0.1:${address.port}`,
  };
};

test("rendered composer uses one visible recipient and preserves multiline keyboard input", async () => {
  const chrome = await findChrome();
  const server = await startDistServer();
  try {
    const { stdout, stderr } = await run(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--single-process",
      "--no-zygote",
      "--virtual-time-budget=8000",
      "--dump-dom",
      `${server.origin}/__measure`,
    ], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 20_000,
      killSignal: "SIGKILL",
    });
    const encoded = stdout.match(/data-composer-measurement="([^"]+)"/)?.[1];
    const encodedError = stdout.match(/data-composer-error="([^"]+)"/)?.[1];
    assert.ok(
      encoded,
      `headless Chrome returned no composer measurement\n` +
        `page error: ${encodedError ? Buffer.from(encodedError, "base64").toString("utf8") : "none"}\n` +
        `stderr: ${stderr.slice(-1_000)}\nDOM: ${stdout.slice(-2_000)}`,
    );
    const measured = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    ) as ComposerMeasurement;
    assert.deepEqual(measured.mention, {
      chipCount: 1,
      chipText: "@Orbit×",
      enterPrevented: true,
      selectedValue: "agent:sample-orbit",
      status: "One recipient · agent addressed · its listener can wake it",
    });
    assert.match(measured.broadcast.option, /nobody (?:is )?notified/i);
    assert.match(measured.broadcast.status, /no agent (?:is |will be )?woken/i);
    assert.deepEqual(measured.replacement, {
      chipCount: 1,
      chipText: "@Lumen×",
      selectedValue: "agent:sample-lumen",
    });
    assert.deepEqual(measured.selectSync, { chipCount: 1, chipText: "@Dana Rivera×" });
    assert.deepEqual(measured.plainEnter, {
      prevented: true,
      submitted: true,
    });
    assert.deepEqual(measured.shiftEnter, {
      insertedNewline: true,
      prevented: false,
      submitted: false,
    });
    assert.deepEqual(measured.metaEnter, { recipient: "→ River", submitted: true });
    assert.deepEqual(measured.ctrlEnter, { recipient: "→ River", submitted: true });
  } finally {
    await server.close();
  }
});
