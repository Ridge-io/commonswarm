/** Reached by `npm --prefix site test` through the component observer glob. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { build } from "esbuild";
import { findChrome } from "./participant-rail.fixture.js";

const run = promisify(execFile);
const componentDir = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(componentDir, "..", "..", "..");

interface SettingsSnapshot {
  title: string;
  counts: string;
  warning: string;
  initialDisabled: boolean;
  partialDisabled: boolean;
  exactDisabled: boolean;
  closeCalls: number;
  lastSectionIsDanger: boolean;
}

async function renderSettingsFixture(): Promise<SettingsSnapshot> {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-workspace-settings-"));
  const fixture = join(directory, "index.html");
  const bundle = await build({
    absWorkingDir: siteRoot,
    bundle: true,
    entryPoints: ["src/lib/workspace-settings.ts"],
    format: "iife",
    globalName: "WorkspaceSettings",
    platform: "browser",
    write: false,
  });
  const script = bundle.outputFiles[0]?.text;
  assert.ok(script, "the live workspace-settings renderer must bundle");
  const html = `<!doctype html><html><body><div id="host"></div>
    <script>${script}</script>
    <script>
      let closeCalls = 0;
      const root = document.querySelector("#host");
      const controls = WorkspaceSettings.renderWorkspaceSettings(root, {
        name: "Science Swarm",
        workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        memberCount: 3,
        agentCount: 2,
        canClose: true,
        onCopy: async () => {},
        onClose: async () => { closeCalls += 1; },
      });
      const initialDisabled = controls.closeButton.disabled;
      controls.confirmInput.value = "Science";
      controls.confirmInput.dispatchEvent(new Event("input"));
      const partialDisabled = controls.closeButton.disabled;
      controls.confirmInput.value = "Science Swarm";
      controls.confirmInput.dispatchEvent(new Event("input"));
      const exactDisabled = controls.closeButton.disabled;
      root.querySelector("form").requestSubmit();
      setTimeout(() => {
        const snapshot = {
          title: root.querySelector("h2").textContent,
          counts: root.querySelector(".dashboard__workspace-settings-counts").textContent,
          warning: root.querySelector("[data-workspace-close-section] p").textContent,
          initialDisabled,
          partialDisabled,
          exactDisabled,
          closeCalls,
          lastSectionIsDanger: root.lastElementChild.matches("[data-workspace-close-section]"),
        };
        document.documentElement.dataset.fixture = encodeURIComponent(JSON.stringify(snapshot));
      }, 0);
    </script></body></html>`;
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
    ], { timeout: 15_000, maxBuffer: 10 * 1024 * 1024, killSignal: "SIGKILL" });
    const encoded = stdout.match(/data-fixture="([^"]+)"/)?.[1];
    assert.ok(encoded, "headless Chrome must return the settings snapshot");
    return JSON.parse(decodeURIComponent(encoded)) as SettingsSnapshot;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("the real settings renderer gates close on the exact workspace name", async () => {
  const snapshot = await renderSettingsFixture();
  assert.equal(snapshot.title, "Science Swarm");
  assert.equal(snapshot.counts, "3 people · 2 agents");
  assert.equal(snapshot.initialDisabled, true);
  assert.equal(snapshot.partialDisabled, true);
  assert.equal(snapshot.exactDisabled, false);
  assert.equal(snapshot.closeCalls, 1);
  assert.equal(snapshot.lastSectionIsDanger, true);
  assert.match(snapshot.warning, /hides the workspace for everyone/);
  assert.match(snapshot.warning, /frees its free-tier slot/);
  assert.match(snapshot.warning, /Members lose access/);
  assert.match(snapshot.warning, /Support can restore it/);
});

test("the dashboard closes through the human command and leaves the dead route", async () => {
  const dashboard = await readFile(
    new URL("./LiveDashboard.astro", import.meta.url),
    "utf8",
  );
  assert.match(dashboard, /archiveWorkspace\(session, uuid\(\), closingWorkspaceId\)/);
  assert.match(
    dashboard,
    /workspaces = workspaces\.filter\(\(item\) => item\.id !== closingWorkspaceId\)/,
  );
  assert.match(dashboard, /const next = workspaces\[0\]/);
  assert.match(dashboard, /await openWorkspace\(next\.id\)/);
  assert.match(dashboard, /resetWorkspaceSessionState\(\);\s*renderCreate\(session\)/);
  assert.match(
    dashboard,
    /wirePopover\("\[data-workspace-details-trigger\]", "\[data-workspace-details-popover\]"\)/,
  );
});
