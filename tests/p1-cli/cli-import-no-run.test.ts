import assert from "node:assert/strict";
import test from "node:test";

test("importing src/cli.ts is side-effect free and does not run main()", async () => {
  // Capture stdout / stderr to ensure main() did not log anything
  let stdoutData = "";
  let stderrData = "";
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  // Save current exitCode
  const initialExitCode = process.exitCode;

  try {
    process.stdout.write = ((chunk: any) => {
      stdoutData += String(chunk);
      return true;
    }) as any;

    process.stderr.write = ((chunk: any) => {
      stderrData += String(chunk);
      return true;
    }) as any;

    // Dynamically import the CLI module
    const cliModule = await import("../../src/cli.js");

    // Verify isCliMain is exported and returns false when imported as a module
    assert.equal(typeof cliModule.isCliMain, "function", "isCliMain must be exported");
    assert.equal(
      cliModule.isCliMain(),
      false,
      "isCliMain() must return false when imported from another module",
    );

    // Assert that main() did not execute: no output, exit code untouched
    assert.equal(stdoutData, "", "importing src/cli.ts must produce no stdout");
    assert.equal(stderrData, "", "importing src/cli.ts must produce no stderr");
    assert.equal(
      process.exitCode,
      initialExitCode,
      "importing src/cli.ts must not modify process.exitCode",
    );
  } finally {
    process.stdout.write = origStdoutWrite as any;
    process.stderr.write = origStderrWrite as any;
    process.exitCode = initialExitCode;
  }
});
