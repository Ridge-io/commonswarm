import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { matchesGlob, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import ts from "typescript";

interface PackageJson {
  scripts?: Record<string, string>;
}

const repoRoot = process.cwd();
const pureCliCommand = "node --import tsx --test tests/p1-cli/**/*.test.ts";
const localStackCommand =
  "node --import tsx --test tests/p1-local/local-integration.test.ts";
const localStackTest = "tests/p1-local/local-integration.test.ts";

function repoRelative(path: string): string {
  return relative(repoRoot, path).split(sep).join("/");
}

async function findTestFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return findTestFiles(path);
    return /\.(?:test)\.tsx?$/.test(entry.name) ? [repoRelative(path)] : [];
  }));
  return paths.flat().sort();
}

function testPathPatterns(command: string): string[] {
  const withoutComment = command.replace(/\s+#.*$/, "");
  return withoutComment
    .split(/\s*(?:&&|\|\||;)\s*/)
    .flatMap((segment) => {
      const tokens = segment.trim().split(/\s+/);
      const testFlag = tokens.indexOf("--test");
      if (testFlag === -1) return [];
      return tokens
        .slice(testFlag + 1)
        .filter((token) => token.startsWith("tests/"));
    });
}

function executionScripts(packageJson: PackageJson): Map<string, string[]> {
  return new Map(
    Object.entries(packageJson.scripts ?? {})
      .filter(([, command]) => /(?:^|\s)--test(?:\s|$)/.test(command))
      .map(([name, command]) => [name, testPathPatterns(command)]),
  );
}

function matchingScripts(
  file: string,
  scripts: Map<string, string[]>,
): string[] {
  return [...scripts]
    .filter(([, patterns]) => patterns.some((pattern) => matchesGlob(file, pattern)))
    .map(([name]) => name)
    .sort();
}

async function readPackageJson(): Promise<PackageJson> {
  return JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8")) as PackageJson;
}

test("D-030: every test file is reached by an npm execution script", async () => {
  const files = await findTestFiles(resolve(repoRoot, "tests"));
  const scripts = executionScripts(await readPackageJson());
  const unreachable = files.filter((file) => matchingScripts(file, scripts).length === 0);

  assert.ok(files.length > 0);
  assert.ok(files.includes(localStackTest));
  assert.deepEqual(unreachable, []);
});

test("D-030: check:tests structurally includes every test source", async () => {
  const packageJson = await readPackageJson();
  const command = packageJson.scripts?.["check:tests"] ?? "";
  const projectFlag = command.match(/(?:^|\s)(?:-p|--project)\s+([^\s'"]+)/);
  assert.notEqual(projectFlag, null);

  const configPath = resolve(repoRoot, projectFlag![1]!);
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(loaded.error, undefined);

  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, repoRoot);
  assert.deepEqual(parsed.errors, []);

  const included = new Set(parsed.fileNames.map(repoRelative));
  const files = await findTestFiles(resolve(repoRoot, "tests"));
  const omitted = files.filter((file) => !included.has(file));
  assert.deepEqual(omitted, []);
});

test("D-030: the pure CLI gate cannot reach the stack-touching suite", async () => {
  const packageJson = await readPackageJson();
  const scripts = executionScripts(packageJson);
  const files = await findTestFiles(resolve(repoRoot, "tests"));

  assert.equal(packageJson.scripts?.["pretest:p1-cli"], undefined);
  assert.equal(packageJson.scripts?.["posttest:p1-cli"], undefined);
  assert.equal(packageJson.scripts?.["test:p1-cli"], pureCliCommand);
  assert.equal(packageJson.scripts?.["test:p1-local"], localStackCommand);
  assert.deepEqual(
    files.filter((file) => file.endsWith("/local-integration.test.ts")),
    [localStackTest],
  );
  assert.deepEqual(matchingScripts(localStackTest, scripts), ["test:p1-local"]);
});
