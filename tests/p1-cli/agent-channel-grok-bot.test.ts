import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { serveGrokBotChannel, markGrokBotIdle } from "../../src/cloud/agent-channel-grok-bot.js";
import { confirmAgentChannel } from "../../src/cloud/agent-channel.js";
import { openGrokBotGateway, findGrokBotGateway } from "../../src/cloud/agent-grok-bot-gateway.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";

import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { saveAgentProfile, parseAgentConnection } from "../../src/cloud/agent-profile.js";
import { configureAgentReceive, readReceiveBinding, receiveStatus, requestReceiveCanary } from "../../src/cloud/agent-receive.js";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SIGNAL = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const LEASE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TOKEN = `swm_agt_${"C".repeat(43)}`;
async function eventually(check: () => boolean | Promise<boolean>, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(50); }
  assert.fail("condition did not become true before the deadline");
}

test("Grok Bot gateway canary requires explicit idle and matching CLI receipt before service ACK", { timeout: 25_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-channel-control-"));
  const cwd = join(root, "project");
  await mkdir(cwd);
  const profile = join(root, "agent", "profile.json");
  let signal: Record<string, unknown> | null = null;
  const posts: unknown[] = [], acks: unknown[] = [];
  let acked = false;
  const prompts: Array<{ agentId: string; prompt: string }> = [];
  const gatewayToken = "fixture_gateway_token";
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", data => raw += data);
    req.on("end", () => {
      const body = JSON.parse(raw);
      if (req.url === "/api/sendPrompt") {
        assert.equal(req.headers.authorization, `Bearer ${gatewayToken}`);
        assert.equal(req.headers["content-type"], "application/json");
        assert.deepEqual(Object.keys(body).sort(), ["agentId", "prompt"]);
        prompts.push(body);
        res.writeHead(200).end("{}"); return;
      }
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      let result: unknown;
      if (body.resource === "members") result = {
        members: [{ user_id: OWNER, display_name: "Owner" }],
        agents: [{ principal_id: AGENT, name: "Channel", owner_user_id: OWNER }],
        identity: { credential_valid: true, principal_id: AGENT, workspace_id: WS, owner_user_id: OWNER },
      };
      else if (body.command.kind === "post_signal") {
        posts.push(body.command);
        signal = { id: SIGNAL, workspace_id: WS, from: AGENT, from_kind: "agent", to: null, to_agent: AGENT,
          in_reply_to: null, about: null, kind: "note", body: body.command.body,
          created_at: new Date().toISOString(), until: new Date(Date.now() + 300_000).toISOString() };
        result = { ok: true, status: "accepted", event_ids: [], events: [], signal };
      } else if (body.command.kind === "claim_agent_inbox") result = {
        ok: true, status: "accepted", event_ids: [], events: [],
        capabilities: { delivery_claim: 1, delivery_ack: 1, sender_owner_relation: 1 },
        deliveries: signal && !acked ? [{ signal, lease_id: LEASE, leased_until: new Date(Date.now() + 60_000).toISOString(), sender_owner_relation: "same_owner" }] : [],
        pending_delivery_count: signal && !acked ? 1 : 0, terminal_delivery_failure_count: 0,
      };
      else if (body.command.kind === "ack_agent_delivery") {
        assert.equal(body.command.outcome, "observed");
        acks.push(body.command); acked = true;
        result = { ok: true, status: "accepted", event_ids: [], events: [], signal_id: SIGNAL, outcome: "observed" };
      } else { res.writeHead(400).end(); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    });
  });
  try {
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  let serving: Promise<void> | undefined;
  const previousState = process.env.SWARM_AGENT_STATE_DIR;
  process.env.SWARM_AGENT_STATE_DIR = join(root, "renewal");
  const gatewayPath = join(root, "gateway.json");
  const host = "9c3388a6-717b-4e94-b9c5-5e0733bb9078";
  const options = { profilePath: profile, mode: "wake", provider: "grok-bot", hostSessionId: host, cwd,
    gatewayPaths: [gatewayPath], execution: { command: process.execPath, args: [resolve("dist/cli.js")] } };
  try {
    await saveAgentProfile(profile, parseAgentConnection(JSON.stringify({
      version: 1, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, anon_key: "fixture-key", workspace_id: WS, principal_id: AGENT,
      credential: { message: AGENT_CREDENTIAL_MESSAGE_D088, status: "accepted", principal_id: AGENT, token_id: "11111111-1111-4111-8111-111111111111", run_id: "22222222-2222-4222-8222-222222222222", agent_token: TOKEN, expires_at: "2099-01-01T00:00:00.000Z" },
    })));
    await assert.rejects(configureAgentReceive(options), { code: "grok_bot_gateway_missing" });
    await writeFile(gatewayPath, JSON.stringify({ host: "0.0.0.0", port: (server.address() as { port: number }).port, token: gatewayToken }));
    const configured = await configureAgentReceive(options);
    assert.match(configured.host_step!, /cswarm receive serve/);
    assert.equal("start_command" in configured, false);
    assert.equal(configured.hook_file, null);
    await assert.rejects(stat(join(cwd, ".claude")), { code: "ENOENT" });
    await assert.rejects(stat(join(cwd, ".codex")), { code: "ENOENT" });
    assert.equal((await readReceiveBinding(profile, host))!.grok_bot_agent_id, host);
    await assert.rejects(configureAgentReceive({ ...options, grokBotAgentId: AGENT }), { code: "receive_provider_conflict" });
    await assert.rejects(configureAgentReceive({ ...options, hostSessionId: "not-a-uuid" }), { code: "grok_bot_agent_id_required" });
    await configureAgentReceive({ ...options, hostSessionId: "named-session", grokBotAgentId: host });
    assert.equal((await readReceiveBinding(profile, "named-session"))!.grok_bot_agent_id, host);
    serving = serveGrokBotChannel({ profilePath: profile, hostSessionId: host, gatewayPaths: [gatewayPath], env: {} });
    // Keep failures observable even if setup assertions fail before awaiting shutdown.
    void serving.catch(() => undefined);
    await eventually(async () => receiveStatus(await readReceiveBinding(profile, host)).channel_running);
    await requestReceiveCanary(profile, host);
    await delay(300);
    assert.equal(posts.length, 0, "starting serve does not prove idle");
    await markGrokBotIdle(profile, host);
    await eventually(() => prompts.length === 1);
    assert.equal(prompts[0]!.agentId, host);
    assert.match(prompts[0]!.prompt, /signal_id/);
    assert.equal(prompts[0]!.prompt.includes(gatewayToken), false);
    assert.equal(acks.length, 0, "HTTP acceptance is not a receipt");
    assert.equal(receiveStatus(await readReceiveBinding(profile, host)).wake_verified, false);
    const receipt = /Receipt challenge: ([0-9a-f-]+)\./.exec(prompts[0]!.prompt)![1]!;
    await assert.rejects(confirmAgentChannel({ profilePath: profile, hostSessionId: host, signalId: SIGNAL, receipt: AGENT }), { code: "channel_receipt_mismatch" });
    await assert.rejects(confirmAgentChannel({ profilePath: profile, hostSessionId: host, signalId: AGENT, receipt }), { code: "channel_receipt_mismatch" });
    const result = await promisify(execFile)(process.execPath, [resolve("dist/cli.js"), "receive", "confirm", "--profile", profile, "--host-session-id", host, "--signal-id", SIGNAL, "--receipt", receipt]);
    assert.equal(JSON.parse(result.stdout).state, "pending");
    await eventually(async () => receiveStatus(await readReceiveBinding(profile, host)).wake_verified);
    assert.equal(acks.length, 1);
    assert.equal(posts.length, 1);
    assert.equal((await readReceiveBinding(profile, host))!.canary!.emitted_while_idle, true);
    await configureAgentReceive({ ...options, mode: "turn" });
    await serving;
    assert.equal(receiveStatus(await readReceiveBinding(profile, host)).channel_running, false);
  } finally {
    if (serving) {
      await configureAgentReceive({ ...options, mode: "turn" }).catch(() => undefined);
      await serving;
    }
    if (previousState === undefined) delete process.env.SWARM_AGENT_STATE_DIR;
    else process.env.SWARM_AGENT_STATE_DIR = previousState;
    await new Promise<void>(done => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});

test("gateway descriptor precedence, loopback address, failure redaction, and redirect refusal", async () => {
  const root = await mkdtemp(join(tmpdir(), "grok-gateway-"));
  try {
    const first = join(root, "first.json"), second = join(root, "second.json");
    await writeFile(second, JSON.stringify({ host: "0.0.0.0", token: "fixture_secret", port: 2345 }));
    assert.equal(await findGrokBotGateway([first, second]), second);
    await writeFile(first, JSON.stringify({ host: "untrusted.example", token: "fixture_secret", port: 3456 }));
    assert.equal(await findGrokBotGateway([first, second]), first);
    for (const [env, port] of [[{}, 3456], [{ SAND_HOST_PORT: "4567" }, 4567]] as const) {
      const gateway = await openGrokBotGateway({ paths: [first, second], env, fetcher: (async (url, init) => {
        assert.equal(url, `http://127.0.0.1:${port}/api/sendPrompt`);
        assert.equal(init?.redirect, "error");
        throw new Error("fixture_secret");
      }) as typeof fetch });
      await assert.rejects(gateway.sendPrompt(AGENT, "fixture"), error => {
        assert.equal((error as Error).message.includes("fixture_secret"), false); return true;
      });
    }
    await writeFile(first, "null");
    await assert.rejects(openGrokBotGateway({ paths: [first], env: {} }), { code: "grok_bot_gateway_invalid" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
