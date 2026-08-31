/**
 * CLI provider selection coverage. This file is reached by both the root
 * literal test list and the test:p1-cli glob.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clampTurnBudgetToCredential,
  listenerFailureMessage,
  renderListenerStatus,
  resolveDetachedClaudeExecutable,
  resolveDetachedCodexExecutable,
  resolveTurnBudgetOrDefer,
  TURN_BUDGET_CREDENTIAL_MARGIN_MS,
} from "../../src/cli.js";
import {
  ListenerRenewalUnavailableError,
  type ListenerStatus,
} from "../../src/listener/index.js";

function runCli(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: "--max-old-space-size=4096",
      },
      input: "",
    },
  );
}

test("listen start requires an explicit provider before target or credential work", () => {
  const result = runCli([
    "listen",
    "start",
    "--agent-token-stdin",
    "--workspace-id",
    "11111111-1111-4111-8111-111111111111",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--provider is required/);
  assert.match(result.stderr, /grok.*0\.2\.117/i);
  assert.match(result.stderr, /opencode.*1\.18\.10/i);
  assert.match(
    result.stderr,
    /npm install -g @agentclientprotocol\/claude-agent-acp@latest \(minimum 0\.64\.2\)/,
  );
  assert.match(
    result.stderr,
    /npm install -g @agentclientprotocol\/codex-acp@latest \(minimum 1\.1\.9\)/,
  );
  assert.match(result.stderr, /working-on, note, ask, and feed/);
  assert.match(result.stderr, /detached live receipt needs/i);
  assert.doesNotMatch(result.stderr, /Grok is not signed in|Payment Required/i);
});

test("unsupported provider error lists the same four remedies", () => {
  const result = runCli([
    "listen",
    "start",
    "--agent-token-stdin",
    "--workspace-id",
    "11111111-1111-4111-8111-111111111111",
    "--provider",
    "unknown",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unsupported --provider/);
  assert.match(result.stderr, /grok.*opencode.*claude.*codex/i);
  assert.match(
    result.stderr,
    /npm install -g @agentclientprotocol\/claude-agent-acp@latest/,
  );
});

test("Grok canary guidance points to the local detail rendered by listen status", () => {
  const guidance = listenerFailureMessage("permission_canary_failed", "grok");
  assert.match(guidance, /no workspace signal prompt was delivered/i);
  assert.match(guidance, /listen status.*final error detail/i);

  const status: ListenerStatus = {
    version: 1,
    instanceId: "44444444-4444-4444-8444-444444444444",
    provider: "grok",
    profileId: "profile",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    principalId: "33333333-3333-4333-8333-333333333333",
    pid: 123,
    state: "failed",
    startedAt: "2026-08-31T00:00:00.000Z",
    readyAt: null,
    updatedAt: "2026-08-31T00:00:01.000Z",
    stoppedAt: "2026-08-31T00:00:01.000Z",
    lastSignalId: null,
    lastErrorCode: "permission_canary_failed",
    lastErrorDetail:
      "canary incomplete: permission=false deniedTool=false (failed 2 attempts)",
    providerVersion: null,
    providerLastMeasuredVersion: null,
    lastWorkerStderrTail: null,
    deliveryMode: null,
    pendingDeliveryCount: null,
    lastTerminalDeliveryFailureCount: null,
    lastTerminalDeliveryFailureAt: null,
    lastClaimAt: null,
    lastAckAt: null,
    routeMode: "worker",
    deferOverChars: null,
    pendingForMainCount: 0,
    droppedForMainCount: 0,
    logPath: "/tmp/events.ndjson",
  };
  assert.match(
    renderListenerStatus(status),
    /Last error detail \(local only\): canary incomplete: permission=false deniedTool=false \(failed 2 attempts\)/,
  );
});

test("Codex startup failures give install and bounded diagnostic remedies", () => {
  const install = "npm install -g @agentclientprotocol/codex-acp@latest";
  assert.ok(listenerFailureMessage("executable_missing", "codex").includes(install));
  assert.match(listenerFailureMessage("version_below_floor", "codex"), /1\.1\.9 or newer/);

  const ambiguous = listenerFailureMessage("rpc_error", "codex");
  assert.match(ambiguous, /could not start \(rpc_error\)/i);
  assert.match(ambiguous, /ChatGPT\/Codex sign-in/i);
  assert.match(ambiguous, /API-key variables are not forwarded/i);

  const canary = listenerFailureMessage("permission_canary_failed", "codex");
  assert.match(canary, /read-only ACP permission canary/i);
  assert.match(canary, /no workspace signal prompt was delivered/i);
  assert.match(
    listenerFailureMessage("permission_mode_unavailable", "codex"),
    /required read-only permission mode.*update or reinstall codex-acp/i,
  );
});

test("detached Codex resolution preserves the current install remedy", () => {
  assert.throws(
    () =>
      resolveDetachedCodexExecutable(
        "definitely-missing-codex-acp",
        "/definitely/missing",
      ),
    /npm install -g @agentclientprotocol\/codex-acp@latest/,
  );
});

test("Claude startup failures give install and bounded diagnostic remedies", () => {
  const install = "npm install -g @agentclientprotocol/claude-agent-acp@latest";
  assert.ok(listenerFailureMessage("executable_missing", "claude").includes(install));
  assert.match(listenerFailureMessage("version_below_floor", "claude"), /0\.64\.2 or newer/);

  const ambiguous = listenerFailureMessage("rpc_error", "claude");
  assert.match(ambiguous, /could not start \(rpc_error\)/i);
  assert.match(ambiguous, /keychain\/OAuth/i);
  assert.match(ambiguous, /network access/i);
  assert.match(ambiguous, /ANTHROPIC_API_KEY is not forwarded/i);
  assert.doesNotMatch(ambiguous, /authenticated worker session/i);

  const unknownExit = listenerFailureMessage("process_exit", "claude");
  assert.match(unknownExit, /detached listener process exited/i);
  assert.doesNotMatch(unknownExit, /keychain|OAuth|network access/i);

  const canary = listenerFailureMessage("permission_canary_failed", "claude");
  assert.match(canary, /keychain\/OAuth/i);
  assert.match(canary, /startup canary ran/i);
  assert.match(canary, /no workspace signal prompt was delivered/i);
  assert.match(
    listenerFailureMessage("permission_mode_unavailable", "claude"),
    /required manual permission mode.*update or reinstall claude-agent-acp/i,
  );
});

test("detached Claude resolution preserves the current install remedy", () => {
  assert.throws(
    () =>
      resolveDetachedClaudeExecutable(
        "definitely-missing-claude-agent-acp",
        "/definitely/missing",
      ),
    /npm install -g @agentclientprotocol\/claude-agent-acp@latest/,
  );
});

test("explicit unusable Claude path keeps its diagnostic and reinstall option", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-claude-unusable-"));
  const executable = join(root, "claude-agent-acp");
  try {
    await writeFile(executable, "not executable", { mode: 0o600 });
    assert.throws(
      () => resolveDetachedClaudeExecutable(executable, "/unused"),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : "";
        assert.match(message, /could not use --claude-executable/i);
        assert.match(message, /not executable/i);
        assert.ok(message.includes(executable));
        assert.match(
          message,
          /npm install -g @agentclientprotocol\/claude-agent-acp@latest/,
        );
        assert.doesNotMatch(message, /is not installed/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hidden supervisor rejects another provider's executable before credentials", () => {
  const result = runCli([
    "__listen-supervisor",
    "--provider",
    "claude",
    "--grok-executable",
    "/tmp/grok",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--grok-executable requires --provider grok/);
  assert.doesNotMatch(result.stderr, /credential|workspace-id must be a UUID/i);
});

test("--turn-budget rejects out-of-bounds and malformed durations before any credential work", () => {
  const base = [
    "listen",
    "start",
    "--agent-token-stdin",
    "--provider",
    "grok",
    "--url",
    "https://unreachable.example.test",
    "--anon-key",
    "anon",
    "--workspace-id",
    "11111111-1111-4111-8111-111111111111",
  ];
  const tooShort = runCli([...base, "--turn-budget", "5s"]);
  assert.equal(tooShort.status, 1);
  assert.match(tooShort.stderr, /--turn-budget must be between 30s and 60m/);

  const tooLong = runCli([...base, "--turn-budget", "2h"]);
  assert.equal(tooLong.status, 1);
  assert.match(tooLong.stderr, /--turn-budget must be between 30s and 60m/);

  const malformed = runCli([...base, "--turn-budget", "90x"]);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /--turn-budget must be a duration such as 90s, 5m, or 1h/);

  // CONTROL: a valid duration must get PAST the budget gate — this invocation
  // still fails (no piped credential), but for a different reason.
  const valid = runCli([...base, "--turn-budget", "5m"]);
  assert.equal(valid.status, 1);
  assert.doesNotMatch(valid.stderr, /--turn-budget/);
});

test("a worker turn budget is clamped to the live credential's remaining lifetime", () => {
  const now = 1_000_000_000_000;
  const budget = 600_000; // the 10m default
  // Plenty of credential left: the budget is untouched.
  assert.equal(
    clampTurnBudgetToCredential(budget, now + 3_600_000, now),
    budget,
  );
  // The credential expires before the budget would end: clamp to remaining
  // life minus the margin, so the turn ends while renewal can still run.
  assert.equal(
    clampTurnBudgetToCredential(budget, now + 300_000, now),
    300_000 - TURN_BUDGET_CREDENTIAL_MARGIN_MS,
  );
  // The invariant itself: the clamped budget plus the margin never crosses expiry.
  for (const remaining of [90_000, 300_000, 599_000, 601_000, 3_600_000]) {
    const clamped = clampTurnBudgetToCredential(budget, now + remaining, now);
    assert.ok(
      clamped + TURN_BUDGET_CREDENTIAL_MARGIN_MS <= remaining || clamped === 1_000,
      `budget ${clamped} outlives a credential with ${remaining}ms left`,
    );
  }
  // Nearly-dead or dead credential: floor at 1s — the turn fails as the
  // recoverable timeout class instead of running past expiry.
  assert.equal(clampTurnBudgetToCredential(budget, now + 10_000, now), 1_000);
  assert.equal(clampTurnBudgetToCredential(budget, now - 1, now), 1_000);
  // No known expiry: nothing to clamp against (such a credential never renews either).
  assert.equal(clampTurnBudgetToCredential(budget, null, now), budget);
});

test("resolveTurnBudgetOrDefer enforces the invariant: a turn starts only with a credential proven to outlast it", () => {
  const now = 1_000_000_000_000;
  const budget = 600_000; // the 10m default

  // Happy path: plenty of credential left, renewal fine -> full clamped budget.
  assert.equal(resolveTurnBudgetOrDefer(budget, now + 3_600_000, now, false), budget);

  // Renewal FAILED at turn start -> defer, never a doomed turn on the old cred.
  assert.throws(
    () => resolveTurnBudgetOrDefer(budget, now + 3_600_000, now, true),
    (error) => error instanceof ListenerRenewalUnavailableError,
    "a failed renewal must defer even when the credential looks live",
  );

  // Credential already INSIDE the margin (<= margin remaining) -> defer.
  for (const remaining of [0, 1, 30_000, TURN_BUDGET_CREDENTIAL_MARGIN_MS]) {
    assert.throws(
      () => resolveTurnBudgetOrDefer(budget, now + remaining, now, false),
      (error) => error instanceof ListenerRenewalUnavailableError,
      `remaining ${remaining} is inside the margin and must defer`,
    );
  }
  // A dead (past-expiry) credential defers too — it never reaches the 1s floor.
  assert.throws(
    () => resolveTurnBudgetOrDefer(budget, now - 1, now, false),
    (error) => error instanceof ListenerRenewalUnavailableError,
  );

  // Just OUTSIDE the margin -> a live credential, turn allowed, clamped short.
  const justOutside = TURN_BUDGET_CREDENTIAL_MARGIN_MS + 5_000; // 65s remaining
  const applied = resolveTurnBudgetOrDefer(budget, now + justOutside, now, false);
  assert.ok(applied >= 1_000, "a live credential yields a runnable budget");
  assert.ok(
    applied + TURN_BUDGET_CREDENTIAL_MARGIN_MS <= justOutside || applied === 1_000,
    "the applied budget still cannot outlast the credential",
  );

  // The 1s floor is reachable ONLY for a live credential just over the margin
  // (rotation-due-soon), never a dead one.
  const nearFloor = TURN_BUDGET_CREDENTIAL_MARGIN_MS + 500; // 60.5s remaining
  assert.equal(resolveTurnBudgetOrDefer(budget, now + nearFloor, now, false), 1_000);

  // Unknown expiry (out of scope: such a credential never renews) -> no defer.
  assert.equal(resolveTurnBudgetOrDefer(budget, null, now, false), budget);
});
