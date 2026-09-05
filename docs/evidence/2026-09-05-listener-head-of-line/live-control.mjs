#!/usr/bin/env node
/**
 * Live control for lane/listener-head-of-line.
 *
 * Starts a REAL detached `cswarm listen start` with --state-dir <temp> against a
 * local fake command/read service and a fake ACP provider, then drives two
 * deliveries. The first provider turn never answers, so the seat is held; the
 * script captures `cswarm listen status --json` while it is held and again
 * after the hold budget releases it and the second delivery is claimed.
 *
 * Run:  node docs/evidence/2026-09-05-listener-head-of-line/live-control.mjs
 * Needs: npm run build (dist/cli.js).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cli = join(repoRoot, "dist", "cli.js");

const FAKE_PROVIDER = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  process.stdout.write("grok 0.2.117 (fake)\\n");
  process.exit(0);
}
let buffer = "";
let permissionId = 1000;
let workTurns = 0;
const pending = new Map();
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
function finishPrompt(hostId, text, optionId) {
  const canary = text.includes("CSWARM_CANARY_NOOP");
  const denied = optionId === "deny";
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "fake-session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: denied ? "denied" : "completed",
      },
    },
  });
  if (!canary) {
    workTurns += 1;
    if (workTurns === 1) {
      // The measured shape: an open-ended ask whose turn never answers.
      // Nothing is written here: the listener sanitizes the worker env, so a
      // file path passed through it is undefined and the child would exit.
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "second delivery reply" },
        },
      },
    });
  }
  send({ jsonrpc: "2.0", id: hostId, result: { stopReason: "end_turn" } });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          _meta: { agentVersion: "0.2.117" },
        },
      });
      continue;
    }
    if (message.method === "session/new") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          sessionId: "fake-session",
          modes: {
            currentModeId: "auto",
            availableModes: [{ id: "auto" }, { id: "default" }],
          },
        },
      });
      continue;
    }
    if (message.method === "session/set_mode") {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      continue;
    }
    if (message.method === "session/prompt") {
      const text = message.params?.prompt?.[0]?.text ?? "";
      const requestId = ++permissionId;
      pending.set(requestId, { hostId: message.id, text });
      send({
        jsonrpc: "2.0",
        id: requestId,
        method: "session/request_permission",
        params: {
          sessionId: "fake-session",
          toolCall: {
            toolCallId: "tool-1",
            title: "Fake tool",
            kind: "shell",
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
      });
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      const optionId = message.result?.outcome?.optionId ?? "cancelled";
      finishPrompt(item.hostId, item.text, optionId);
    }
  }
});
`;

const run = (args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const root = await mkdtemp(join(tmpdir(), "cswarm-hol-"));
  const workerCwd = await mkdtemp(join(tmpdir(), "cswarm-hol-cwd-"));
  const providerHome = join(root, "provider-home");
  await mkdir(providerHome, { mode: 0o700 });
  await writeFile(join(providerHome, "auth.json"), JSON.stringify({ access_token: "fake-local-login" }), { mode: 0o600 });
  const providerPath = join(root, "fake-grok.mjs");
  await writeFile(providerPath, FAKE_PROVIDER, { mode: 0o700 });
  await chmod(providerPath, 0o700);
  const auditPath = join(root, "provider-audit.log");
  await writeFile(auditPath, "");

  const workspaceId = randomUUID();
  const principalId = randomUUID();
  const token = `swm_agt_${"A".repeat(43)}`;
  const artifact = JSON.stringify({
    message:
      "Agent credential minted. It is bound to this task and run so the agent's work stays scoped and attributable.",
    status: "accepted",
    principal_id: principalId,
    token_id: randomUUID(),
    run_id: randomUUID(),
    agent_token: token,
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  });

  const mkAsk = (body) => ({
    id: randomUUID(),
    workspace_id: workspaceId,
    from: randomUUID(),
    from_kind: "agent",
    to: null,
    to_agent: principalId,
    in_reply_to: null,
    about: null,
    kind: "ask",
    body,
    until: new Date(Date.now() + 30 * 60_000).toISOString(),
    created_at: new Date().toISOString(),
    sender_owner_relation: "same_owner",
  });
  const asks = [mkAsk("first ask, open ended"), mkAsk("second ask, waits behind it")];
  const leaseIds = asks.map(() => randomUUID());
  const acked = new Set();
  const claimed = [];

  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    const json = (payload) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (request.url === "/functions/v1/read") {
      const parsed = JSON.parse(body);
      if (parsed.resource === "members") {
        const owner = randomUUID();
        return json({
          members: [{ user_id: owner, display_name: "Local Operator" }],
          agents: asks.map((ask) => ({ principal_id: ask.from, name: "Local Agent", owner_user_id: owner })),
        });
      }
      return json({
        signals: [],
        capabilities: { sender_owner_relation: 1, cursor_after: 1, delivery_claim: 1, delivery_ack: 1 },
        pending_delivery_count: asks.length - acked.size,
      });
    }
    if (request.url === "/functions/v1/command") {
      const parsed = JSON.parse(body);
      const command = parsed.command;
      if (command.kind === "claim_agent_inbox") {
        const index = asks.findIndex((ask) => !acked.has(ask.id) && !claimed.includes(ask.id));
        if (index !== -1) claimed.push(asks[index].id);
        return json({
          status: "accepted",
          ok: true,
          capabilities: { delivery_claim: 1, delivery_ack: 1, sender_owner_relation: 1 },
          deliveries: index === -1 ? [] : [{
            signal: asks[index],
            lease_id: leaseIds[index],
            leased_until: new Date(Date.now() + 10 * 60_000).toISOString(),
            sender_owner_relation: "same_owner",
          }],
          // Counts every unacked live delivery, the claimed one included.
          pending_delivery_count: asks.length - acked.size,
          terminal_delivery_failure_count: 0,
          event_ids: [],
          events: [],
          min_client_version: "0.1.0",
        });
      }
      if (command.kind === "ack_agent_delivery") {
        acked.add(String(command.signal_id));
        return json({ status: "accepted", ok: true, event_ids: [], events: [], signal_id: command.signal_id, outcome: command.outcome });
      }
      if (command.kind === "declare_agent_model") {
        return json({ status: "accepted", ok: true, event_ids: [], events: [] });
      }
      return json({
        status: "accepted",
        ok: true,
        event_ids: [],
        signal: { ...asks[0], id: randomUUID(), kind: "note", body: command.body, in_reply_to: command.in_reply_to, sender_owner_relation: undefined },
      });
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const common = ["--url", url, "--anon-key", "public-anon", "--workspace-id", workspaceId, "--state-dir", root];

  const started = await run([
    "listen", "start", "--provider", "grok", "--agent-token-stdin", ...common,
    "--cwd", workerCwd, "--permissions", "allow", "--grok-executable", providerPath,
    // 30s is the smallest --turn-budget the CLI accepts; it is also the seat
    // hold bound, so the whole control runs in under a minute.
    "--turn-budget", "30s", "--json",
  ], { stdin: artifact, env: { GROK_HOME: providerHome, CSWARM_FAKE_AUDIT: auditPath, SWARM_AGENT_TOKEN: token } });
  console.log("=== listen start ===");
  console.log(started.stdout.trim() || started.stderr.trim());
  if (started.code !== 0) {
    server.close();
    process.exit(1);
  }

  const status = async () =>
    await run(["listen", "status", ...common, "--principal-id", principalId, "--json"]);
  const human = async () =>
    await run(["listen", "status", ...common, "--principal-id", principalId]);

  const pick = (raw) => {
    const row = JSON.parse(raw);
    return {
      state: row.state,
      pendingDeliveryCount: row.pendingDeliveryCount,
      currentDeliverySignalId: row.currentDeliverySignalId,
      currentDeliverySince: row.currentDeliverySince,
      currentDeliveryElapsedMs: row.currentDeliveryElapsedMs,
      queueNonEmptySince: row.queueNonEmptySince,
      queueNonEmptyForMs: row.queueNonEmptyForMs,
      releasedDeliverySignalId: row.releasedDeliverySignalId,
      lastAckOutcome: row.lastAckOutcome,
      lastAckSignalId: row.lastAckSignalId,
    };
  };

  /* Sample the LIVE listener continuously and record every state change, so the
     evidence is a timeline rather than two snapshots that could each have been
     taken in the wrong second. */
  const label = (id) =>
    id === null || id === undefined
      ? "none"
      : id === asks[0].id
      ? "ask-1"
      : id === asks[1].id
      ? "ask-2"
      : id;
  const timeline = [];
  const startedAtMs = Date.now();
  let previous = "";
  for (let i = 0; i < 200; i += 1) {
    const snapshot = await status();
    if (snapshot.code === 0) {
      const row = pick(snapshot.stdout);
      const key = JSON.stringify([
        row.currentDeliverySignalId,
        row.releasedDeliverySignalId,
        row.pendingDeliveryCount,
        row.lastAckSignalId,
        row.lastAckOutcome,
      ]);
      if (key !== previous) {
        previous = key;
        timeline.push({
          atMs: Date.now() - startedAtMs,
          inHand: label(row.currentDeliverySignalId),
          currentDeliveryElapsedMs: row.currentDeliveryElapsedMs,
          pendingDeliveryCount: row.pendingDeliveryCount,
          queueNonEmptyForMs: row.queueNonEmptyForMs,
          heldBack: label(row.releasedDeliverySignalId),
          lastAck: label(row.lastAckSignalId),
          lastAckOutcome: row.lastAckOutcome,
          human: (await human()).stdout.split("\n").filter((line) =>
            /^(Working on delivery|No delivery is being worked|Deliveries waiting|Pending deliveries|Delivery [0-9a-f])/.test(line)
          ),
        });
      }
    }
    if (timeline.length >= 2 && label(pick((await status()).stdout).currentDeliverySignalId) === "none" &&
        timeline.some((entry) => entry.inHand === "ask-2")) {
      break;
    }
    await sleep(250);
  }
  console.log("\n=== LIVE timeline: one seat, two deliveries ===");
  console.log(JSON.stringify(timeline, null, 2));

  console.log("\n=== hold releases recorded in the listener log ===");
  const logPath = JSON.parse((await status()).stdout).logPath;
  const { readFile } = await import("node:fs/promises");
  const events = (await readFile(logPath, "utf8")).split("\n")
    .filter((line) => line.includes("listener_delivery_hold_released"));
  console.log(events.join("\n") || "none");

  console.log("\n=== first ask id ===\n" + asks[0].id);
  console.log("=== second ask id ===\n" + asks[1].id);
  console.log("=== acked signal ids ===\n" + ([...acked].join("\n") || "none"));

  await run(["listen", "stop", ...common, "--principal-id", principalId, "--json"]);
  server.close();
}

await main();
