#!/usr/bin/env node
/**
 * L7 measurements 3–6 against the local stack:
 *  3. wake latency, 20 directed asks
 *  4. Realtime container stopped: detection + 5 asks + time back to push
 *  5. wake trigger disabled: 3 asks
 *  6. rotation: two tokens, revoke one, resubscribe, old topic refused
 *
 * Uses the 0.1.58 listener already running in state/after from measure-idle-cost.sh,
 * or starts one. Does not write to production.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";

const here = dirname(fileURLToPath(import.meta.url));
const evidenceDir = join(here, "..");
const fixture = JSON.parse(readFileSync(join(evidenceDir, "fixture.json"), "utf8"));
const outDir = join(evidenceDir, "probes");
mkdirSync(outDir, { recursive: true });

const AFTER_BIN = join(evidenceDir, "bin/v0.1.58/cswarm");
const FAKE_GROK = join(here, "fake-grok.mjs");
const REALTIME_CONTAINER = "supabase_realtime_cloud-swarm";

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  appendFileSync(join(outDir, "run.log"), line + "\n");
}

function psql(sql) {
  const r = spawnSync(
    "docker",
    ["exec", "supabase_db_cloud-swarm", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", sql],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

async function postCommand(bearer, command) {
  const started = Date.now();
  const response = await fetch(`${fixture.api_url}/functions/v1/command`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command_id: randomUUID(),
      client_version: "0.1.0",
      workspace_id: fixture.workspace_id,
      stream: { kind: "workspace" },
      command,
    }),
  });
  const body = await response.json();
  return { status: response.status, body, acceptedAtMs: Date.now(), startedMs: started };
}

function listen(bin, verb, tokenFile, stateDir, extra = []) {
  const args = [
    "listen",
    verb,
    "--agent-token-file",
    tokenFile,
    "--url",
    fixture.api_url,
    "--anon-key",
    fixture.anon_key,
    "--workspace-id",
    fixture.workspace_id,
    "--state-dir",
    stateDir,
    "--json",
    ...extra,
  ];
  const r = spawnSync(bin, args, { encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

function statusOf(stateDir, tokenFile = fixture.creds.listener_token1) {
  const r = listen(AFTER_BIN, "status", tokenFile, stateDir);
  if (r.code !== 0) return { ok: false, raw: r };
  try {
    return { ok: true, body: JSON.parse(r.stdout), raw: r };
  } catch {
    return { ok: false, raw: r };
  }
}

function eventsPath(stateDir) {
  const st = statusOf(stateDir);
  if (st.ok && typeof st.body.logPath === "string") return st.body.logPath;
  return null;
}

function readEvents(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function waitForClaim(stateDir, signalId, timeoutMs) {
  const path = eventsPath(stateDir);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = readEvents(path).find(
      (row) => row.event === "listener_delivery_claim" && row.signal_id === signalId,
    );
    if (hit) return hit;
    await delay(50);
  }
  return null;
}

async function waitUntilIdle(stateDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = statusOf(stateDir);
    if (
      st.ok &&
      st.body.state === "ready" &&
      (st.body.currentDeliverySignalId === null || st.body.currentDeliverySignalId === undefined) &&
      (st.body.pendingDeliveryCount === 0 || st.body.pendingDeliveryCount === undefined)
    ) {
      return st.body;
    }
    await delay(100);
  }
  throw new Error("listener did not return to idle");
}

async function waitForWakeMode(stateDir, mode, timeoutMs) {
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const st = statusOf(stateDir);
    last = st.ok ? st.body : last;
    const got = st.ok ? (st.body.wake && st.body.wake.mode) : null;
    if (got === mode) {
      return { ms: Date.now() - t0, status: st.body };
    }
    await delay(200);
  }
  return { ms: null, status: last, timeoutMs };
}

async function postAsk(body) {
  const result = await postCommand(readToken(fixture.creds.sender), {
    kind: "post_signal",
    signal_kind: "ask",
    body,
    to_user_id: null,
    to_agent_principal_id: fixture.listener_principal_id,
    in_reply_to: null,
    about: null,
  });
  if (result.status !== 200 || result.body.status !== "accepted") {
    throw new Error(`post_signal failed: ${result.status} ${JSON.stringify(result.body)}`);
  }
  const signal = result.body.signal;
  if (!signal || typeof signal.id !== "string") {
    throw new Error(`post_signal accepted without signal.id: ${JSON.stringify(result.body)}`);
  }
  return {
    signalId: signal.id,
    createdAt: typeof signal.created_at === "string" ? signal.created_at : null,
    acceptedAtMs: result.acceptedAtMs,
    startedMs: result.startedMs,
    body: result.body,
  };
}

function readToken(path) {
  const artifact = JSON.parse(readFileSync(path, "utf8"));
  return artifact.agent_token;
}

async function trialAsk(stateDir, label, timeoutMs) {
  await waitUntilIdle(stateDir, 30_000);
  const posted = await postAsk(label);
  const claim = await waitForClaim(stateDir, posted.signalId, timeoutMs);
  const latencyMs = claim
    ? Date.parse(claim.ts) - posted.acceptedAtMs
    : null;
  return {
    label,
    signalId: posted.signalId,
    createdAt: posted.createdAt,
    acceptedAt: new Date(posted.acceptedAtMs).toISOString(),
    claimTs: claim ? claim.ts : null,
    latencyMs,
    timedOut: claim === null,
    timeoutMs,
  };
}

const afterState = join(evidenceDir, "state/after");

async function ensureAfterListener() {
  const st = statusOf(afterState);
  if (st.ok && st.body.state === "ready") return st.body;
  log("after listener not ready; starting 0.1.58");
  const cwd = join(evidenceDir, "cwd/after");
  const grokHome = join(evidenceDir, "grok-home/after");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(grokHome, { recursive: true });
  writeFileSync(join(grokHome, "auth.json"), JSON.stringify({ access_token: "fake-local-login" }), {
    mode: 0o600,
  });
  const start = spawnSync(
    AFTER_BIN,
    [
      "listen",
      "start",
      "--agent-token-file",
      fixture.creds.listener_token1,
      "--url",
      fixture.api_url,
      "--anon-key",
      fixture.anon_key,
      "--workspace-id",
      fixture.workspace_id,
      "--provider",
      "grok",
      "--grok-executable",
      FAKE_GROK,
      "--cwd",
      cwd,
      "--permissions",
      "deny",
      "--allow-unattended",
      "--route",
      "worker",
      "--state-dir",
      afterState,
      "--json",
    ],
    { encoding: "utf8", env: { ...process.env, GROK_HOME: grokHome } },
  );
  writeFileSync(join(outDir, "after-start.json"), start.stdout || start.stderr);
  const push = await waitForWakeMode(afterState, "push", 30_000);
  if (push.ms === null) throw new Error("0.1.58 listener did not reach mode=push");
  return push.status;
}

function stats(values) {
  const nums = values.filter((n) => typeof n === "number" && Number.isFinite(n));
  if (nums.length === 0) return { n: 0, mean: null, max: null, min: null };
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  return { n: nums.length, mean, max: Math.max(...nums), min: Math.min(...nums) };
}

log("ensure after listener");
const ready = await ensureAfterListener();
writeFileSync(join(outDir, "status-before-probes.json"), JSON.stringify(ready, null, 2) + "\n");

log("3. wake latency, 20 directed asks");
const wakeTrials = [];
for (let i = 1; i <= 20; i++) {
  const row = await trialAsk(afterState, `l7-wake-latency-${i}`, 15_000);
  log(`  trial ${i} latencyMs=${row.latencyMs} signal=${row.signalId} timedOut=${row.timedOut}`);
  wakeTrials.push(row);
}
const wakeStats = stats(wakeTrials.map((t) => t.latencyMs));
writeFileSync(
  join(outDir, "wake-latency.json"),
  JSON.stringify({ method: "post_signal acceptedAt (Date.now after 200 JSON) to events.ndjson listener_delivery_claim.ts", trials: wakeTrials, stats: wakeStats }, null, 2) + "\n",
);

log("5. wake dropped (disable trigger), 3 asks posted together");
psql("ALTER TABLE swarm.signal_deliveries DISABLE TRIGGER signal_deliveries_wake_agent;");
const triggerState = psql("SELECT tgenabled FROM pg_trigger WHERE tgname = 'signal_deliveries_wake_agent';");
log(`  trigger enabled flag after disable: ${triggerState} (D=disabled, O=origin)`);
await waitUntilIdle(afterState, 30_000);
const droppedPosted = [];
for (let i = 1; i <= 3; i++) {
  droppedPosted.push(await postAsk(`l7-wake-dropped-${i}`));
}
const droppedTrials = [];
for (const posted of droppedPosted) {
  const claim = await waitForClaim(afterState, posted.signalId, 330_000);
  const row = {
    label: posted.body?.signal ? "dropped" : "dropped",
    signalId: posted.signalId,
    createdAt: posted.createdAt,
    acceptedAt: new Date(posted.acceptedAtMs).toISOString(),
    claimTs: claim ? claim.ts : null,
    latencyMs: claim ? Date.parse(claim.ts) - posted.acceptedAtMs : null,
    timedOut: claim === null,
    timeoutMs: 330_000,
  };
  log(`  dropped ${posted.signalId} latencyMs=${row.latencyMs} timedOut=${row.timedOut}`);
  droppedTrials.push(row);
}
psql("ALTER TABLE swarm.signal_deliveries ENABLE TRIGGER signal_deliveries_wake_agent;");
const triggerState2 = psql("SELECT tgenabled FROM pg_trigger WHERE tgname = 'signal_deliveries_wake_agent';");
log(`  trigger re-enabled: ${triggerState2}`);
writeFileSync(
  join(outDir, "wake-dropped.json"),
  JSON.stringify({ method: "ALTER TABLE swarm.signal_deliveries DISABLE TRIGGER signal_deliveries_wake_agent; then 3 asks; latency from post_signal accepted to listener_delivery_claim.ts", trigger_after_disable: triggerState, trigger_after_enable: triggerState2, trials: droppedTrials, stats: stats(droppedTrials.map((t) => t.latencyMs)) }, null, 2) + "\n",
);

log("6. rotation: two listeners, revoke token1, token2 must resubscribe, old topic refused");
const rot1 = join(evidenceDir, "state/rotation-token1");
const rot2 = join(evidenceDir, "state/rotation-token2");
listen(AFTER_BIN, "stop", fixture.creds.listener_token1, afterState);
await delay(2000);

function startListener(tokenFile, stateDir, grokName) {
  mkdirSync(stateDir, { recursive: true });
  const cwd = join(evidenceDir, "cwd", grokName);
  const grokHome = join(evidenceDir, "grok-home", grokName);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(grokHome, { recursive: true });
  writeFileSync(join(grokHome, "auth.json"), JSON.stringify({ access_token: "fake-local-login" }), {
    mode: 0o600,
  });
  const r = spawnSync(
    AFTER_BIN,
    [
      "listen",
      "start",
      "--agent-token-file",
      tokenFile,
      "--url",
      fixture.api_url,
      "--anon-key",
      fixture.anon_key,
      "--workspace-id",
      fixture.workspace_id,
      "--provider",
      "grok",
      "--grok-executable",
      FAKE_GROK,
      "--cwd",
      cwd,
      "--permissions",
      "deny",
      "--allow-unattended",
      "--route",
      "worker",
      "--state-dir",
      stateDir,
      "--json",
    ],
    { encoding: "utf8", env: { ...process.env, GROK_HOME: grokHome } },
  );
  writeFileSync(join(outDir, `${grokName}-start.json`), r.stdout || r.stderr);
  if (r.status !== 0) throw new Error(`listen start ${grokName} failed: ${r.stderr}\n${r.stdout}`);
}

startListener(fixture.creds.listener_token1, rot1, "rotation-token1");
startListener(fixture.creds.listener_token2, rot2, "rotation-token2");
const rot1Push = await waitForWakeMode(rot1, "push", 30_000);
const rot2Push = await waitForWakeMode(rot2, "push", 30_000);
writeFileSync(join(outDir, "rotation-status-before.json"), JSON.stringify({ token1: rot1Push, token2: rot2Push }, null, 2) + "\n");
const oldWakeId = psql(`SELECT wake_id FROM swarm.agent_principals WHERE principal_id = '${fixture.listener_principal_id}'`);
log(`  old wake_id=${oldWakeId}`);

const revokeStarted = Date.now();
const revoked = await postCommand(fixture.owner_jwt, {
  kind: "revoke_agent_token",
  token_id: fixture.token1_id,
});
writeFileSync(join(outDir, "revoke-token1.json"), JSON.stringify(revoked, null, 2) + "\n");
if (revoked.status !== 200) throw new Error(`revoke failed: ${JSON.stringify(revoked)}`);
const newWakeId = psql(`SELECT wake_id FROM swarm.agent_principals WHERE principal_id = '${fixture.listener_principal_id}'`);
log(`  new wake_id=${newWakeId} changed=${newWakeId !== oldWakeId}`);

const resub = await waitForWakeMode(rot2, "push", 330_000);
const resubMs = Date.now() - revokeStarted;
const rot2After = statusOf(rot2);
writeFileSync(
  join(outDir, "rotation.json"),
  JSON.stringify({
    method: "two listeners on two live tokens of one principal; owner JWT revoke_agent_token on token1; time until token2 listen status wake.mode=push after rotate; old topic join as anon",
    oldWakeId,
    newWakeId,
    revoke: { status: revoked.status, bodyStatus: revoked.body.status },
    resubscribeMs: resub.ms === null ? null : resubMs,
    token2StatusAfter: rot2After.ok ? rot2After.body : rot2After.raw,
    token1StatusAfter: statusOf(rot1, fixture.creds.listener_token1),
  }, null, 2) + "\n",
);

log("  old topic join as anon (expect CHANNEL_ERROR)");
const anonClient = createClient(fixture.api_url, fixture.anon_key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
await anonClient.realtime.setAuth(fixture.anon_key);
const oldTopic = `cswarm-wake:${oldWakeId}`;
const newTopic = `cswarm-wake:${newWakeId}`;
function joinTopic(topic) {
  return new Promise((resolve) => {
    const channel = anonClient.channel(topic, {
      config: { private: true, broadcast: { ack: false, self: false } },
    });
    const timer = setTimeout(() => {
      resolve({ topic, status: "timeout" });
    }, 8_000);
    channel.subscribe((next) => {
      if (next === "SUBSCRIBED" || next === "CHANNEL_ERROR" || next === "TIMED_OUT") {
        clearTimeout(timer);
        resolve({ topic, status: next });
      }
    });
  });
}
const oldJoin = await joinTopic(oldTopic);
const newJoin = await joinTopic(newTopic);
writeFileSync(join(outDir, "rotation-topics.json"), JSON.stringify({ oldJoin, newJoin, oldTopicRedacted: `cswarm-wake:<old ${oldWakeId.length} chars>`, newTopicRedacted: `cswarm-wake:<new ${newWakeId.length} chars>` }, null, 2) + "\n");
log(`  old topic join=${oldJoin.status} new topic join=${newJoin.status}`);
anonClient.realtime.disconnect();

listen(AFTER_BIN, "stop", fixture.creds.listener_token1, rot1);
listen(AFTER_BIN, "stop", fixture.creds.listener_token2, rot2);
await delay(2000);

log("4. Realtime down: stop container, detection, 5 asks, restart, time to push");
startListener(fixture.creds.listener_token2, afterState, "after-rejoin");
const pushBeforeDown = await waitForWakeMode(afterState, "push", 30_000);
writeFileSync(join(outDir, "status-before-realtime-stop.json"), JSON.stringify(pushBeforeDown, null, 2) + "\n");
const stopStarted = Date.now();
execFileSync("docker", ["stop", REALTIME_CONTAINER], { encoding: "utf8" });
const detect = await waitForWakeMode(afterState, "poll", 80_000);
const detectMs = Date.now() - stopStarted;
log(`  detection to poll: ${detect.ms} ms (wall ${detectMs})`);
const downTrials = [];
for (let i = 1; i <= 5; i++) {
  const row = await trialAsk(afterState, `l7-realtime-down-${i}`, 90_000);
  log(`  down ${i} latencyMs=${row.latencyMs} timedOut=${row.timedOut}`);
  downTrials.push(row);
}
const startStarted = Date.now();
execFileSync("docker", ["start", REALTIME_CONTAINER], { encoding: "utf8" });
const back = await waitForWakeMode(afterState, "push", 80_000);
const backMs = Date.now() - startStarted;
log(`  back to push: ${back.ms} ms (wall ${backMs})`);
writeFileSync(
  join(outDir, "realtime-down.json"),
  JSON.stringify({
    method: "docker stop supabase_realtime_cloud-swarm; listen status wake.mode poll; 5 asks; docker start; time to wake.mode push",
    detectPollMs: detect.ms,
    detectPollWallMs: detectMs,
    detectStatus: detect.status && detect.status.wake,
    downTrials,
    downStats: stats(downTrials.map((t) => t.latencyMs)),
    backToPushMs: back.ms,
    backToPushWallMs: backMs,
    backStatus: back.status && back.status.wake,
  }, null, 2) + "\n",
);

writeFileSync(
  join(outDir, "summary.json"),
  JSON.stringify({
    wakeLatency: wakeStats,
    dropped: stats(droppedTrials.map((t) => t.latencyMs)),
    realtimeDown: {
      detectPollMs: detect.ms,
      down: stats(downTrials.map((t) => t.latencyMs)),
      backToPushMs: back.ms,
    },
    rotation: { oldWakeChanged: newWakeId !== oldWakeId, resubscribeWallMs: resubMs, oldJoin: oldJoin.status, newJoin: newJoin.status },
  }, null, 2) + "\n",
);

log("probes done");
