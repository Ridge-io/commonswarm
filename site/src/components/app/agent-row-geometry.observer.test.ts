import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const run = promisify(execFile);
const dashboard = await readFile(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
const style = dashboard.match(/<style\b[^>]*>([\s\S]*?)<\/style>/)?.[1];
assert.ok(style, "LiveDashboard must expose its component stylesheet to the geometry fixture");

const chromeCandidates = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((candidate): candidate is string => Boolean(candidate));

const findChrome = async (): Promise<string> => {
  for (const candidate of chromeCandidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep looking: the gate must use a real layout engine, never a source-only fallback.
    }
  }
  throw new Error("Chrome or Chromium is required for rendered dashboard geometry tests");
};

type Geometry = {
  member: {
    buttonClientWidth: number;
    buttonScrollWidth: number;
    buttonWidth: number;
    buttonHeight: number;
    rowClientWidth: number;
    rowScrollWidth: number;
  };
  agent: {
    buttonCenterY: number;
    copyCenterY: number;
    rowClientWidth: number;
    rowScrollWidth: number;
  };
};

const renderGeometry = async (): Promise<Geometry> => {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-agent-geometry-"));
  const fixture = join(directory, "index.html");
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      :root {
        --s-1: 0.25rem;
        --s-2: 0.5rem;
        --s-3: 0.75rem;
        --t-2xs: 0.6875rem;
        --t-xs: 0.75rem;
        --t-sm: 0.875rem;
        --weight-semibold: 600;
        --font-mono: monospace;
        --text: #111;
        --text-muted: #333;
        --elev-3: #eee;
        --border-strong: #999;
        --radius-sm: 0.25rem;
      }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: Arial, sans-serif; }
      .fixture { inline-size: 247px; }
      ${style}
    </style>
  </head>
  <body>
    <div class="fixture">
      <ul class="dashboard__agent-list" data-member-list>
        <li class="dashboard__agent" data-member-row>
          <span>Alexandria Montgomery-Sutherland · member</span>
          <button class="dashboard__text-button" type="button" data-member-remove>Remove</button>
        </li>
      </ul>
      <ul class="dashboard__agent-list dashboard__roster-dialog-list">
        <li class="dashboard__agent" data-agent-row>
          <span class="dashboard__agent-avatar">AM</span>
          <span class="dashboard__agent-copy" data-agent-copy>
            <strong>Alexandria Montgomery-Sutherland</strong>
            <span>Model not specified · owned by Workspace member</span>
          </span>
          <button class="dashboard__text-button" type="button" data-agent-remove>Remove</button>
        </li>
      </ul>
    </div>
    <script>
      const box = (selector) => document.querySelector(selector).getBoundingClientRect();
      const memberButton = document.querySelector("[data-member-remove]");
      const memberRow = document.querySelector("[data-member-row]");
      const agentButton = document.querySelector("[data-agent-remove]");
      const agentCopy = document.querySelector("[data-agent-copy]");
      const agentRow = document.querySelector("[data-agent-row]");
      const memberButtonBox = box("[data-member-remove]");
      const agentButtonBox = box("[data-agent-remove]");
      const agentCopyBox = box("[data-agent-copy]");
      const geometry = {
        member: {
          buttonClientWidth: memberButton.clientWidth,
          buttonScrollWidth: memberButton.scrollWidth,
          buttonWidth: memberButtonBox.width,
          buttonHeight: memberButtonBox.height,
          rowClientWidth: memberRow.clientWidth,
          rowScrollWidth: memberRow.scrollWidth,
        },
        agent: {
          buttonCenterY: agentButtonBox.top + agentButtonBox.height / 2,
          copyCenterY: agentCopyBox.top + agentCopyBox.height / 2,
          rowClientWidth: agentRow.clientWidth,
          rowScrollWidth: agentRow.scrollWidth,
        },
      };
      document.documentElement.dataset.metrics = btoa(JSON.stringify(geometry));
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
      "--allow-file-access-from-files",
      "--dump-dom",
      `file://${fixture}`,
    ], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15_000,
      killSignal: "SIGKILL",
    });
    const encoded = stdout.match(/data-metrics="([^"]+)"/)?.[1];
    assert.ok(encoded, "headless Chrome must return the rendered geometry payload");
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Geometry;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("member Remove and agent actions have usable rendered geometry", async () => {
  const geometry = await renderGeometry();

  assert.ok(
    geometry.member.buttonScrollWidth <= geometry.member.buttonClientWidth,
    `member Remove label is clipped: ${JSON.stringify(geometry.member)}`,
  );
  assert.ok(
    geometry.member.buttonWidth > geometry.member.buttonHeight,
    `member Remove is not horizontal: ${JSON.stringify(geometry.member)}`,
  );
  assert.ok(
    geometry.member.rowScrollWidth <= geometry.member.rowClientWidth,
    `member row overflows its container: ${JSON.stringify(geometry.member)}`,
  );
  assert.ok(
    Math.abs(geometry.agent.buttonCenterY - geometry.agent.copyCenterY) <= 1,
    `three-child agent action auto-placed onto another row: ${JSON.stringify(geometry.agent)}`,
  );
  assert.ok(
    geometry.agent.rowScrollWidth <= geometry.agent.rowClientWidth,
    `three-child agent row overflows its container: ${JSON.stringify(geometry.agent)}`,
  );
});
