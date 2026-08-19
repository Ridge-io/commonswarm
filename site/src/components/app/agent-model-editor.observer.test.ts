/**
 * The manage-dialog model editor, driven through the REAL builder in a browser
 * document (the fixture pattern participant-rail uses; hand-written markup is
 * the refuted method). The claim under pin: a hostile model value reaches the
 * DOM only as an element property — never as parsed markup — and submit hands
 * onSave the normalized value (trimmed, empty as null).
 *
 * Reached by `npm --prefix site test` via the src/components/app observer glob.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

interface EditorSnapshot {
  imgElements: number;
  inputValue: string;
  ariaLabel: string;
  placeholderShown: boolean;
  savedValues: Array<string | null>;
  innerHtml: string;
}

const HOSTILE = '<img src=x onerror="document.title=\'pwned\'">';

async function renderEditorFixture(): Promise<EditorSnapshot> {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-model-editor-"));
  const fixture = join(directory, "index.html");
  const bundle = await build({
    absWorkingDir: siteRoot,
    bundle: true,
    entryPoints: ["src/lib/agent-model-editor.ts"],
    format: "iife",
    globalName: "ModelEditor",
    platform: "browser",
    write: false,
  });
  const script = bundle.outputFiles[0]?.text;
  assert.ok(script, "the live editor builder must bundle for its browser fixture");
  const html = `<!doctype html>
<html>
  <body>
    <div id="host"></div>
    <script>${script}</script>
    <script>
      const hostile = ${JSON.stringify(HOSTILE)};
      const saved = [];
      const editor = ModelEditor.buildAgentModelEditor(document, {
        agentName: "Wren " + hostile,
        currentModel: hostile,
        onCancel: () => {},
        onSave: (model) => { saved.push(model); },
      });
      document.getElementById("host").append(editor);
      const input = editor.querySelector("input");
      // Submit once with the hostile value, once with whitespace (a clear).
      editor.requestSubmit();
      input.value = "   ";
      editor.requestSubmit();
      const snapshot = {
        imgElements: document.querySelectorAll("img").length,
        inputValue: input.value === "   " ? hostileCheck() : "unexpected",
        ariaLabel: input.getAttribute("aria-label"),
        placeholderShown: input.placeholder.includes("empty clears"),
        savedValues: saved,
        innerHtml: editor.innerHTML,
      };
      function hostileCheck() {
        // Re-build a fresh editor to read the prefilled value untouched.
        const fresh = ModelEditor.buildAgentModelEditor(document, {
          agentName: "x",
          currentModel: hostile,
          onCancel: () => {},
          onSave: () => {},
        });
        return fresh.querySelector("input").value;
      }
      document.documentElement.dataset.fixture = btoa(unescape(encodeURIComponent(JSON.stringify(snapshot))));
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
    assert.ok(encoded, "headless Chrome must return the editor snapshot");
    return JSON.parse(
      decodeURIComponent(escape(Buffer.from(encoded, "base64").toString("binary"))),
    ) as EditorSnapshot;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a hostile model value stays an element property — never parsed markup", async () => {
  const snapshot = await renderEditorFixture();
  // The pin: the hostile string is byte-intact in the input's VALUE, and the
  // document gained zero <img> elements. A builder that interpolated the value
  // into innerHTML would parse the tag and this fails (mutation-checked).
  assert.equal(snapshot.inputValue, HOSTILE);
  assert.equal(snapshot.imgElements, 0);
  assert.ok(!snapshot.innerHtml.includes("<img"));
  // The aria-label carries the hostile agent name as a plain attribute value.
  assert.ok(snapshot.ariaLabel?.startsWith("Model for Wren "));
  assert.equal(snapshot.placeholderShown, true);
  // Normalization: the hostile submit hands the exact text; whitespace clears.
  assert.deepEqual(snapshot.savedValues, [HOSTILE, null]);
});
