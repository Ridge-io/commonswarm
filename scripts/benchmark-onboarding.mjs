/** Local-only benchmark. No model or production account is started or contacted. */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { dashboardAgentConnection, dashboardAgentFilePrompt, dashboardAgentPrompt } from "../site/src/components/connect/agent-prompt.ts";

const run = promisify(execFile);
const base = "042afa63b965f43637561277090c02a921c3a1a7";
const repository = resolve(import.meta.dirname, "..");
const baselineSource = execFileSync("git", ["show", `${base}:site/src/components/connect/agent-prompt.ts`], { cwd: repository, encoding: "utf8" });
for (const dependency of ["site/src/lib/agent-connect.ts", "site/src/lib/install.ts", "site/src/lib/standing-grants.ts", "supabase/functions/_shared/signal-text.ts"]) {
  assert.equal(await readFile(join(repository, dependency), "utf8"), execFileSync("git", ["show", `${base}:${dependency}`], { cwd: repository, encoding: "utf8" }), `Baseline dependency changed: ${dependency}. Measure from a matching snapshot.`);
}
const bundled = await build({ stdin: { contents: baselineSource, loader: "ts", resolveDir: join(repository, "site/src/components/connect") }, bundle: true, platform: "node", format: "cjs", packages: "external", write: false, logLevel: "silent" });
const baselineModule = { exports: {} };
new Function("module", "exports", "require", bundled.outputFiles[0].text)(baselineModule, baselineModule.exports, createRequire(import.meta.url));
const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const principalId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ownerId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const token = `swm_agt_${"S".repeat(43)}`;
const publicKey = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"), Buffer.from(JSON.stringify({ iss: "supabase", ref: "synthetic-benchmark", role: "anon", iat: 1700000000, exp: 4102444800 })).toString("base64url"), "SYNTHETIC_PUBLIC_SIGNATURE_NOT_A_CREDENTIAL"].join(".");
const input = {
  credential: { principalId, principalName: "Benchmark", tokenId: "11111111-1111-4111-8111-111111111111", runId: "22222222-2222-4222-8222-222222222222", token, expiresAt: Date.parse("2099-01-01T00:00:00.000Z"), renews: true, grantKind: "standing", horizonExpiresAt: null },
  workspaceId, workspaceName: "Benchmark", deploymentUrl: "https://api.commonswarm.com", anonKey: publicKey,
};
const prompts = { baseline: baselineModule.exports.dashboardAgentPrompt(input), inline: dashboardAgentPrompt(input), file: dashboardAgentFilePrompt(input) };
const stats = Object.fromEntries(Object.entries(prompts).map(([name, text]) => [name, { characters: text.length, words: text.split(/\s+/).length, lines: text.split("\n").length }]));
let tokenizer = null;
if (process.env.CSWARM_TOKENIZER_PYTHON) {
  const source = "import json,sys,tiktoken; x=json.load(sys.stdin); enc=tiktoken.get_encoding('o200k_base'); print(json.dumps({'version':tiktoken.__version__,'encoding':'o200k_base','counts':{k:len(enc.encode(v)) for k,v in x.items()}}))";
  const { spawn } = await import("node:child_process");
  const child = spawn(process.env.CSWARM_TOKENIZER_PYTHON, ["-c", source], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(JSON.stringify(prompts));
  let output = "", error = ""; child.stdout.on("data", c => output += c); child.stderr.on("data", c => error += c);
  const code = await new Promise((done, reject) => { child.on("error", reject); child.on("close", done); });
  assert.equal(code, 0, error); tokenizer = JSON.parse(output);
  for (const name of Object.keys(stats)) stats[name].tokens = tokenizer.counts[name];
}
const root = await mkdtemp(join(tmpdir(), "cswarm-onboarding-benchmark-"));
let requests = 0;
const server = createServer((req, res) => {
  let text = ""; req.on("data", c => text += c); req.on("end", () => {
    const body = JSON.parse(text); requests++;
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const result = body.resource === "members" ? {
      members: [{ user_id: ownerId, display_name: "Owner" }], agents: [{ principal_id: principalId, name: "Benchmark", owner_user_id: ownerId }],
      identity: { credential_valid: true, principal_id: principalId, workspace_id: workspaceId, owner_user_id: ownerId },
    } : { signals: [], capabilities: { cursor_after: 1, sender_owner_relation: 1 } };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
  });
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const samples = [];
const command = async args => {
  const started = performance.now();
  const result = await run(process.execPath, [join(repository, "dist/cli.js"), ...args], { cwd: repository, env: { ...process.env, SWARM_AGENT_STATE_DIR: join(root, "renewal"), XDG_CONFIG_HOME: join(root, "config") }, timeout: 15_000 });
  assert.equal((result.stdout + result.stderr).includes(token), false);
  return { elapsed: performance.now() - started, stdout: result.stdout };
};
try {
  const file = join(root, "connection.json");
  await writeFile(file, dashboardAgentConnection({ ...input, deploymentUrl: `http://127.0.0.1:${server.address().port}` }), { mode: 0o600 });
  for (let i = 0; i < 10; i++) {
    const profile = join(root, `trial-${i}`, "profile.json");
    const started = performance.now();
    const setup = await command(["setup", "--connection-file", file, "--profile", profile, "--json"]);
    assert.equal(JSON.parse(setup.stdout).connected, true);
    const configure = await command(["receive", "configure", "--profile", profile, "--mode", "turn", "--json"]);
    const check = await command(["check", "--profile", profile]);
    assert.equal(check.stdout, "");
    const total = performance.now() - started;
    const resume = await command(["resume", "--profile", profile, "--json"]);
    samples.push({ setup_ms: setup.elapsed, configure_ms: configure.elapsed, quiet_check_ms: check.elapsed, resume_ms: resume.elapsed, warm_turn_setup_ms: total });
  }
} finally { server.closeAllConnections(); await new Promise(done => server.close(done)); await rm(root, { recursive: true, force: true }); }
function percentile(values, fraction) { const sorted = values.toSorted((a, b) => a - b); return Math.round(sorted[Math.ceil(sorted.length * fraction) - 1] * 10) / 10; }
const timings = Object.fromEntries(Object.keys(samples[0]).map(key => [key, { p50: percentile(samples.map(s => s[key]), 0.5), p95: percentile(samples.map(s => s[key]), 0.95) }]));
console.log(JSON.stringify({ measured_at: new Date().toISOString(), baseline_sha: base, scope: "10 loopback HTTP trials; compiled CLI; installed Node and CLI; no model, human wait, production server, or host wake timing", node: process.version, prompts: stats, tokenizer: tokenizer ? { version: tokenizer.version, encoding: tokenizer.encoding } : null, timings, trials: samples.length, network_requests: requests, file_prompt_reduction_percent: Math.round((1 - stats.file.characters / stats.baseline.characters) * 1000) / 10, samples }, null, 2));
