import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listenerFailureMessage } from "../../src/cli.js";
import {
  ListenerStartupError,
  waitForListenerReady,
} from "../../src/listener/supervisor.js";
import {
  type ListenerPaths,
  type ListenerStatus,
  writeListenerStatus,
} from "../../src/listener/control.js";

/* D-080. `listen start` reported a terminal failure for a listener that then served.
 *
 * Measured: a start at 23:04:34 printed the PREVIOUS attempt's `permission_canary_failed` and
 * exited; the listener it had launched reached ready at 23:04:42 and served a cross-user wake
 * round trip for 3h35m. Wren filed a blocker on it, which is what anyone following that output
 * does — it cost about an hour.
 *
 * The mechanism: `waitForListenerReady` falls back to the status FILE when the live control query
 * fails, which is normal in the first moments of a start because the socket is not up. The
 * listener directory is keyed by CONFIG HASH, so a retry reads the previous run's terminal status.
 * The live branch already rejected a mismatched pid; the fallback checked nothing.
 *
 * It also explains the backwards diagnostics Wren noticed — the specific message belonged to the
 * earlier genuine failure, and the vague one to the start that actually failed. */

const status = (over: Partial<ListenerStatus>): ListenerStatus => ({
  version: 1,
  logPath: "/tmp/d080-listener.log",
  profileId: "d080",
  instanceId: "11111111-1111-4111-8111-111111111111",
  provider: "opencode",
  permissionMode: "deny",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  principalId: "33333333-3333-4333-8333-333333333333",
  pid: 1111,
  state: "failed",
  startedAt: new Date(0).toISOString(),
  readyAt: null,
  stoppedAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  lastSignalId: null,
  lastErrorCode: "permission_canary_failed",
  /* All six delivery keys are required by writeListenerStatus, even when null. */
  deliveryMode: "cursor_fallback",
  pendingDeliveryCount: null,
  lastTerminalDeliveryFailureCount: null,
  lastTerminalDeliveryFailureAt: null,
  lastClaimAt: null,
  lastAckAt: null,
  ...over,
});

function paths() {
  const dir = mkdtempSync(join(tmpdir(), "d080-"));
  const p: ListenerPaths = {
    key: "d080",
    instanceDirectory: dir,
    statusPath: join(dir, "status.json"),
    socketPath: join(dir, "control.sock"),
    logPath: join(dir, "listener.log"),
  };
  return { dir, p };
}

test("D-080: a PREVIOUS run's failure does not end this start", async () => {
  const { dir, p } = paths();
  try {
    // The stale file the retry used to read: a real failure, from pid 1111.
    await writeListenerStatus(p, status({ pid: 1111 }));

    // This start is pid 2222 and its socket is not up, so the fallback fires. It must not
    // adopt the other instance's terminal status. Bounded so the test ends on the timeout.
    await assert.rejects(
      waitForListenerReady(p, {
        expectedPid: 2222,
        timeoutMs: 120,
        pollMs: 20,
        isProcessAlive: () => true,
      }),
      (error: unknown) => {
        // It must NOT be the stale canary failure. A timeout here is the correct outcome:
        // this start is still resolving.
        assert.ok(
          !(error instanceof ListenerStartupError) ||
            (error as ListenerStartupError).code !== "permission_canary_failed",
          "the start adopted a previous instance's failure",
        );
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D-080: THIS start's own failure is still reported — the fix does not swallow it", async () => {
  /* CONTROL, and the one that matters. Requiring a pid match could equally be implemented by
   * ignoring the stored status altogether, which would silence real failures and be a worse
   * defect than the one being fixed. */
  const { dir, p } = paths();
  try {
    await writeListenerStatus(p, status({ pid: 2222 }));

    await assert.rejects(
      waitForListenerReady(p, {
        expectedPid: 2222,
        timeoutMs: 500,
        pollMs: 20,
        isProcessAlive: () => true,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ListenerStartupError);
        assert.equal(
          (error as ListenerStartupError).code,
          "permission_canary_failed",
        );
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D-080: with no expectedPid the old behaviour stands, so callers that cannot know are unaffected", async () => {
  const { dir, p } = paths();
  try {
    await writeListenerStatus(p, status({ pid: 9999 }));

    await assert.rejects(
      waitForListenerReady(p, { timeoutMs: 500, pollMs: 20 }),
      (error: unknown) => {
        assert.ok(error instanceof ListenerStartupError);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D-080: the ready timeout does not tell the user to retry, because nothing was stopped", async () => {
  /* This pins a CLAIM, so it is checked against what the code does, not against another message.
   * The authority: `listen start`'s catch turns ListenerStartupError into this text and never
   * kills the child, so on a timeout the listener is still running. "then retry" asserted the
   * opposite and would have the user spawn a second listener or collide with the first. */
  const message = listenerFailureMessage("ready_timeout", "opencode");

  assert.doesNotMatch(message, /retry/, "the timeout still advises a retry");
  assert.match(message, /cswarm listen status/, "it must name the confirming command");

  /* CONTROL. A genuine startup failure follows a runtime that terminated, so there "retry" is
   * correct — without this, deleting the word everywhere would pass the assertion above. */
  assert.match(
    listenerFailureMessage("executable_missing", "codex"),
    /retry/,
    "a terminal failure should still say retry",
  );
});
