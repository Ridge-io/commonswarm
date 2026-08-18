import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import type { DisplayFile } from "../../lib/file-list.js";
import { findChrome } from "./participant-rail.fixture.js";

const run = promisify(execFile);
const componentDir = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(componentDir, "..", "..", "..");

export interface FileListSnapshot {
  ages: string[];
  dangerousElementCount: number;
  downloadButtonCount: number;
  emptyHidden: boolean;
  emptyText: string;
  innerHtml: string;
  names: string[];
  removedNotes: string[];
  rowCount: number;
  sizes: string[];
  uploaders: string[];
  versions: string[];
  warningCount: number;
  warningText: string;
}

/** Bundles and runs the live file renderer against each named browser fixture. */
export async function renderFileListFixtures(
  scenarios: Record<string, DisplayFile[]>,
  contentWarning: string,
  now: number,
): Promise<Record<string, FileListSnapshot>> {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-file-list-"));
  const fixture = join(directory, "index.html");
  const bundle = await build({
    absWorkingDir: siteRoot,
    bundle: true,
    entryPoints: ["src/lib/file-list.ts"],
    format: "iife",
    globalName: "FileList",
    platform: "browser",
    write: false,
  });
  const script = bundle.outputFiles[0]?.text;
  assert.ok(script, "the live file renderer must bundle for its browser fixture");
  const html = `<!doctype html>
<html>
  <body>
    <main id="fixtures"></main>
    <script>${script}</script>
    <script>
      const scenarios = ${JSON.stringify(scenarios)};
      const snapshots = {};
      for (const [key, files] of Object.entries(scenarios)) {
        const section = document.createElement("section");
        section.innerHTML = '<p data-file-warning hidden></p>' +
          '<p data-file-empty hidden></p><ul data-file-list hidden></ul>';
        document.querySelector("#fixtures").append(section);
        FileList.renderFileList(
          {
            list: section.querySelector("[data-file-list]"),
            empty: section.querySelector("[data-file-empty]"),
            warning: section.querySelector("[data-file-warning]"),
          },
          files,
          { contentWarning: ${JSON.stringify(contentWarning)}, now: ${now}, download: async () => {} },
        );
        const list = section.querySelector("[data-file-list]");
        const empty = section.querySelector("[data-file-empty]");
        const warning = section.querySelector("[data-file-warning]");
        snapshots[key] = {
          ages: Array.from(list.querySelectorAll("[data-file-age]"), (node) => node.textContent),
          dangerousElementCount: list.querySelectorAll("em, img, script, svg").length,
          downloadButtonCount: list.querySelectorAll("button").length,
          emptyHidden: empty.hidden,
          emptyText: empty.textContent,
          innerHtml: list.innerHTML,
          names: Array.from(list.querySelectorAll("[data-file-name]"), (node) => node.textContent),
          removedNotes: Array.from(list.querySelectorAll(".dashboard__file-row--removed .dashboard__file-state"), (node) => node.textContent),
          rowCount: list.querySelectorAll(".dashboard__file-row").length,
          sizes: Array.from(list.querySelectorAll("[data-file-size]"), (node) => node.textContent),
          uploaders: Array.from(list.querySelectorAll("[data-file-uploader]"), (node) => node.textContent),
          versions: Array.from(list.querySelectorAll("[data-file-version]"), (node) => node.textContent),
          warningCount: section.querySelectorAll("[data-file-warning]:not([hidden])").length,
          warningText: warning.textContent,
        };
      }
      document.documentElement.dataset.fixture = encodeURIComponent(JSON.stringify(snapshots));
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
    ], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15_000,
      killSignal: "SIGKILL",
    });
    const encoded = stdout.match(/data-fixture="([^"]+)"/)?.[1];
    assert.ok(encoded, "headless Chrome must return the live file-list snapshot");
    return JSON.parse(decodeURIComponent(encoded)) as Record<string, FileListSnapshot>;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
