# Detached listener teardown race fix

Date: 2026-08-03

Worker: Newel

Branch: `lead7/mvp-release-0.1.5`

Frozen base: `fc381648943ed3f53101f0bdcf4986896be7e9f9`

## Defect and fix

The cursor-fallback process test requested `listen stop` and immediately removed the listener state directory. The stop command only requests cancellation; it can return before the detached supervisor exits, leaving a live writer racing `rm(..., { recursive: true, force: true })`.

The test now reads the supervisor PID already recorded in `status.json` and polls the real process-liveness signal with `process.kill(pid, 0)`. `ESRCH` is the successful exit observation; `EPERM` still means the process exists. The poll is bounded at 10 seconds with a 25 ms poll interval. Expiry throws an error containing the PID, timeout, and listener instance directory. There is no fixed teardown sleep.

Each detached-listener teardown closes and force-closes the test HTTP server in a nested `finally`, so a PID-wait timeout cannot leave the test runner held open. The listener-owned directories remain undeleted on that failure path.

The implementation is test-only. No product code changed.

## Diff

`tests/listener-cli-process.test.ts`:

```diff
+import { readListenerStatus, type ListenerPaths } from "../src/listener/index.js";

+function listenerProcessIsAlive(pid: number): boolean {
+  try {
+    process.kill(pid, 0);
+    return true;
+  } catch (error) {
+    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
+    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
+    throw error;
+  }
+}

+async function waitForListenerProcessExit(
+  pid: number,
+  directory: string,
+  timeoutMs = 10_000,
+): Promise<void> {
+  const deadline = Date.now() + timeoutMs;
+  while (Date.now() < deadline) {
+    if (!listenerProcessIsAlive(pid)) return;
+    await new Promise((resolve) => setTimeout(resolve, 25));
+  }
+  if (!listenerProcessIsAlive(pid)) return;
+  throw new Error(
+    `listener process ${pid} did not exit within ${timeoutMs}ms before removing ${directory}`,
+  );
+}

+async function stopAndWaitForDetachedListener(
+  args: string[],
+  paths: ListenerPaths,
+): Promise<void> {
+  await runCli(args).catch(() => undefined);
+  const status = await readListenerStatus(paths);
+  if (status) {
+    await waitForListenerProcessExit(status.pid, paths.instanceDirectory);
+  }
+}

+async function closeTestServer(server: Server): Promise<void> {
+  await new Promise<void>((resolveClose) => {
+    server.close(() => resolveClose());
+    server.closeAllConnections();
+  });
+}

-await runCli(["listen", "stop", ...]).catch(() => undefined);
+try {
+  await stopAndWaitForDetachedListener(["listen", "stop", ...], paths);
+} finally {
+  await closeTestServer(server);
+}
 await rm(root, { recursive: true, force: true });
```

The stop-and-wait replacement is applied only to the three teardowns that own a detached listener.

## Sibling teardown audit

- Original lines 569-580, durable-claim detached listener: changed. Although the test earlier observed status `stopped`, that durable status transition precedes final write flushing, control-socket closure, and process exit. The teardown now waits for the recorded PID to disappear.
- Original lines 701-713, cursor-fallback detached listener: changed. This is the observed `ENOTEMPTY` failure site and had no exit wait.
- Original lines 816-817, delivery-status formatting test: deliberately left alone. It starts no detached listener and writes a synthetic status with `pid: process.pid`. Waiting for that PID would wait for the test runner itself and expire every time.
- Original lines 907-917, missing-Grok-login detached startup: changed. The detached supervisor records terminal failure before its process necessarily exits, so its teardown has the same request/terminal-state-versus-exit gap.

## Verification

- `npm run check:tests`: passed.
- Affected test, isolated in 30 separate invocations:
  `node --import tsx --test --test-name-pattern='detached CLI cursor fallback still receives and replies' tests/listener-cli-process.test.ts`
  Result: **30/30 passed**.
- Root `npm test`: **376/376 passed**, 0 failed, 0 skipped.

The 30 isolated green runs reduce confidence in the known race after the fix; they do not prove the race is absent.

## Forced reproduction and limits

I did not force the pre-fix race red. Within the owned test file, the fake model exits before the supervisor writes its terminal status, so delaying that fake process does not create the identified post-status/pre-supervisor-exit window. Deterministically widening that exact window would require instrumenting product supervisor code, which this lane explicitly forbids. No pre-fix red/after-fix green causal demonstration was established.

This work did not establish that the race is absent on every scheduler or filesystem, that 30 green runs are proof, or that any product behavior changed. It did establish that all detached-listener teardowns in this file now observe the recorded supervisor PID disappearing before deleting listener-owned directories, while the non-detached synthetic-status teardown remains unchanged.
