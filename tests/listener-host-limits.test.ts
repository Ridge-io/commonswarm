/**
 * Exact copy/JSON tests for provider-aware listen host_limits.
 * ★ Named in npm test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  listenerHostLimits,
  listenerStatusJson,
  renderListenerStatus,
} from "../src/cli.js";
import { OPENCODE_FORCED_PERMISSION_TOOLS } from "../src/host/bounds.js";
import type { ListenerStatus } from "../src/listener/control.js";
import {
  emptyListenerReadHealth,
  recordListenerReadRetry,
} from "../src/listener/read-health.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("listenerHostLimits opencode states DISABLE_PROJECT_CONFIG probe, not private-home alone", () => {
  const limits = listenerHostLimits("opencode");
  assert.equal(typeof limits.host_configuration, "string");
  assert.equal(typeof limits.deny_canary_scope, "string");
  assert.equal(typeof limits.steady_allow_unproven, "string");
  assert.equal(typeof limits.cross_owner_context, "string");
  assert.equal(typeof limits.local_state_lifecycle, "string");
  assert.equal(typeof limits.human_copy, "string");

  const text = limits.human_copy;
  assert.match(text, /OPENCODE_DISABLE_PROJECT_CONFIG/);
  assert.match(text, /effective-config probe|debug config --pure/);
  assert.match(text, /private 0700 auth\/config home/i);
  assert.doesNotMatch(
    text,
    /private home alone|unless the adapter uses a private home/i,
  );
  assert.match(text, /does not prove steady-state/);
  assert.match(text, /--permissions allow|allow behavior/);
  assert.match(limits.local_state_lifecycle, /retained on shutdown failure/);
  assert.match(limits.cross_owner_context, /same worker and project context/);
  assert.doesNotMatch(text, /fresh auth-only home|empty cwd/);
});

test("listenerHostLimits grok does not claim OpenCode project-config disable", () => {
  const limits = listenerHostLimits("grok");
  assert.equal(typeof limits.host_configuration, "string");
  assert.equal(typeof limits.deny_canary_scope, "string");
  assert.equal(typeof limits.steady_allow_unproven, "string");
  assert.equal(typeof limits.cross_owner_context, "string");
  assert.equal(typeof limits.local_state_lifecycle, "string");

  const text = limits.human_copy;
  assert.doesNotMatch(text, /OPENCODE_DISABLE_PROJECT_CONFIG/);
  assert.match(text, /Grok|local Grok configuration/i);
  assert.match(text, /does not prove steady-state/);
  assert.match(text, /same worker and local context/);
  assert.match(text, /user and cmux hooks/);
  assert.doesNotMatch(text, /clean temporary home|empty cwd|hooks are disabled/);
});

test("listenerHostLimits claude states measured auth and no temporary lifecycle", () => {
  const limits = listenerHostLimits("claude");
  assert.match(limits.host_configuration, /claude-agent-acp 0\.64\.2/i);
  assert.match(limits.host_configuration, /keychain\/OAuth/i);
  assert.match(limits.host_configuration, /ANTHROPIC_API_KEY is stripped/);
  assert.match(limits.local_state_lifecycle, /does not create a separate Claude home/i);
  assert.match(limits.local_state_lifecycle, /temporary worker cwd/i);
  assert.doesNotMatch(limits.human_copy, /private 0700|isolated|canary cwd/i);
});

test("listenerHostLimits codex states explicit read-only mode and auth boundary", () => {
  const limits = listenerHostLimits("codex");
  assert.match(limits.host_configuration, /codex-acp 1\.1\.9/i);
  assert.match(limits.host_configuration, /explicitly selects read-only mode/i);
  assert.match(limits.host_configuration, /API-key variables are stripped/i);
  assert.match(limits.local_state_lifecycle, /does not create a separate Codex home/i);
  assert.match(limits.local_state_lifecycle, /temporary worker cwd/i);
  assert.doesNotMatch(limits.human_copy, /private 0700|isolated|canary cwd/i);
});

test("bounds.ts does not claim wildcard stops project allow merging", () => {
  const source = readFileSync(
    resolve("src/host/bounds.ts"),
    "utf8",
  );
  assert.match(source, /OPENCODE_DISABLE_PROJECT_CONFIG/);
  assert.match(source, /secondary/);
  assert.doesNotMatch(
    source,
    /wildcard covers future tools so ambient project allow cannot bypass/,
  );
  assert.ok(OPENCODE_FORCED_PERMISSION_TOOLS.includes("*"));
  assert.ok(OPENCODE_FORCED_PERMISSION_TOOLS.includes("bash"));
});

test("listenerStatusJson emits host_limits as a structured object, not a string", () => {
  const status: ListenerStatus = {
    version: 1,
    instanceId: "inst_1",
    profileId: "prof_1",
    workspaceId: "ws_1",
    state: "ready",
    provider: "opencode",
    principalId: "prn_1",
    pid: 1234,
    startedAt: "2026-07-31T00:00:00Z",
    readyAt: "2026-07-31T00:00:01Z",
    updatedAt: "2026-07-31T00:00:01Z",
    stoppedAt: null,
    lastSignalId: null,
    lastErrorCode: null,
    lastErrorDetail: null,
    lastWorkerStderrTail: null,
    deliveryMode: null,
    pendingDeliveryCount: null,
    lastTerminalDeliveryFailureCount: null,
    lastTerminalDeliveryFailureAt: null,
    lastClaimAt: null,
    lastAckAt: null,
    lastAckOutcome: null,
    consecutiveAckFailureCount: null,
    logPath: "/tmp/log",
  };
  const json = listenerStatusJson(status, "deny");
  assert.equal(typeof json.host_limits, "object");
  assert.notEqual(json.host_limits, null);
  const limits = json.host_limits as Record<string, unknown>;
  assert.equal(typeof limits.host_configuration, "string");
  assert.equal(typeof limits.local_state_lifecycle, "string");
  assert.equal(typeof limits.human_copy, "string");
  assert.match(String(limits.local_state_lifecycle), /retained on shutdown failure/);
});

function readHealthStatus(readHealth: ListenerStatus["readHealth"]): ListenerStatus {
  return {
    version: 1,
    instanceId: "44444444-4444-4444-8444-444444444444",
    provider: "claude",
    profileId: "profile-read-health",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    principalId: "22222222-2222-4222-8222-222222222222",
    pid: 1234,
    state: "ready",
    startedAt: "2026-09-01T10:00:00.000Z",
    readyAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    stoppedAt: null,
    lastSignalId: null,
    lastErrorCode: null,
    lastErrorDetail: null,
    lastWorkerStderrTail: null,
    deliveryMode: "durable_claim",
    pendingDeliveryCount: 0,
    lastTerminalDeliveryFailureCount: null,
    lastTerminalDeliveryFailureAt: null,
    lastClaimAt: null,
    lastAckAt: null,
    lastAckOutcome: null,
    consecutiveAckFailureCount: null,
    routeMode: "worker",
    deferOverChars: null,
    pendingForMainCount: 0,
    droppedForMainCount: 0,
    readHealth,
    logPath: "/tmp/events.ndjson",
  };
}

test("listen status warns at a 60s current read lapse, not below it", () => {
  const startedAt = "2026-09-01T10:30:00.000Z";
  const health = recordListenerReadRetry(emptyListenerReadHealth(), {
    ts: startedAt,
    episodeStartedAt: startedAt,
    episodeAttempt: 1,
    failure: {
      code: "no_response",
      httpStatus: null,
      errorConstructor: null,
    },
  });
  const status = readHealthStatus(health);
  const below = renderListenerStatus(
    status,
    undefined,
    Date.parse(startedAt) + 59_999,
  );
  assert.doesNotMatch(below, /listener_read_retry_persisting/);
  assert.match(below, /^Listener ready /);

  const thresholdMs = Date.parse(startedAt) + 60_000;
  const warning = renderListenerStatus(status, undefined, thresholdMs);
  assert.match(warning, /^Listener LAPSE /);
  assert.match(warning, /WARNING \[listener_read_retry_persisting\]/);
  assert.match(warning, /This is still in progress/);
  assert.match(warning, /Next: Check cswarm status.*restart the listener/);
  const json = listenerStatusJson(status, undefined, undefined, thresholdMs);
  assert.equal(json.listenerLapse, true);
  assert.deepEqual(json.listenerLapseCodes, ["listener_read_retry_persisting"]);
});

test("listen status raises host port exhaustion immediately and probes slowly", () => {
  const startedAt = "2026-09-01T10:30:00.000Z";
  const health = recordListenerReadRetry(emptyListenerReadHealth(), {
    ts: startedAt,
    episodeStartedAt: startedAt,
    episodeAttempt: 1,
    failure: {
      code: "host_ports_exhausted",
      httpStatus: null,
      errorConstructor: null,
    },
  });
  const rendered = renderListenerStatus(
    readHealthStatus(health),
    undefined,
    Date.parse(startedAt) + 1,
  );
  assert.match(rendered, /^Listener LAPSE /);
  assert.match(rendered, /WARNING \[listener_host_ports_exhausted\]/);
  assert.match(rendered, /run out of outbound ports/);
  assert.match(
    rendered,
    /lsof -nP -iTCP \| awk '\{print \$1\}' \| sort \| uniq -c \| sort -rn/,
  );
});

test("a full-hour claim ratio below 0.50 is a host lapse; 0.50 is not", () => {
  const lowHealth = {
    ...emptyListenerReadHealth(),
    claimCadenceMs: 3_600,
    claimHours: [{
      hourStart: "2026-09-01T10:00:00.000Z",
      claims: 499,
    }],
  };
  const atHourEnd = Date.parse("2026-09-01T11:00:00.000Z");
  const low = renderListenerStatus(
    readHealthStatus(lowHealth),
    undefined,
    atHourEnd,
  );
  assert.match(low, /^Listener LAPSE /);
  assert.match(low, /499\/1000 expected \(0\.499\)/);
  /* RETIRED (2026-09-04). The exact 0.1.50 string, on ONE unwrapped line so a reader who pastes
     it out of a running listener matches it here:
     "This host is starving the listener \u2014 check load/memory pressure (sysctl kern.memorystatus_vm_pressure_level), or move the listener."
     It named ONE cause with confidence. The first reader it reached measured pressure level 1,
     zero swapouts, four TIME_WAIT sockets and an empty queue before working out the answer was
     CPU contention from their own foreground work.

     A first replacement was failed by a review arm for the same sin in new words, and those are
     retired here too: "Nothing was lost" (the pending count is a snapshot now, not a statement
     about the lapse hour), "waiting on CommonSwarm rather than on this host" and "not waiting on
     CommonSwarm" (host_ports_exhausted is a retry AND a host fault; a slow-but-successful read
     records nothing), "without any host fault", and "Bursty foreground work on the same host
     produces this shape". Every one of them attributed a cause nothing had measured. */
  assert.doesNotMatch(low, /starving the listener/i);
  assert.doesNotMatch(low, /Nothing was lost/);
  assert.doesNotMatch(low, /not waiting on CommonSwarm/);
  assert.doesNotMatch(low, /Bursty foreground work/);
  assert.match(low, /the reads were not FAILING/);
  assert.match(low, /does not settle whether they were SLOW/);
  assert.match(low, /measured nothing else about that hour, and nothing about the host/);
  /* It must not claim the host was unmeasured full stop: the ports notice can print above it,
     and that IS a host measurement. */
  assert.match(low, /read any other notice above before looking further/);
  assert.match(low, /Cheapest checks first: load average \(uptime\)/);
  /* What is pending is on the warning line, as the COUNT. */
  assert.match(low, /Pending deliveries now: 0\./);

  /* With read retries in the same hour the reading points at the reads — and it must NOT say
     where the fault was, because a port-exhausted host produces retries too. */
  const retryHour = (retries: number) => ({
    hourStart: "2026-09-01T10:00:00.000Z",
    retries,
    episodes: 1,
    longestEpisodeAttempts: retries,
    longestEpisodeDurationMs: 1_000 * retries,
  });
  const retrying = renderListenerStatus(
    readHealthStatus({ ...lowHealth, retryHours: [retryHour(7)] }),
    undefined,
    atHourEnd,
  );
  assert.match(retrying, /Reads also failed in that hour: 7 retries recorded\./);
  assert.match(retrying, /A retry does not say where the fault was/);
  assert.doesNotMatch(retrying, /rather than on this host/);
  assert.doesNotMatch(retrying, /without any host fault/);

  const oneRetry = renderListenerStatus(
    readHealthStatus({ ...lowHealth, retryHours: [retryHour(1)] }),
    undefined,
    atHourEnd,
  );
  assert.match(oneRetry, /1 retry recorded\./);

  /* Ports exhausted AND a lapse in one status: the two notices must not contradict each other.
     This is the pairing the first replacement got wrong. */
  const exhausted = renderListenerStatus(
    readHealthStatus({
      ...lowHealth,
      currentReasonCode: "host_ports_exhausted",
      retryHours: [retryHour(7)],
    }),
    undefined,
    atHourEnd,
  );
  assert.match(exhausted, /run out of outbound ports/);
  assert.match(exhausted, /A retry does not say where the fault was/);
  assert.doesNotMatch(exhausted, /rather than on this host/);

  /* Every shape the pending count can take, because each one is a different sentence. */
  const pendingStatus = readHealthStatus(lowHealth);
  for (const [count, expected] of [[3, /Pending deliveries now: 3\./], [1, /Pending deliveries now: 1\./]] as const) {
    assert.match(
      renderListenerStatus({ ...pendingStatus, pendingDeliveryCount: count }, undefined, atHourEnd),
      expected,
    );
  }
  const withUnknownPending = renderListenerStatus(
    { ...pendingStatus, pendingDeliveryCount: null },
    undefined,
    atHourEnd,
  );
  assert.match(withUnknownPending, /No pending count was recorded\./);
  assert.doesNotMatch(withUnknownPending, /Pending deliveries now:/);
  /* Not "the service did not report it": an ack clears the count locally too. */
  assert.doesNotMatch(withUnknownPending, /service did not report/);

  const thresholdHealth = {
    ...lowHealth,
    claimHours: [{
      hourStart: "2026-09-01T10:00:00.000Z",
      claims: 500,
    }],
  };
  const threshold = renderListenerStatus(
    readHealthStatus(thresholdHealth),
    undefined,
    atHourEnd,
  );
  assert.doesNotMatch(threshold, /listener_claim_throughput_lapse/);
  assert.match(threshold, /^Listener ready /);
});
