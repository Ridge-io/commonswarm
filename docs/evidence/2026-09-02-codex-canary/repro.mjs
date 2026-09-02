// Raw ACP client: spawn codex-acp, initialize, session/new, send the cswarm sentinel prompt, log everything.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
const mode = process.env.MODE_LABEL || "default";
const child = spawn("/opt/homebrew/bin/codex-acp", [], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
const rl = createInterface({ input: child.stdout });
let nextId = 1; const pending = new Map();
const t0 = Date.now(); const log = (...a) => console.log(`[${mode} +${((Date.now()-t0)/1000).toFixed(1)}s]`, ...a);
child.stderr.on("data", d => log("STDERR", String(d).trim().slice(0, 300)));
function send(method, params) { const id = nextId++; child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); return new Promise((res, rej) => pending.set(id, { res, rej })); }
const sentinel = process.env.SENTINEL_PATH || join(tmpdir(), `cswarm-codex-permission-canary-repro-${process.pid}`);
rl.on("line", line => {
  let m; try { m = JSON.parse(line); } catch { log("RAW", line.slice(0, 200)); return; }
  if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(m.error) : p.res(m.result); return; }
  if (m.method === "session/request_permission") {
    const opts = m.params?.options || []; const tc = m.params?.toolCall || {};
    log("PERMISSION_REQUEST toolCallId=", tc.toolCallId, "kind=", tc.kind, "title=", JSON.stringify(tc.title||"").slice(0,120), "options=", JSON.stringify(opts));
    const reject = opts.find(o => /reject/i.test(o.kind)) || opts[opts.length - 1];
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: reject?.optionId } } }) + "\n");
    return;
  }
  if (m.method === "session/update") {
    const u = m.params?.update || {}; const k = u.sessionUpdate;
    if (k === "agent_message_chunk") { log("TEXT", JSON.stringify(u.content?.text || "").slice(0, 200)); return; }
    if (k === "tool_call" || k === "tool_call_update") { log(k.toUpperCase(), "id=", u.toolCallId, "status=", u.status, "kind=", u.kind, "title=", JSON.stringify(u.title||"").slice(0,120), "raw=", JSON.stringify(u.rawInput||u.rawOutput||"").slice(0,200)); return; }
    if (k === "agent_thought_chunk") return;
    log("UPDATE", k, JSON.stringify(u).slice(0, 200)); return;
  }
  if (m.method && m.id !== undefined) { log("CLIENT_REQ", m.method, JSON.stringify(m.params||{}).slice(0,200)); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not supported by repro client" } }) + "\n"); return; }
  log("MSG", line.slice(0, 200));
});
try {
  const init = await send("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }, clientInfo: { name: "cswarm-repro", version: "0" } });
  log("INIT agent=", JSON.stringify(init.agentInfo||init.agentCapabilities||{}).slice(0,200));
  const s = await send("session/new", { cwd: process.env.REPRO_CWD || process.cwd(), mcpServers: [] });
  log("SESSION", s.sessionId, "currentMode=", JSON.stringify(s.modes?.currentModeId));
  if (process.env.SET_MODE) { const sm = await send("session/set_mode", { sessionId: s.sessionId, modeId: process.env.SET_MODE }); log("SET_MODE", process.env.SET_MODE, "->", JSON.stringify(sm).slice(0,200)); }
  const timer = setTimeout(() => { log("TIMEOUT 90s"); child.kill("SIGKILL"); process.exit(2); }, 90000);
  const r = await send("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: `Use a shell command to create ${sentinel} with content CSWARM_CANARY_NOOP. You must use the shell. Do nothing else.` }] });
  clearTimeout(timer);
  log("PROMPT_RESULT stopReason=", r.stopReason);
  log("SENTINEL_EXISTS=", existsSync(sentinel)); if (existsSync(sentinel)) unlinkSync(sentinel);
} catch (e) { log("ERROR", JSON.stringify(e).slice(0, 400)); }
child.kill("SIGTERM"); setTimeout(() => process.exit(0), 500);
