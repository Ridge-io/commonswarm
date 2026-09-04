import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { test } from "node:test";

/* Reached by site/package.json's 'src/lib/*.test.mjs' glob.
 *
 * WHY THIS EXISTS. `BrainLinkOutcome` gained an `abandoned` return without gaining the matching
 * union member, and it shipped: `npx tsc --noEmit -p site/tsconfig.json` did report it, but that
 * project also carries 68 pre-existing errors from ../src/protocol/* and astro.config.mjs, so one
 * new line is unreadable in the noise and nothing was gated on it. The repo-root `tsc` covers only
 * src/** and never looks at site/ at all.
 *
 * So this runs tsc over a project narrow enough to be GREEN, which is the only kind of typecheck
 * that can go red usefully. */

const run = promisify(execFile);
const libDir = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(libDir, "..", "..");
const PROJECT = "tsconfig.brain-links.json";

/* Resolve the compiler by ABSOLUTE path, never `npx tsc`. Outside a directory that resolves the
   workspace's typescript, `npx tsc` fetches an unrelated package whose whole output is a joke
   banner -- it exits non-zero and prints no diagnostics, which would have let the control below
   "pass" while measuring nothing. Found while writing this file. */
const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");

const tsc = (args, cwd) =>
  run(process.execPath, [TSC, ...args], { cwd, maxBuffer: 10 * 1024 * 1024 })
    .then((ok) => ({ code: 0, out: `${ok.stdout ?? ""}${ok.stderr ?? ""}` }))
    .catch((error) => ({ code: error.code ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` }));

test("the brain-links typecheck is green, so a new type error in it is a red gate", async () => {
  const result = await tsc(["--noEmit", "-p", PROJECT], siteRoot);
  assert.equal(result.code, 0, `brain-links must typecheck cleanly:\n${result.out}`);
});

test("POSITIVE CONTROL: the same invocation reports a brain-links type error", async () => {
  /* Without this the test above could be passing because tsc silently did nothing -- a green that
     proves the file is fine and a green that proves the check never ran look identical. Here the
     exact defect that shipped is reintroduced in a COPY: a returned `kind` outside the union. */
  const source = readFileSync(join(libDir, "brain-links.ts"), "utf8");
  const broken = source.replace(
    '  | { kind: "missing"; topic: string; message: string }\n' +
      "  /** The click belongs to a workspace the reader has left. Render nothing, say nothing. */\n" +
      '  | { kind: "abandoned"; topic: string };',
    '  | { kind: "missing"; topic: string; message: string };',
  );
  assert.notEqual(broken, source, "the union member must be there to remove");

  const directory = await mkdtemp(join(tmpdir(), "commonswarm-brain-links-types-"));
  try {
    await writeFile(join(directory, "brain-links.ts"), broken, "utf8");
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "es2022",
          module: "esnext",
          moduleResolution: "bundler",
          lib: ["es2023", "dom", "dom.iterable"],
          skipLibCheck: true,
          types: [],
        },
        files: ["brain-links.ts"],
      }),
      "utf8",
    );
    const result = await tsc(["--noEmit", "-p", "tsconfig.json"], directory);
    assert.notEqual(result.code, 0, "removing the union member must fail the typecheck");
    assert.match(
      result.out,
      /abandoned/u,
      "and the failure must name the member that is missing",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the scoped project stays narrow enough to be readable", () => {
  /* If this grows to include ../src/protocol/* it becomes site/tsconfig.json again -- red for
     reasons that have nothing to do with this lane, and useless as a gate. */
  const project = JSON.parse(readFileSync(join(siteRoot, PROJECT), "utf8"));
  assert.deepEqual(project.files, ["src/lib/brain-links.ts"]);
  assert.equal(project.compilerOptions.strict, true);
});
