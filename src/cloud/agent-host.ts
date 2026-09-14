import { existsSync } from "node:fs";
import { GROK_BOT_GATEWAY_PATHS } from "./agent-grok-bot-gateway.js";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export type DetectedAgentHost = "claude" | "codex" | "codex-desktop" | "grok-bot" | "unknown";
interface ParentProcess { parent: number; executable: string }

async function parentProcess(pid: number): Promise<ParentProcess | null> {
  try {
    // Only executable names and parent IDs; never inspect other agents' argv.
    const { stdout } = await exec("ps", ["-p", String(pid), "-o", "ppid=,comm="], { timeout: 250, maxBuffer: 4096 });
    const match = stdout.trim().match(/^(\d+)\s+(.+)$/);
    return match ? { parent: Number(match[1]), executable: match[2]! } : null;
  } catch { return null; }
}

/** Prefer the closest named host; consult Bot markers only after a passthrough walk. */
export async function detectAgentHost(read = parentProcess, start = process.ppid, env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): Promise<DetectedAgentHost> {
  let pid = start;
  const seen = new Set<number>();
  for (let hop = 0; hop < 6 && pid > 1 && !seen.has(pid); hop++) {
    seen.add(pid);
    const row = await read(pid);
    if (row === null) return "unknown";
    const executable = basename(row.executable);
    if (executable === "claude") return "claude";
    if (executable === "codex") return "codex";
    if (executable === "Codex" && row.executable.includes("/Codex.app/")) return "codex-desktop";
    // A different host is a boundary: never label its child as a more distant host.
    if (["grok", "opencode", "gemini"].includes(executable)) return "unknown";
    if (!["node", "zsh", "bash", "sh", "env"].includes(executable)) return "unknown";
    pid = row.parent;
  }
  return env.CURSOR_AGENT === "1" || Boolean(env.SAND_HOST_PORT || env.CURSOR_AGENT_SOCKET) || GROK_BOT_GATEWAY_PATHS.some(exists) ? "grok-bot" : "unknown";
}
