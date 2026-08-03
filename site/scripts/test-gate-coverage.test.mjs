import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, matchesGlob, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = resolve(siteRoot, "package.json");
const excludedDirectories = new Set(["node_modules", "dist", ".astro"]);

function siteRelative(path) {
  return relative(siteRoot, path).split(sep).join("/");
}

function isTestFile(name) {
  return name.endsWith(".test.ts") ||
    name.endsWith(".test.mjs") ||
    name.endsWith(".observer.mjs") ||
    name.endsWith(".observer.test.ts");
}

async function findTestFiles(directory = siteRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) return [];

    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return findTestFiles(path);
    return entry.isFile() && isTestFile(entry.name) ? [siteRelative(path)] : [];
  }));
  return paths.flat().sort();
}

function shellWords(command) {
  const words = [];
  let word = "";
  let quote = null;

  function finishWord() {
    if (word.length === 0) return;
    words.push(word);
    word = "";
  }

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else if (character === "\\" && quote === '"') {
        index += 1;
        word += command[index] ?? "";
      } else {
        word += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      finishWord();
    } else if (character === ";") {
      finishWord();
      words.push(character);
    } else if ((character === "&" || character === "|") && command[index + 1] === character) {
      finishWord();
      words.push(character + character);
      index += 1;
    } else if (character === "\\") {
      index += 1;
      word += command[index] ?? "";
    } else {
      word += character;
    }
  }

  assert.equal(quote, null, "site package.json test script has an unterminated quote");
  finishWord();
  return words;
}

function testPathPatterns(command) {
  const words = shellWords(command);
  const patterns = [];

  for (let index = 0; index < words.length; index += 1) {
    if (words[index] !== "--test") continue;

    for (let candidate = index + 1; candidate < words.length; candidate += 1) {
      const word = words[candidate];
      if (["&&", "||", ";"].includes(word)) break;
      if (!word.startsWith("-")) patterns.push(word);
    }
  }

  return patterns;
}

async function readTestPatterns() {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const command = packageJson.scripts?.test;
  assert.equal(typeof command, "string", "site package.json must define scripts.test");
  return testPathPatterns(command);
}

test("site gate coverage: every test-shaped file is reached by scripts.test", async () => {
  const files = await findTestFiles();
  const patterns = await readTestPatterns();
  const unreachable = files.filter(
    (file) => !patterns.some((pattern) => matchesGlob(file, pattern)),
  );

  assert.ok(files.length > 0, "the observer must enumerate at least one test file");
  assert.ok(patterns.length > 0, "scripts.test must provide at least one test path pattern");
  assert.ok(
    files.includes("scripts/test-gate-coverage.test.mjs"),
    "the gate-coverage observer must enumerate itself",
  );
  console.log(`site test gate coverage: unreachable = ${JSON.stringify(unreachable)}`);
  assert.deepEqual(
    unreachable,
    [],
    `unreachable site test files:\n${unreachable.map((file) => `- ${file}`).join("\n")}`,
  );
});
