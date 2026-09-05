/**
 * `cswarm resume` reads the host process table, and a process's whole argv is
 * in that output. Agents that pass a large prompt as a command-line argument
 * put the whole prompt there: measured on the shared mini on 2026-09-04, the
 * two longest command lines were 72,069 and 72,066 characters, both review-arm
 * invocations. The shipped reader called `ps` through a fixed 4 MB stdout
 * buffer, so on a busy host `resume` died with "stdout maxBuffer length
 * exceeded" — the first command an agent is told to run after a restart, and
 * the one that tells its orphan watchers apart from a teammate's.
 *
 * These controls drive the real `systemProcessTable` against a fake `ps`, so
 * they exercise the streaming reader rather than a fake of it.
 *
 * Reached by BOTH package.json's literal `npm test` list and
 * `npm run test:p1-cli` through tests/p1-cli/**\/*.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_PROCESS_TABLE_COMMAND,
  findNotifyWatchers,
  ProcessTableError,
  systemProcessTable,
  type ProcessTableCommand,
  type StdoutConsumerAdapter,
} from "../../src/resume.js";

const PRINCIPAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREDENTIAL = "/Users/agent/.config/cswarm/agent-8d10fe67.json";

/**
 * The cap this reader used to carry. The fixture must exceed it, or the test
 * passes against the buffered implementation and proves nothing.
 */
const SHIPPED_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/** A fake `ps`: streams a prepared table so the parser sees many chunks. */
const FAKE_PS = `import { createReadStream } from "node:fs";
createReadStream(process.argv[2]).pipe(process.stdout);
`;

const FAKE_PS_FAILS = `process.stderr.write("ps: nonexistent option -- q\\n");
process.exit(3);
`;

/** One review-arm row of the shape that broke this command. */
function armRow(pid: number): string {
  return `${pid} grok -p ${"prompt-text-".repeat(6_000)}`;
}

function notifyRow(pid: number, tail: string): string {
  return `${pid} node /opt/cswarm/dist/cli.js inbox --notify ${tail}`;
}

interface Fixture {
  command: ProcessTableCommand;
  bytes: number;
  cleanup: () => Promise<void>;
}

async function fakeProcessTable(lines: readonly string[]): Promise<Fixture> {
  const directory = await mkdtemp(resolve(tmpdir(), "cswarm-ps-"));
  const script = resolve(directory, "fake-ps.mjs");
  const table = resolve(directory, "table.txt");
  /* No trailing newline: the last row must still be parsed, or a real `ps`
   * whose output does not end in a newline silently loses its final process. */
  const text = lines.join("\n");
  await writeFile(script, FAKE_PS, "utf8");
  await writeFile(table, text, "utf8");
  return {
    command: { file: process.execPath, args: [script, table] },
    bytes: Buffer.byteLength(text, "utf8"),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function fixedStdout(state: "orphaned"): StdoutConsumerAdapter {
  return { inspect: async () => state };
}

test("a process table larger than the old buffer still yields every watcher", async () => {
  const filler: string[] = [];
  let size = 0;
  for (let index = 0; size < SHIPPED_MAX_BUFFER_BYTES; index += 1) {
    const row = armRow(10_000 + index);
    filler.push(row);
    size += row.length + 1;
  }
  const fixture = await fakeProcessTable([
    "not a process row at all",
    ...filler,
    notifyRow(4_242, `--agent-token-file ${CREDENTIAL} --json`),
    /* Last, and with no trailing newline, so this row exists only if the
     * reader flushes what it holds when the child closes. */
    notifyRow(4_243, `--principal-id ${PRINCIPAL}`),
  ]);

  try {
    /* Positive control on the fixture: a smaller table would pass against the
     * buffered reader this test exists to reject. */
    assert.ok(
      fixture.bytes > SHIPPED_MAX_BUFFER_BYTES,
      `fixture is ${fixture.bytes} bytes, not over the ${SHIPPED_MAX_BUFFER_BYTES}-byte cap`,
    );

    const watchers = await findNotifyWatchers({
      credentialPaths: [CREDENTIAL],
      principalId: PRINCIPAL,
      processTableCommand: fixture.command,
      stdoutConsumer: fixedStdout("orphaned"),
    });

    assert.deepEqual(watchers.map((watcher) => watcher.pid), [4_242, 4_243]);
    assert.deepEqual(watchers[0]?.matchedBy, ["agent_token_file"]);
    assert.deepEqual(watchers[1]?.matchedBy, ["principal_id"]);
  } finally {
    await fixture.cleanup();
  }
});

test("the default reader keeps only rows a caller can use", async () => {
  /* The table is unbounded because it carries every argv on the host. Holding
   * all of it is what makes the size a hazard, so the default retains nothing
   * but notify rows. This is also the discriminating half of the test above:
   * without the filter, that fixture would be held in memory in full. */
  const fixture = await fakeProcessTable([
    armRow(11),
    notifyRow(12, `--agent-token-file ${CREDENTIAL}`),
    "13 /usr/sbin/cupsd -l",
  ]);

  try {
    const unfiltered = await systemProcessTable({ command: fixture.command })
      .list();
    const retained = await systemProcessTable({
      command: fixture.command,
      retain: (command) => command.includes("--notify"),
    }).list();

    assert.deepEqual(unfiltered.map((row) => row.pid), [11, 12, 13]);
    assert.deepEqual(retained.map((row) => row.pid), [12]);
  } finally {
    await fixture.cleanup();
  }
});

test("a failing process table raises a typed error, not a message to match", async () => {
  /* D-053: the caller classifies on the class and its code. The command name
   * and the child's own words are carried as data. */
  const directory = await mkdtemp(resolve(tmpdir(), "cswarm-ps-fail-"));
  const script = resolve(directory, "fake-ps-fails.mjs");
  await writeFile(script, FAKE_PS_FAILS, "utf8");
  const command: ProcessTableCommand = {
    file: process.execPath,
    args: [script],
  };

  try {
    const error = await systemProcessTable({ command }).list().then(
      () => null,
      (reason: unknown) => reason,
    );

    assert.ok(error instanceof ProcessTableError);
    assert.equal(error.code, "process_table_unavailable");
    assert.equal(error.command.file, process.execPath);
    assert.match(error.detail, /exited 3/);
    assert.match(error.detail, /nonexistent option/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the shipped command still reads this host's real process table", () => {
  /* Control on the fixtures above: they would all pass while `resume` read
   * something that is not the process table. */
  assert.deepEqual(DEFAULT_PROCESS_TABLE_COMMAND, {
    file: "ps",
    args: ["-axo", "pid=,command="],
  });
});

test("the real ps returns this test process", async () => {
  const rows = await systemProcessTable().list();

  assert.ok(rows.some((row) => row.pid === process.pid), "own pid is missing");
});

test("a throwing row filter rejects instead of hanging forever", async () => {
  /* The whole point of this change is that reading the process table cannot
   * leave `resume` stuck. A throw inside the stdout handler would be an
   * uncaught exception with the promise still pending, which is the same
   * symptom by another route. */
  const fixture = await fakeProcessTable([
    "11 node /opt/cswarm/dist/cli.js inbox --notify",
    "12 /usr/sbin/cupsd -l",
  ]);

  try {
    const settled = await Promise.race([
      systemProcessTable({
        command: fixture.command,
        retain: () => {
          throw new Error("prompt text that must never be classified on");
        },
      }).list().then(() => "resolved", (reason: unknown) => reason),
      new Promise((resolveLate) => setTimeout(() => resolveLate("HUNG"), 5_000)),
    ]);

    assert.notEqual(settled, "HUNG", "the read never settled");
    assert.ok(settled instanceof ProcessTableError);
    assert.equal(settled.code, "process_table_unavailable");
    /* D-053: the reason is ours. The thrown message is not copied into it,
     * so nothing downstream can come to depend on that prose. */
    assert.equal(settled.detail, "its row filter threw");
    assert.doesNotMatch(settled.detail, /prompt text/);
  } finally {
    await fixture.cleanup();
  }
});
