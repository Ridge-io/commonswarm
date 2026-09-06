#!/usr/bin/env node
/** 20 directed asks; time post_signal accepted → listener_delivery_claim.ts. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const evidenceDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(join(evidenceDir, "fixture.json"), "utf8"));
const outDir = join(evidenceDir, "probes");
mkdirSync(outDir, { recursive: true });
const afterState = process.env.AFTER_STATE || join(evidenceDir, "state/after");
const sender = JSON.parse(readFileSync(fixture.creds.sender, "utf8")).agent_token;

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

const evPath = findEvents(afterState);
if (!evPath) throw new Error("no events.ndjson");

function claims() {
  return readFileSync(evPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.event === "listener_delivery_claim" && r.signal_id);
}

async function postAsk(body) {
  const startedMs = Date.now();
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
  return {
    signalId: json.signal.id,
    createdAt: json.signal.created_at ?? null,
    startedMs,
    acceptedAtMs,
  };
}

// Positive control: anon client on the live wake topic.
const liveWakeId = spawnSync(
  "docker",
  [
    "exec",
    "supabase_db_cloud-swarm",
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-At",
    "-c",
    `SELECT wake_id FROM swarm.agent_principals WHERE principal_id = '${fixture.listener_principal_id}'`,
  ],
  { encoding: "utf8" },
).stdout.trim();
const topic = `cswarm-wake:${liveWakeId}`;
const anon = createClient(fixture.api_url, fixture.anon_key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
await anon.realtime.setAuth(fixture.anon_key);
let controlFrames = 0;
const channel = anon.channel(topic, {
  config: { private: true, broadcast: { ack: false, self: false } },
});
const subStatus = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("anon subscribe timeout")), 10_000);
  channel.on("broadcast", { event: "wake" }, () => {
    controlFrames += 1;
  });
  channel.subscribe((s) => {
    if (s === "SUBSCRIBED" || s === "CHANNEL_ERROR" || s === "TIMED_OUT") {
      clearTimeout(t);
      resolve(s);
    }
  });
});
writeFileSync(
  join(outDir, "anon-subscribe.json"),
  JSON.stringify({ status: subStatus, topicLength: topic.length, prefix: "cswarm-wake:" }, null, 2) + "\n",
);
console.log("anon subscribe", subStatus);

const results = [];
for (let i = 1; i <= 20; i++) {
  const posted = await postAsk(`l7-wake-latency-${i}`);
  const deadline = Date.now() + 15_000;
  let claim = null;
  while (Date.now() < deadline && !claim) {
    claim = claims().find((r) => r.signal_id === posted.signalId) ?? null;
    if (!claim) await delay(20);
  }
  const latencyMs = claim ? Date.parse(claim.ts) - posted.acceptedAtMs : null;
  const row = {
    n: i,
    signalId: posted.signalId,
    createdAt: posted.createdAt,
    acceptedAt: new Date(posted.acceptedAtMs).toISOString(),
    claimTs: claim ? claim.ts : null,
    latencyMs,
    timedOut: !claim,
  };
  results.push(row);
  console.log(`trial ${i} latencyMs=${latencyMs} timedOut=${!claim} frames=${controlFrames}`);
}
const nums = results.map((r) => r.latencyMs).filter((n) => typeof n === "number");
const stats = nums.length
  ? {
      n: nums.length,
      mean: nums.reduce((a, b) => a + b, 0) / nums.length,
      max: Math.max(...nums),
      min: Math.min(...nums),
    }
  : { n: 0, mean: null, max: null, min: null };

const statusPath = join(afterState, "status-window-end.json");
const outName = process.env.WAKE_LATENCY_OUT || "wake-latency.json";
const out = {
  method:
    "post_signal acceptedAt (Date.now after HTTP 200 JSON) to events.ndjson listener_delivery_claim.ts. Sequential 20 trials, 15s each. Anon supabase-js client on the same wake topic is the positive control that the trigger sent.",
  afterState,
  anonSubscribe: subStatus,
  anonControlFrames: controlFrames,
  listenerWake: existsSync(statusPath)
    ? JSON.parse(readFileSync(statusPath, "utf8")).wake
    : null,
  results,
  stats,
};
writeFileSync(join(outDir, outName), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(stats, null, 2));
console.log("anon frames", controlFrames, "claimed", stats.n);
anon.realtime.disconnect();
if (stats.n !== 20) process.exit(2);
