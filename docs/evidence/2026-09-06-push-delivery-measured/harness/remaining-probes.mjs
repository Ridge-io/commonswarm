#!/usr/bin/env node
/**
 * Remaining L7 probes against the already-running 0.1.58 listener:
 *  4. stop Realtime container, detection + 5 asks, restart, time back to push
 *  5. disable wake trigger, 3 asks (short wait: 0.1.58 already misses wakes)
 *  6. two tokens, revoke one, resubscribe / old topic refused
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";

const evidenceDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(join(evidenceDir, "fixture.json"), "utf8"));
const outDir = join(evidenceDir, "probes");
mkdirSync(outDir, { recursive: true });
const AFTER_BIN = join(evidenceDir, "bin/v0.1.58/cswarm");
const FAKE_GROK = join(evidenceDir, "harness/fake-grok.mjs");
const REALTIME = "supabase_realtime_cloud-swarm";
const sender = JSON.parse(readFileSync(fixture.creds.sender, "utf8")).agent_token;
const LIVE_TOKEN = process.env.LIVE_TOKEN_KEY || "listener_token2";
const liveTokenFile = fixture.creds[LIVE_TOKEN];

function findEvents(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      const inner = findEvents(p);
      if (inner) return inner;
    } else if (name === "events.ndjson") return p;
  }
  return null;
}

function listenStatus(stateDir, tokenFile) {
  const r = spawnSync(
    AFTER_BIN,
    [
      "listen",
      "status",
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
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return { ok: false, stderr: r.stderr, stdout: r.stdout };
  return { ok: true, body: JSON.parse(r.stdout) };
}

function listenStop(stateDir, tokenFile) {
  spawnSync(
    AFTER_BIN,
    [
      "listen",
      "stop",
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
    ],
    { encoding: "utf8" },
  );
}

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
  writeFileSync(join(outDir, `${grokName}-start.json`), r.stdout || r.stderr || "");
  if (r.status !== 0) throw new Error(`start ${grokName}: ${r.stderr}\n${r.stdout}`);
}

async function waitMode(stateDir, tokenFile, mode, timeoutMs) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const st = listenStatus(stateDir, tokenFile);
    last = st.ok ? st.body : last;
    const got = st.ok ? st.body?.wake?.mode : null;
    if (got === mode) return { ms: Date.now() - t0, status: st.body };
    await delay(200);
  }
  return { ms: null, status: last, timeoutMs };
}

async function postAsk(body) {
  const response = await fetch(`${fixture.api_url}/functions/v1/command`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sender}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command_id: randomUUID(),
      client_version: "0.1.0",
      workspace_id: fixture.workspace_id,
      stream: { kind: "workspace" },
      command: {
        kind: "post_signal",
        signal_kind: "ask",
        body,
        to_user_id: null,
        to_agent_principal_id: fixture.listener_principal_id,
        in_reply_to: null,
        about: null,
      },
    }),
  });
  const json = await response.json();
  const acceptedAtMs = Date.now();
  if (response.status !== 200 || json.status !== "accepted") {
    throw new Error(`post failed ${response.status} ${JSON.stringify(json)}`);
  }
  return { signalId: json.signal.id, createdAt: json.signal.created_at, acceptedAtMs };
}

function claims(stateDir) {
  const p = findEvents(stateDir);
  if (!p) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.event === "listener_delivery_claim" && r.signal_id);
}

async function waitClaim(stateDir, signalId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = claims(stateDir).find((r) => r.signal_id === signalId);
    if (hit) return hit;
    await delay(50);
  }
  return null;
}

function psql(sql) {
  const r = spawnSync(
    "docker",
    ["exec", "supabase_db_cloud-swarm", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", sql],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return r.stdout.trim();
}

function log(msg) {
  console.log(`${new Date().toISOString()} ${msg}`);
}

const afterState = process.env.AFTER_STATE || join(evidenceDir, "state/after");

// --- 5. trigger off (short: 0.1.58 already misses wakes) ---
log("5. disable trigger, 3 asks posted together, wait up to 330s");
psql("ALTER TABLE swarm.signal_deliveries DISABLE TRIGGER signal_deliveries_wake_agent;");
const triggerOff = psql("SELECT tgenabled FROM pg_trigger WHERE tgname = 'signal_deliveries_wake_agent';");
const droppedPosted = [];
for (let i = 1; i <= 3; i++) droppedPosted.push(await postAsk(`l7-trigger-off-${i}`));
const dropped = [];
for (const posted of droppedPosted) {
  const claim = await waitClaim(afterState, posted.signalId, 330_000);
  dropped.push({
    signalId: posted.signalId,
    acceptedAt: new Date(posted.acceptedAtMs).toISOString(),
    claimTs: claim?.ts ?? null,
    latencyMs: claim ? Date.parse(claim.ts) - posted.acceptedAtMs : null,
    timedOut: !claim,
  });
  log(`  dropped ${posted.signalId} claimed=${!!claim} latencyMs=${dropped.at(-1).latencyMs}`);
}
psql("ALTER TABLE swarm.signal_deliveries ENABLE TRIGGER signal_deliveries_wake_agent;");
const triggerOn = psql("SELECT tgenabled FROM pg_trigger WHERE tgname = 'signal_deliveries_wake_agent';");
writeFileSync(
  join(outDir, "wake-dropped.json"),
  JSON.stringify({
    method: "ALTER TABLE swarm.signal_deliveries DISABLE TRIGGER signal_deliveries_wake_agent; 3 asks; 20s wait (0.1.58 already missed wakes with trigger ON, so 330s would not add information)",
    triggerOff,
    triggerOn,
    trials: dropped,
  }, null, 2) + "\n",
);

// --- 4. realtime down ---
log("4. docker stop realtime");
const beforeDown = listenStatus(afterState, liveTokenFile);
writeFileSync(join(outDir, "status-before-realtime-stop.json"), JSON.stringify(beforeDown, null, 2) + "\n");
const stopAt = Date.now();
execFileSync("docker", ["stop", REALTIME], { encoding: "utf8" });
const detect = await waitMode(afterState, liveTokenFile, "poll", 80_000);
log(`  detect poll ms=${detect.ms} mode=${detect.status?.wake?.mode}`);
const downTrials = [];
for (let i = 1; i <= 5; i++) {
  const posted = await postAsk(`l7-realtime-down-${i}`);
  const claim = await waitClaim(afterState, posted.signalId, 90_000);
  downTrials.push({
    signalId: posted.signalId,
    acceptedAt: new Date(posted.acceptedAtMs).toISOString(),
    claimTs: claim?.ts ?? null,
    latencyMs: claim ? Date.parse(claim.ts) - posted.acceptedAtMs : null,
    timedOut: !claim,
  });
  log(`  down ${i} claimed=${!!claim} latencyMs=${downTrials.at(-1).latencyMs}`);
}
const startAt = Date.now();
execFileSync("docker", ["start", REALTIME], { encoding: "utf8" });
await delay(2000);
const back = await waitMode(afterState, liveTokenFile, "push", 80_000);
log(`  back to push ms=${back.ms} mode=${back.status?.wake?.mode}`);
writeFileSync(
  join(outDir, "realtime-down.json"),
  JSON.stringify({
    method: "docker stop supabase_realtime_cloud-swarm; wait listen status wake.mode=poll; 5 asks; docker start; wait push",
    detectPollMs: detect.ms,
    detectWallMs: Date.now() - stopAt,
    detectWake: detect.status?.wake ?? null,
    downTrials,
    backToPushMs: back.ms,
    backWallMs: Date.now() - startAt,
    backWake: back.status?.wake ?? null,
  }, null, 2) + "\n",
);

// --- 6. rotation ---
if (process.env.SKIP_ROTATION === "1") {
  log("6. rotation skipped (SKIP_ROTATION=1)");
  log("remaining probes done");
  process.exit(0);
}
log("6. rotation");
listenStop(afterState, liveTokenFile);
await delay(2000);
const rot1 = join(evidenceDir, "state/rotation-token1");
const rot2 = join(evidenceDir, "state/rotation-token2");
startListener(fixture.creds.listener_token1, rot1, "rotation-token1");
startListener(fixture.creds.listener_token2, rot2, "rotation-token2");
const r1 = await waitMode(rot1, fixture.creds.listener_token1, "push", 30_000);
const r2 = await waitMode(rot2, fixture.creds.listener_token2, "push", 30_000);
const oldWakeId = psql(`SELECT wake_id FROM swarm.agent_principals WHERE principal_id = '${fixture.listener_principal_id}'`);
log(`  old wake_id len=${oldWakeId.length} token1push=${r1.ms} token2push=${r2.ms}`);
const revokeAt = Date.now();
const revoked = await fetch(`${fixture.api_url}/functions/v1/command`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${fixture.owner_jwt}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    command_id: randomUUID(),
    client_version: "0.1.0",
    workspace_id: fixture.workspace_id,
    stream: { kind: "workspace" },
    command: { kind: "revoke_agent_token", token_id: fixture.token1_id },
  }),
});
const revokeBody = await revoked.json();
writeFileSync(join(outDir, "revoke-token1.json"), JSON.stringify({ status: revoked.status, body: revokeBody }, null, 2) + "\n");
const newWakeId = psql(`SELECT wake_id FROM swarm.agent_principals WHERE principal_id = '${fixture.listener_principal_id}'`);
log(`  wake_id changed=${oldWakeId !== newWakeId} revokeStatus=${revoked.status}`);
const resub = await waitMode(rot2, fixture.creds.listener_token2, "push", 60_000);
const rot2After = listenStatus(rot2, fixture.creds.listener_token2);

const anon = createClient(fixture.api_url, fixture.anon_key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
await anon.realtime.setAuth(fixture.anon_key);
function joinTopic(topic) {
  return new Promise((resolve) => {
    const channel = anon.channel(topic, {
      config: { private: true, broadcast: { ack: false, self: false } },
    });
    const timer = setTimeout(() => resolve({ topicPrefix: topic.slice(0, 12), status: "timeout" }), 8_000);
    channel.subscribe((next) => {
      if (next === "SUBSCRIBED" || next === "CHANNEL_ERROR" || next === "TIMED_OUT") {
        clearTimeout(timer);
        resolve({ topicPrefix: topic.slice(0, 12), status: next });
      }
    });
  });
}
const oldJoin = await joinTopic(`cswarm-wake:${oldWakeId}`);
const newJoin = await joinTopic(`cswarm-wake:${newWakeId}`);
anon.realtime.disconnect();
writeFileSync(
  join(outDir, "rotation.json"),
  JSON.stringify({
    method: "two 0.1.58 listeners, different --state-dir, same principal; owner revoke_agent_token on token1; time token2 wake.mode; anon join old vs new topic",
    oldWakeIdLength: oldWakeId.length,
    newWakeIdLength: newWakeId.length,
    wakeIdChanged: oldWakeId !== newWakeId,
    revokeStatus: revoked.status,
    revokeBodyStatus: revokeBody.status,
    token1PushMs: r1.ms,
    token2PushMs: r2.ms,
    token2AfterRevokeMode: rot2After.ok ? rot2After.body?.wake?.mode : null,
    token2AfterRevokeError: rot2After.ok ? rot2After.body?.wake?.errorCode : null,
    resubWaitMs: resub.ms,
    resubWallMs: Date.now() - revokeAt,
    oldJoin: oldJoin.status,
    newJoin: newJoin.status,
  }, null, 2) + "\n",
);
log(`  oldJoin=${oldJoin.status} newJoin=${newJoin.status} token2mode=${rot2After.ok ? rot2After.body?.wake?.mode : "err"}`);
listenStop(rot1, fixture.creds.listener_token1);
listenStop(rot2, fixture.creds.listener_token2);
log("remaining probes done");
