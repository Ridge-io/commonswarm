/**
 * Pure coverage for OpenCode home ownership, sweep, and realpath fail-closed.
 * ★ Named in npm test.
 */
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  OPENCODE_FORCED_PERMISSION_TOOLS,
  OPENCODE_HOME_OWNER_FILE,
  OPENCODE_HOME_PREFIX,
  assertForcedAskPermissionMap,
  buildOpenCodeHomeOwner,
  prepareOpenCodeIsolatedHome,
  readOpenCodeHomeOwner,
  releaseOpenCodeHome,
  resolveOpenCodeExecutable,
  sweepStaleOpenCodeHomes,
  writeOpenCodeHomeOwner,
} from "../src/host/index.js";

test("resolveOpenCodeExecutable fails closed when realpath cannot resolve", () => {
  assert.throws(
    () => resolveOpenCodeExecutable("/no/such/opencode/binary/zzzz"),
    /not executable|realpath|not found/i,
  );
});

test("assertForcedAskPermissionMap requires every forced tool (or wildcard ask)", () => {
  const full: Record<string, unknown> = {};
  for (const tool of OPENCODE_FORCED_PERMISSION_TOOLS) full[tool] = "ask";
  assert.doesNotThrow(() => assertForcedAskPermissionMap(full));

  // Wildcard-plus-no-override: omit some tools, keep * ask.
  const sparse: Record<string, unknown> = { "*": "ask" };
  assert.doesNotThrow(() => assertForcedAskPermissionMap(sparse));

  assert.throws(
    () => assertForcedAskPermissionMap({ "*": "ask", bash: "allow" }),
    /bash|allow|project_config/i,
  );
  assert.throws(
    () => assertForcedAskPermissionMap({ "*": "ask", write: "allow" }),
    /write/i,
  );
  assert.throws(
    () => assertForcedAskPermissionMap({ "*": "ask", edit: "allow" }),
    /edit/i,
  );
  assert.throws(
    () => assertForcedAskPermissionMap({ "*": "ask", execute: "allow" }),
    /execute/i,
  );
  assert.throws(
    () => assertForcedAskPermissionMap({ bash: "ask" }),
    /wildcard|forced-ask|\*/i,
  );
});

test("sweep never removes a live-owner home even when mtime is >1h old", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-oc-sweep-root-"));
  const home = join(root, `${OPENCODE_HOME_PREFIX}live`);
  await mkdir(home, { mode: 0o700 });
  await chmod(home, 0o700);
  const owner = buildOpenCodeHomeOwner({
    role: "worker",
    pid: process.pid, // live
  });
  await writeOpenCodeHomeOwner(home, owner);
  // Age the directory beyond 1h.
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  await utimes(home, old, old);
  const removed = await sweepStaleOpenCodeHomes({
    root,
    maxAgeMs: 60 * 60 * 1000,
    now: Date.now(),
    isAlive: (pid) => pid === process.pid,
  });
  assert.equal(removed, 0);
  await stat(home); // still exists
});

test("sweep removes home when owner PID is dead (positive reclaim)", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-oc-sweep-root-"));
  const home = join(root, `${OPENCODE_HOME_PREFIX}dead`);
  await mkdir(home, { mode: 0o700 });
  await chmod(home, 0o700);
  const owner = buildOpenCodeHomeOwner({
    role: "worker",
    pid: 2_147_483_646, // almost certainly dead
  });
  await writeOpenCodeHomeOwner(home, owner);
  const removed = await sweepStaleOpenCodeHomes({
    root,
    maxAgeMs: 60 * 60 * 1000,
    now: Date.now(),
    isAlive: () => false,
  });
  assert.equal(removed, 1);
  await assert.rejects(() => stat(home), /ENOENT/);
});

test("releaseOpenCodeHome respects ownership boundary", async () => {
  const a = await prepareOpenCodeIsolatedHome({
    allowMissingAuth: true,
    env: { PATH: "/usr/bin", HOME: tmpdir() },
    owner: buildOpenCodeHomeOwner({ role: "worker", instanceId: "inst-a" }),
  });
  const b = await prepareOpenCodeIsolatedHome({
    allowMissingAuth: true,
    env: { PATH: "/usr/bin", HOME: tmpdir() },
    owner: buildOpenCodeHomeOwner({ role: "worker", instanceId: "inst-b" }),
  });
  // Wrong instance must not delete.
  await releaseOpenCodeHome(a, "inst-b");
  await stat(a);
  await releaseOpenCodeHome(a, "inst-a");
  await assert.rejects(() => stat(a), /ENOENT/);
  await releaseOpenCodeHome(b, "inst-b");
  await assert.rejects(() => stat(b), /ENOENT/);
});

test("terminateOpenCodeChild fails closed when child never exits", async () => {
  const { EventEmitter } = await import("node:events");
  const { terminateOpenCodeChild } = await import("../src/host/opencode.js");
  const emitter = new EventEmitter() as InstanceType<typeof EventEmitter> & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  emitter.exitCode = null;
  emitter.signalCode = null;
  let kills = 0;
  emitter.kill = () => {
    kills += 1;
    // Never emits exit — simulates an unkillable child.
    return true;
  };
  await assert.rejects(
    () =>
      terminateOpenCodeChild(
        emitter as unknown as import("node:child_process").ChildProcessWithoutNullStreams,
      ),
    /child_exit_timeout|did not exit/i,
  );
  assert.ok(kills >= 2); // SIGTERM then SIGKILL
});

test("prepareOpenCodeIsolatedHome writes 0600 owner marker", async () => {
  const home = await prepareOpenCodeIsolatedHome({
    allowMissingAuth: true,
    env: { PATH: "/usr/bin", HOME: tmpdir() },
    owner: buildOpenCodeHomeOwner({ role: "ephemeral", instanceId: "e1" }),
  });
  const owner = await readOpenCodeHomeOwner(home);
  assert.equal(owner?.instanceId, "e1");
  const st = await stat(join(home, OPENCODE_HOME_OWNER_FILE));
  assert.equal((st.mode & 0o777), 0o600);
  await releaseOpenCodeHome(home, "e1");
});
