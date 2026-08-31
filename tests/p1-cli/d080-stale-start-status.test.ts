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

const FLOOR = Date.parse("2026-08-09T23:04:34.000Z");

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
  startedAt: new Date(FLOOR - 3_600_000).toISOString(), // a PREVIOUS run by default
  readyAt: null,
  stoppedAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  lastSignalId: null,
  lastErrorCode: "permission_canary_failed",
  lastErrorDetail: null,
  lastWorkerStderrTail: null,
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
        startedAtFloorMs: FLOOR,
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
    await writeListenerStatus(
      p,
      status({ pid: 2222, startedAt: new Date(FLOOR + 10).toISOString() }),
    );

    await assert.rejects(
      waitForListenerReady(p, {
        expectedPid: 2222,
        startedAtFloorMs: FLOOR,
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

test("D-080: PID REUSE — a matching pid is not enough, the status must also be new", async () => {
  /* Raised independently by BOTH review arms. Pids are recycled, and this directory is keyed by
   * config hash, so the one file a retry reads is the previous run's — whose pid can come round
   * again. The floor is captured before the spawn, so an earlier run's status fails it whatever
   * pid it carries. */
  const { dir, p } = paths();
  try {
    await writeListenerStatus(
      p,
      status({ pid: 2222, startedAt: new Date(FLOOR - 60_000).toISOString() }),
    );

    await assert.rejects(
      waitForListenerReady(p, {
        expectedPid: 2222, // the SAME pid — only the timestamp separates the runs
        startedAtFloorMs: FLOOR,
        timeoutMs: 120,
        pollMs: 20,
        isProcessAlive: () => true,
      }),
      (error: unknown) => {
        assert.ok(
          !(error instanceof ListenerStartupError) ||
            (error as ListenerStartupError).code !== "permission_canary_failed",
          "a recycled pid let a previous run's failure end this start",
        );
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D-080: a caller that supplies neither identifier never adopts a stored failure", async () => {
  /* Both arms flagged the original `expectedPid === undefined ||` as a latent copy of the defect.
   * A caller that cannot identify its own instance must not be handed one. */
  const { dir, p } = paths();
  try {
    await writeListenerStatus(p, status({ pid: 9999 }));

    await assert.rejects(
      waitForListenerReady(p, { timeoutMs: 120, pollMs: 20 }),
      (error: unknown) => {
        assert.ok(error instanceof ListenerStartupError);
        assert.equal(
          (error as ListenerStartupError).code,
          "ready_timeout",
          "an unidentified caller adopted a stored terminal status",
        );
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D-080: the ready timeout does not advise a retry, because cswarm did not stop it", async () => {
  /* This pins a CLAIM, so it is checked against what the code does, not against another message.
   * The authority: `listen start`'s catch turns ListenerStartupError into this text and never
   * kills the child, so on a timeout the listener is still running. "then retry" asserted the
   * opposite and would have the user spawn a second listener or collide with the first. */
  const message = listenerFailureMessage("ready_timeout", "opencode");

  assert.doesNotMatch(message, /retry/, "the timeout still advises a retry");
  assert.doesNotMatch(
    message,
    /was not stopped/,
    "it asserts the listener's state, which the loop never re-checks before throwing",
  );
  assert.match(message, /cswarm did not stop it/, "it must scope the claim to our own action");
  assert.match(message, /cswarm listen status/, "it must name the confirming command");

  /* CONTROL. A genuine startup failure follows a runtime that terminated, so there "retry" is
   * correct — without this, deleting the word everywhere would pass the assertion above. */
  assert.match(
    listenerFailureMessage("executable_missing", "codex"),
    /retry/,
    "a terminal failure should still say retry",
  );
});

test("D-080: a CONCURRENT instance's failure is not adopted either", async () => {
  /* This is what the pid check earns on its own, and it was missing: the mutation that deletes
   * the pid match passed every other test here, because each of those is also caught by the
   * timestamp floor. An ungated check is one a later reader will simplify away after running
   * exactly that mutation and seeing nothing fail.
   *
   * The case is real. The directory is keyed by config hash, so two starts with identical config
   * share it. The file fallback runs precisely when the socket is not answering — the window in
   * which a racing instance's terminal status is on disk and new enough to clear the floor. */
  const { dir, p } = paths();
  try {
    await writeListenerStatus(
      p,
      // NEWER than this start's floor, so the floor admits it. Different pid: not ours.
      status({ pid: 4444, startedAt: new Date(FLOOR + 5).toISOString() }),
    );

    await assert.rejects(
      waitForListenerReady(p, {
        expectedPid: 2222,
        startedAtFloorMs: FLOOR,
        timeoutMs: 120,
        pollMs: 20,
        isProcessAlive: () => true,
      }),
      (error: unknown) => {
        assert.ok(
          !(error instanceof ListenerStartupError) ||
            (error as ListenerStartupError).code !== "permission_canary_failed",
          "a concurrent instance's failure ended this start",
        );
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D-080: a BACKWARD CLOCK STEP degrades the error code, it does not swallow the failure", async () => {
  /* Raised by the exact-review arm on the second round. The floor is the parent's `Date.now()`
   * and `startedAt` is the child's, so a backward clock step between the two can put this
   * instance's OWN status before its own floor and fail the match.
   *
   * The arm's premise was partly wrong — parent and child are one process tree on one machine, so
   * there are not two clocks to disagree — but a single clock CAN step backward, so the case is
   * real. What it claimed as the consequence is what this pins, and it is smaller: the specific
   * code is replaced by `process_exit`, promptly, because the supervisor terminates after a failed
   * start and isProcessAlive sees it. Worse diagnostics; not a swallowed failure and not a hang.
   *
   * Recorded as a bounded, measured limitation instead of being argued away. It is strictly better
   * than the defect being fixed, which reported a specific code that was WRONG. */
  const { dir, p } = paths();
  try {
    await writeListenerStatus(
      p,
      status({ pid: 2222, startedAt: new Date(FLOOR - 5_000).toISOString() }),
    );

    const alive = false; // the child wrote `failed` and exited, which is what it does
    const started = Date.now();
    await assert.rejects(
      waitForListenerReady(p, {
        expectedPid: 2222,
        startedAtFloorMs: FLOOR,
        timeoutMs: 5_000,
        pollMs: 20,
        isProcessAlive: () => alive,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ListenerStartupError);
        assert.equal(
          (error as ListenerStartupError).code,
          "process_exit",
          "the failure was swallowed rather than degraded",
        );
        // Promptly: the 500ms exit grace, nowhere near the 5s timeout.
        assert.ok(
          Date.now() - started < 3_000,
          "it waited for the timeout instead of reporting the exit",
        );
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D-080/F-3: the generic listener failure does not claim nothing was left running", async () => {
  /* MEASURED false on production, 2026-08-10: a start on 0.1.11 printed
   * "listener failed (stopped); no ready listener was left running" at 0s, while the listener it
   * had spawned was `starting` with no error recorded and reached ready 24s later.
   *
   * Nothing on this path stops the child and nothing re-checks it, so the string asserted a state
   * the code never observed — the same defect as the ready_timeout wording, in the fallback that
   * the sweep for that one did not reach because it names no error code. */
  const message = listenerFailureMessage("some_unmapped_code");

  assert.doesNotMatch(
    message,
    /no ready listener was left running/,
    "it still asserts a process state the code never checks",
  );
  assert.match(message, /cswarm listen status/, "it must name the confirming command");
  /* CONTROL: the code itself is ours to assert and must survive — a fix that dropped the whole
   * sentence would pass the assertion above while losing the only diagnostic it carried. */
  assert.match(message, /some_unmapped_code/, "the failure code was dropped");
});
