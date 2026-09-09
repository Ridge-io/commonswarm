import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { AGENT_CONNECTION_VERSION } from "../../src/cloud/agent-onboarding-contract.js";
import { AgentSetupError, parseAgentConnection, readAgentProfile } from "../../src/cloud/agent-profile.js";
import { setupAgent } from "../../src/cloud/agent-setup.js";
import { cachedAgentMessage, checkAgentMessages, renderAgentCheck, withAgentDeadline } from "../../src/cloud/agent-check.js";
import { configureAgentReceive, mergeReceiveHooks, readReceiveBinding, receiveHookEvent, receiveStatus } from "../../src/cloud/agent-receive.js";
import { ChannelReceiptGate } from "../../src/cloud/agent-channel.js";
import type { SignalRecord } from "../../src/cloud/command-client.js";
import type { DeliveryRow } from "../../src/cloud/delivery.js";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TOKEN = `swm_agt_${"A".repeat(43)}`;
let root: string;
let previousState: string | undefined;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "cswarm-onboarding-"));
  previousState = process.env.SWARM_AGENT_STATE_DIR;
  process.env.SWARM_AGENT_STATE_DIR = join(root, "renewal");
});
after(async () => {
  if (previousState === undefined) delete process.env.SWARM_AGENT_STATE_DIR;
  else process.env.SWARM_AGENT_STATE_DIR = previousState;
  await rm(root, { recursive: true, force: true });
});

function artifact(principal = AGENT) {
  return { message: AGENT_CREDENTIAL_MESSAGE_D088, status: "accepted", principal_id: principal,
    token_id: "11111111-1111-4111-8111-111111111111", run_id: "22222222-2222-4222-8222-222222222222",
    agent_token: TOKEN, expires_at: "2099-01-01T00:00:00.000Z" };
}
function connection(url = "https://fixture.example", principal = AGENT) {
  return { version: AGENT_CONNECTION_VERSION, url, anon_key: "public-fixture", workspace_id: WS, principal_id: principal, credential: artifact(principal) };
}
function row(i: number, body = `message ${i}`): SignalRecord {
  return { id: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`, workspace_id: WS,
    from: OWNER, from_kind: "user", to: null, to_agent: AGENT, in_reply_to: null, about: null, kind: i % 2 ? "ask" : "note",
    body, until: "2099-01-01T00:00:00.000Z", created_at: "2026-09-08T00:00:00.000Z", sender_owner_relation: "same_owner" };
}
function fixture(rows: SignalRecord[] = [], principal = AGENT) {
  const requests: Array<Record<string, unknown>> = [];
  const fetcher = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TOKEN}`);
    assert.equal(init?.redirect, "error", "credentials must not follow a redirect");
    let result;
    if (body.resource === "members") result = {
      members: [{ user_id: OWNER, display_name: "Owner" }],
      agents: [{ principal_id: principal, name: "Test agent", owner_user_id: OWNER }],
      identity: { credential_valid: true, principal_id: principal, workspace_id: WS, owner_user_id: OWNER },
    };
    else if (body.resource === "signals") result = {
      signals: rows.filter(r => !body.after_id || r.id > body.after_id).slice(0, body.limit),
      capabilities: { sender_owner_relation: 1, cursor_after: 1 },
    };
    else throw new Error("unexpected request");
    return new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  return { fetcher, requests };
}
async function saveInput(envelope = connection()) {
  const dir = await mkdtemp(join(root, "input-"));
  const path = join(dir, "connection.json");
  await writeFile(path, JSON.stringify(envelope), { mode: 0o600 });
  return path;
}
async function setup(rows: SignalRecord[] = []) {
  const input = await saveInput();
  const profilePath = join(dirname(input), "agent", "profile.json");
  const fake = fixture(rows);
  const result = await setupAgent({ connectionFile: input, profilePath, fetcher: fake.fetcher });
  return { input, profilePath, fake, result };
}

async function cli(args: string[], input?: string) {
  const child = spawn(process.execPath, [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js")), ...args], {
    env: { ...process.env, SWARM_AGENT_STATE_DIR: join(root, "renewal"), XDG_CONFIG_HOME: join(root, "config") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => stdout += chunk);
  child.stderr.on("data", chunk => stderr += chunk);
  child.stdin.end(input);
  const code = await new Promise<number>((done, reject) => {
    child.once("error", reject); child.once("close", code => done(code ?? 1));
  });
  return { code, stdout, stderr };
}

test("connection envelope validates version, exact fields, origin, and full agent identity", () => {
  assert.equal(parseAgentConnection(JSON.stringify(connection())).principal_id, AGENT);
  for (const bad of [
    { ...connection(), version: 2 }, { ...connection(), extra: true },
    { ...connection(), principal_id: OTHER }, { ...connection(), url: "https://fixture.example/?secret=1" },
    { ...connection(), url: "http://fixture.example" }, { ...connection(), credential: { agent_token: TOKEN } },
  ]) assert.throws(() => parseAgentConnection(JSON.stringify(bad)));
});

test("setup checks identity before saving and starts no receiver", async () => {
  const input = await saveInput();
  const path = join(dirname(input), "agent", "profile.json");
  const wrong = fixture([], OTHER);
  await assert.rejects(setupAgent({ connectionFile: input, profilePath: path, fetcher: wrong.fetcher }), { code: "authenticated_identity_mismatch" });
  await assert.rejects(lstat(path), { code: "ENOENT" });
  const fake = fixture();
  const result = await setupAgent({ connectionFile: input, profilePath: path, fetcher: fake.fetcher });
  assert.equal(result.connected, true);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal((await lstat(dirname(path))).mode & 0o777, 0o700);
  assert.deepEqual(fake.requests.map(r => r.resource).sort(), ["members", "signals"]);
  assert.equal(await readReceiveBinding(path), null);
});

test("setup refuses unsafe input and never writes credentials under a repo", async () => {
  const input = await saveInput();
  await chmod(input, 0o644);
  await assert.rejects(setupAgent({ connectionFile: input, fetcher: fixture().fetcher }));
  await chmod(input, 0o600);
  const repo = join(dirname(input), "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  await assert.rejects(setupAgent({ connectionFile: input, profilePath: join(repo, "private", "profile.json"), fetcher: fixture().fetcher }), { code: "profile_inside_repository" });
  const link = join(dirname(input), "link.json");
  await symlink(input, link);
  await assert.rejects(setupAgent({ connectionFile: link, fetcher: fixture().fetcher }));
});

test("repeat setup preserves receive choice; a profile cannot be replaced by another identity", async () => {
  const { input, profilePath, fake } = await setup();
  await configureAgentReceive({ profilePath, mode: "turn", execution: { command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"))] } });
  const before = await readReceiveBinding(profilePath);
  await setupAgent({ connectionFile: input, profilePath, fetcher: fake.fetcher });
  assert.deepEqual(await readReceiveBinding(profilePath), before);
  const other = await saveInput(connection("https://fixture.example", OTHER));
  await assert.rejects(setupAgent({ connectionFile: other, profilePath, fetcher: fixture([], OTHER).fetcher }), { code: "profile_conflict" });
  assert.equal((await readAgentProfile(profilePath)).principal_id, AGENT);
});

test("standalone checks drain tied timestamps and overflow without a listener or ACK", async () => {
  const rows = Array.from({ length: 45 }, (_, i) => row(i + 1, "x".repeat(1200)));
  const { profilePath, fake } = await setup(rows);
  const seen: string[] = [];
  let more = true;
  while (more) {
    const result = await checkAgentMessages({ profilePath, fetcher: fake.fetcher, present: async result => { seen.push(...result.messages.map(m => m.id)); } });
    more = result.has_more;
  }
  assert.deepEqual(seen, rows.map(r => r.id));
  assert.ok(fake.requests.every(r => r.resource === "members" || r.resource === "signals"));
  const quiet = await checkAgentMessages({ profilePath, hostSessionId: "resumed-session", fetcher: fake.fetcher, present: async () => {} });
  assert.equal(quiet.messages.length, 0, "resume shares the profile cursor");
  assert.equal(renderAgentCheck(quiet), "");
  assert.equal(quiet.cached, false);
  assert.equal((await cachedAgentMessage(profilePath, rows[0]!.id)).body.length, 1200);
});

test("output failure does not advance the cursor; a fresh check is not a cooldown", async () => {
  const { profilePath, fake } = await setup([row(1)]);
  await assert.rejects(checkAgentMessages({ profilePath, fetcher: fake.fetcher, present: async () => { throw new Error("closed output"); } }));
  let shown = 0;
  await checkAgentMessages({ profilePath, fetcher: fake.fetcher, present: async r => { shown += r.messages.length; } });
  assert.equal(shown, 1);
  const next = fixture([row(1), row(2)]);
  await checkAgentMessages({ profilePath, fetcher: next.fetcher, present: async r => { shown += r.messages.length; } });
  assert.equal(shown, 2);
});

test("check stops at wrong-recipient and out-of-order pages without consuming them", async () => {
  for (const rows of [[row(2), row(1)], [{ ...row(1), to_agent: OTHER }]]) {
    const { profilePath } = await setup();
    await assert.rejects(checkAgentMessages({ profilePath, fetcher: fixture(rows).fetcher, present: async () => assert.fail("must not show a bad page") }));
    const result = await checkAgentMessages({ profilePath, fetcher: fixture([row(1)]).fetcher, present: async () => {} });
    assert.equal(result.messages.length, 1);
  }
});

test("deadline completes even if the transport ignores cancellation", async () => {
  const started = performance.now();
  await assert.rejects(withAgentDeadline(25, async fetcher => fetcher("https://fixture.example"), (() => new Promise(() => {})) as typeof fetch), { code: "check_timeout" });
  assert.ok(performance.now() - started < 500);
});

test("hook merge keeps unrelated handlers and repeated install does not duplicate ours", () => {
  const base = { other: true, hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-agent" }] }] } };
  const first = mergeReceiveHooks(base, "my-check", null, false);
  assert.deepEqual(mergeReceiveHooks(first, "my-check", "my-check", false), first);
  assert.equal(JSON.stringify(first).includes("other-agent"), true);
  assert.equal(JSON.stringify(first).includes("Stop"), false);
});

test("Claude hook verifies only the configured session; Stop records idle without reading messages", async () => {
  const { profilePath } = await setup();
  const cwd = await mkdtemp(join(root, "project-"));
  const result = await configureAgentReceive({ profilePath, mode: "turn", provider: "claude", hostSessionId: "session-one", cwd, execution: { command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"))] } });
  assert.equal(result.turn_check, "pending_host");
  assert.deepEqual(await receiveHookEvent(profilePath, "session-one", { session_id: "session-two", cwd, hook_event_name: "UserPromptSubmit" }), { check: false, provider: null });
  assert.equal((await readReceiveBinding(profilePath, "session-one"))!.turn_verified_at, null);
  assert.equal((await receiveHookEvent(profilePath, "session-one", { session_id: "session-one", cwd, hook_event_name: "UserPromptSubmit" })).check, true);
  assert.equal(receiveStatus(await readReceiveBinding(profilePath, "session-one")).turn_check, "verified");
  assert.equal((await receiveHookEvent(profilePath, "session-one", { session_id: "session-one", cwd, hook_event_name: "Stop" })).check, false);
  assert.equal((await readReceiveBinding(profilePath, "session-one"))!.idle, true);
});

test("wake requires explicit preview choice and cannot claim support on Codex", async () => {
  const { profilePath } = await setup();
  const common = { profilePath, mode: "wake", hostSessionId: "session-one", execution: { command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"))] } };
  await assert.rejects(configureAgentReceive({ ...common, provider: "codex" }), { code: "wake_host_unsupported" });
  await assert.rejects(configureAgentReceive({ ...common, provider: "claude" }), { code: "wake_preview_consent_required" });
  assert.equal(receiveStatus(null).wake_verified, false);
});

test("channel receipt requires the pending challenge and the same session", () => {
  const delivery: DeliveryRow = { signal: row(1), leaseId: "11111111-2222-4222-8222-222222222222", leasedUntil: "2099-01-01T00:00:00.000Z", senderOwnerRelation: "same_owner", recipientPosition: 0, recipientCount: 1 };
  const gate = new ChannelReceiptGate("session-one", { row: delivery, receipt: "challenge", ack_command_id: "cmd_12345678", confirmed: false });
  assert.throws(() => gate.confirm(row(1).id, "challenge", "session-two"), { code: "channel_receipt_mismatch" });
  assert.throws(() => gate.confirm(row(1).id, "wrong", "session-one"), { code: "channel_receipt_mismatch" });
  assert.equal(gate.pending!.confirmed, false);
  assert.equal(gate.confirm(row(1).id, "challenge", "session-one").confirmed, true);
});

test("CLI setup and profile feed work against an HTTP fixture without exposing secrets", async () => {
  const fake = fixture([row(1)]);
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", data => raw += data);
    req.on("end", () => { void (async () => {
      const response = await fake.fetcher("http://fixture", { body: raw, headers: req.headers as Record<string, string>, redirect: "error" });
      res.writeHead(response.status, { "content-type": "application/json" }); res.end(await response.text());
    })().catch(() => res.writeHead(500).end()); });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browserPromptModule = "../../site/src/components/connect/agent-prompt.js";
    const { dashboardAgentPrompt } = await import(browserPromptModule);
    const prompt = dashboardAgentPrompt({
      credential: { principalId: AGENT, principalName: "Test agent", tokenId: artifact().token_id,
        runId: artifact().run_id, token: TOKEN, expiresAt: Date.parse(artifact().expires_at),
        renews: true, horizonExpiresAt: null, grantKind: "standing" },
      workspaceId: WS, workspaceName: "Fixture", deploymentUrl: url, anonKey: "public_fixture",
    });
    const raw = prompt.match(/\bCSWARMA\.[A-Z2-7]+\.[A-Z2-7]+\b/)?.[0] ?? prompt.match(/```json\n([^]*?)\n```/)?.[1];
    assert.ok(raw);
    const input = await saveInput();
    await writeFile(input, raw);
    const profile = join(dirname(input), "saved", "profile.json");
    const run = await cli(["setup", "--connection-file", input, "--profile", profile, "--json"]);
    assert.equal(run.code, 0, run.stderr || run.stdout);
    assert.equal(JSON.parse(run.stdout).connected, true);
    const feed = await cli(["feed", "--profile", profile, "--json"]);
    assert.equal(feed.code, 0, feed.stderr);
    assert.match(feed.stdout, /message 1/);
    assert.equal((run.stdout + run.stderr + feed.stdout + feed.stderr).includes(TOKEN), false);
    const conflict = await cli(["feed", "--profile", profile, "--workspace-id", WS]);
    assert.equal(conflict.code, 1);
    assert.match(conflict.stderr, /Do not combine/);
    const malformed = await cli(["setup", "--connection-file", "/does-not-exist/private/file", "--json"]);
    assert.equal(malformed.code, 1);
    assert.equal(JSON.parse(malformed.stdout).ok, false);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});

test("host detection uses the closest process and stops at another host", async () => {
  const { detectAgentHost } = await import("../../src/cloud/agent-host.js");
  const tree = new Map([[10, { parent: 11, executable: "/bin/zsh" }], [11, { parent: 12, executable: "/usr/local/bin/codex" }], [12, { parent: 1, executable: "/usr/local/bin/claude" }]]);
  assert.equal(await detectAgentHost(async pid => tree.get(pid) ?? null, 10), "codex");
  tree.set(11, { parent: 12, executable: "/usr/local/bin/grok" });
  assert.equal(await detectAgentHost(async pid => tree.get(pid) ?? null, 10), "unknown");
  assert.equal(await detectAgentHost(async () => null, 10), "unknown");
});

test("managed profile checks use only the named host's proof", async () => {
  const { newSessionBinding, defaultSessionContextPath, writeSessionContext } = await import("../../src/cloud/session-context.js");
  const { profileSessionContext, profileTarget } = await import("../../src/cloud/agent-profile.js");
  const { AGENT_SESSION_ID_HEADER } = await import("../../src/cloud/session-contract.js");
  const { profilePath, fake } = await setup();
  const profile = await readAgentProfile(profilePath);
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, "managed-config");
  try {
    const context = { ...newSessionBinding({ target: profileTarget(profile), workspaceId: WS, principalId: AGENT, provider: "codex", mode: "interactive", hostSessionId: "this-session", tokenFile: profile.credential_file }), generation: 1 };
    const path = defaultSessionContextPath(WS, AGENT, context.session_id);
    await writeSessionContext(path, context);
    assert.equal((await profileSessionContext(profile, "this-session"))!.path, path);
    await assert.rejects(profileSessionContext(profile, "another-session"), { code: "profile_session_conflict" });
    let count = 0;
    const boundFetch = (async (url, init) => {
      assert.equal(new Headers(init?.headers).get(AGENT_SESSION_ID_HEADER), context.session_id);
      count++;
      return fake.fetcher(url, init);
    }) as typeof fetch;
    await checkAgentMessages({ profilePath, hostSessionId: "this-session", fetcher: boundFetch, present: async () => {} });
    assert.equal(count, 2);
  } finally { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; }
});

test("Codex hooks preserve host settings and configure waits for the receive-state lock", async () => {
  const { withFileLock, writeSecureJsonFile } = await import("../../src/cloud/storage.js");
  const { profileScopeKey } = await import("../../src/cloud/agent-profile.js");
  const { receiveBindingPath } = await import("../../src/cloud/agent-receive.js");
  const { setTimeout: delay } = await import("node:timers/promises");
  const { profilePath } = await setup();
  const cwd = await mkdtemp(join(root, "codex-project-"));
  await mkdir(join(cwd, ".codex"));
  await writeFile(join(cwd, ".codex", "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "existing-hook" }] }] } }));
  const options = { profilePath, mode: "turn", provider: "codex", hostSessionId: "codex-one", cwd, execution: { command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"))] } };
  const configured = await configureAgentReceive(options);
  assert.equal(configured.turn_check, "pending_host");
  assert.match(await readFile(join(cwd, ".codex", "hooks.json"), "utf8"), /existing-hook/);
  let acquired!: () => void, release!: () => void;
  const ready = new Promise<void>(r => { acquired = r; });
  const hold = new Promise<void>(r => { release = r; });
  const timestamp = new Date().toISOString();
  const writer = withFileLock(dirname(profilePath), `receive-${profileScopeKey("codex-one")}`, async () => {
    acquired();
    await hold;
    const binding = await readReceiveBinding(profilePath, "codex-one");
    await writeSecureJsonFile(receiveBindingPath(profilePath, "codex-one"), JSON.stringify({ ...binding, turn_verified_at: timestamp }));
  });
  await ready;
  let completed = false;
  const config = configureAgentReceive(options).then(result => { completed = true; return result; });
  try { await delay(40); assert.equal(completed, false, "configure must not bypass an active state writer"); }
  finally { release(); await writer; }
  await config;
  assert.equal((await readReceiveBinding(profilePath, "codex-one"))!.turn_verified_at, timestamp);
});


test("damaged handoffs fail before authentication and keep CLI errors secret-free", async () => {
  const marker = "SYNTHETIC_PRIVATE_MARKER";
  const original = { ...connection(), anon_key: marker };
  const cases = [
    { raw: JSON.stringify(original).replaceAll("_", "\\_"), code: "connection_invalid", markdown: true },
    { raw: JSON.stringify({ ...original, url: "[https://fixture.example](https://fixture.example)" }), code: "connection_target_invalid", markdown: true },
    { raw: `{\"${marker}\":`, code: "connection_invalid", markdown: false },
    { raw: JSON.stringify({ ...original, workspace_id: undefined }), code: "connection_invalid", markdown: false },
    { raw: JSON.stringify({ ...original, credential: { ...artifact(), agent_token: marker } }), code: "agent_credential_invalid_agent_token", markdown: false },
  ];
  for (const item of cases) {
    const input = await saveInput(original);
    await writeFile(input, item.raw);
    let calls = 0;
    await assert.rejects(setupAgent({ connectionFile: input, fetcher: (async () => { calls++; throw new Error("network reached"); }) as typeof fetch }), { code: item.code });
    assert.equal(calls, 0);
    for (const flags of [[], ["--json"]]) {
      const result = await cli(["setup", "--connection-file", input, ...flags]);
      assert.equal(result.code, 1);
      const output = result.stdout + result.stderr;
      assert.equal(output.includes(marker), false);
      assert.equal(output.includes(TOKEN), false);
      if (item.markdown) assert.match(output, /Markdown/);
      if (flags.length) {
        const error = JSON.parse(result.stdout);
        assert.equal(error.ok, false);
        assert.equal(result.stderr, "");
      }
    }
    assert.equal(await readFile(input, "utf8"), item.raw, "rejected input is never repaired");
  }
  const version = await cli(["setup", "--check-version"]);
  assert.equal(version.code, 0);
  assert.deepEqual(JSON.parse(version.stdout), { setup_version: 1 });
});
