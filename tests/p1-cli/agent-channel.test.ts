import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { saveAgentProfile, parseAgentConnection } from "../../src/cloud/agent-profile.js";
import { configureAgentReceive, readReceiveBinding, receiveHookEvent, receiveStatus, requestReceiveCanary } from "../../src/cloud/agent-receive.js";

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

test("stdio channel emits an idle canary, requires this session's receipt, and stops on turn mode", { timeout: 25_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-channel-control-"));
  const cwd = join(root, "project");
  await mkdir(cwd);
  const profile = join(root, "agent", "profile.json");
  let signal: Record<string, unknown> | null = null;
  const posts: unknown[] = [], acks: unknown[] = [];
  let acked = false;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", data => raw += data);
    req.on("end", () => {
      const body = JSON.parse(raw);
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
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  let client = new Client({ name: "test-host-no-model", version: "1" });
  const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
  client.fallbackNotificationHandler = async notification => { notifications.push(notification); };
  let stderr = "";
  let transport: StdioClientTransport | undefined;
  try {
    await saveAgentProfile(profile, parseAgentConnection(JSON.stringify({
      version: 1, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, anon_key: "fixture-key", workspace_id: WS, principal_id: AGENT,
      credential: { message: AGENT_CREDENTIAL_MESSAGE_D088, status: "accepted", principal_id: AGENT, token_id: "11111111-1111-4111-8111-111111111111", run_id: "22222222-2222-4222-8222-222222222222", agent_token: TOKEN, expires_at: "2099-01-01T00:00:00.000Z" },
    })));
    const options = { profilePath: profile, mode: "wake", provider: "claude", hostSessionId: "host-session", cwd, previewChannel: true, execution: { command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"))] } };
    await configureAgentReceive(options);
    transport = new StdioClientTransport({ command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js")), "receive", "serve", "--profile", profile, "--host-session-id", "host-session"],
      env: { PATH: process.env.PATH ?? "", SWARM_AGENT_STATE_DIR: join(root, "renewal"), XDG_CONFIG_HOME: join(root, "config") }, stderr: "pipe" });
    transport.stderr?.on("data", chunk => stderr += chunk);
    await client.connect(transport);
    assert.ok(client.getServerCapabilities()?.experimental?.["claude/channel"]);
    assert.equal((await client.listTools()).tools.length, 1);
    await requestReceiveCanary(profile, "host-session");
    await delay(300);
    assert.equal(posts.length, 0, "a busy session is not an idle wake control");
    assert.equal(receiveStatus(await readReceiveBinding(profile, "host-session")).wake_verified, false);
    await receiveHookEvent(profile, "host-session", { session_id: "host-session", cwd, hook_event_name: "Stop" });
    await eventually(() => notifications.some(n => n.method === "notifications/claude/channel"));
    const notification = notifications.find(n => n.method === "notifications/claude/channel")!;
    const meta = notification.params!.meta as Record<string, string>;
    assert.equal(meta.signal_id, SIGNAL);
    assert.equal(acks.length, 0, "sending to stdout is not a receipt");
    const wrong = await client.callTool({ name: "cswarm_received", arguments: { signal_id: SIGNAL, receipt: meta.receipt, host_session_id: "other-session" } });
    assert.equal(wrong.isError, true);
    assert.equal(acks.length, 0);
    await client.callTool({ name: "cswarm_received", arguments: { signal_id: SIGNAL, receipt: meta.receipt, host_session_id: "host-session" } });
    await eventually(async () => receiveStatus(await readReceiveBinding(profile, "host-session")).wake_verified);
    assert.equal(acks.length, 1);
    assert.equal(posts.length, 1);
    assert.equal(notifications.filter(n => n.method === "notifications/claude/channel").length, 1);
    await client.close();
    await transport.close();
    await eventually(async () => !receiveStatus(await readReceiveBinding(profile, "host-session")).channel_running);
    client = new Client({ name: "restarted-host-no-model", version: "1" });
    transport = new StdioClientTransport({ command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js")), "receive", "serve", "--profile", profile, "--host-session-id", "host-session"],
      env: { PATH: process.env.PATH ?? "", SWARM_AGENT_STATE_DIR: join(root, "renewal"), XDG_CONFIG_HOME: join(root, "config") }, stderr: "pipe" });
    transport.stderr?.on("data", chunk => stderr += chunk);
    await client.connect(transport);
    await receiveHookEvent(profile, "host-session", { session_id: "host-session", cwd, hook_event_name: "SessionStart" });
    await delay(150);
    const restarted = await readReceiveBinding(profile, "host-session");
    assert.equal(receiveStatus(restarted).wake_verified, false, "restart needs a new idle receipt");
    assert.equal(restarted!.canary!.emitted_while_idle, false);
    await configureAgentReceive({ ...options, mode: "turn", previewChannel: false });
    await eventually(async () => !receiveStatus(await readReceiveBinding(profile, "host-session")).channel_running);
    assert.equal(receiveStatus(await readReceiveBinding(profile, "host-session")).wake_verified, false);
    assert.equal(stderr.includes(TOKEN), false);
  } catch (error) { throw new Error(`${error instanceof Error ? error.message : error}\nChannel stderr: ${stderr}`, { cause: error }); }
  finally { await client.close(); await transport?.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true }); }
});
