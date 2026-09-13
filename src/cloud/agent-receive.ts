import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  RECEIVE_MODES, RECEIVE_PROVIDERS, RECEIVE_WAKE_PROVIDER, turnCheckInstruction,
  type ReceiveMode, type ReceiveProvider,
} from "./agent-onboarding-contract.js";
import { AgentSetupError, ONBOARDING_UUID, privatePath, profileScopeKey, readAgentProfile } from "./agent-profile.js";
import { shellQuote } from "./agent-check.js";
import { readSecureJsonFileIfPresent, withFileLock, writeSecureJsonFile } from "./storage.js";

const exec = promisify(execFile);
export const RECEIVE_HEARTBEAT_MAX_AGE_MS = 15_000;
export const RECEIVE_HOOK_EVENTS = ["UserPromptSubmit", "SessionStart", "Stop"] as const;
export const CLAUDE_MCP_CONFIG_FILE = ".mcp.json" as const;
export const CSWARM_MCP_SERVER_NAME = "cswarm" as const;

export function claudeMcpConfigPath(cwd: string): string {
  return join(cwd, CLAUDE_MCP_CONFIG_FILE);
}

export interface ReceiveBinding {
  version: 1;
  profile: string;
  host_session_id: string;
  provider: ReceiveProvider;
  requested_mode: ReceiveMode;
  cwd: string;
  hook_file: string | null;
  hook_command: string | null;
  turn_verified_at: string | null;
  last_turn_started_at: string | null;
  last_turn_ended_at: string | null;
  idle: boolean;
  channel_config: string | null;
  channel_instance_id: string | null;
  channel_pid: number | null;
  channel_heartbeat_at: string | null;
  wake_verified_at: string | null;
  canary: { nonce: string; requested_at: string; signal_id: string | null; emitted_while_idle: boolean; received_at: string | null } | null;
}

export function checkedHostSessionId(value?: string): string {
  if (value === undefined) return "manual";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) {
    throw new AgentSetupError("host_session_invalid", "Use the current host's session ID. Do not use a name or guess an ID.");
  }
  return value;
}

export function receiveBindingPath(profile: string, hostSessionId?: string): string {
  return join(dirname(privatePath(profile)), `receive-${profileScopeKey(checkedHostSessionId(hostSessionId))}.json`);
}

export async function readReceiveBinding(profile: string, hostSessionId?: string): Promise<ReceiveBinding | null> {
  profile = privatePath(profile);
  await readAgentProfile(profile);
  const host = checkedHostSessionId(hostSessionId);
  const raw = await readSecureJsonFileIfPresent(receiveBindingPath(profile, host), 32 * 1024);
  if (raw === null) return null;
  let binding: ReceiveBinding;
  try { binding = JSON.parse(raw); } catch { throw new AgentSetupError("receive_state_invalid", "Receive settings are damaged. Configure this session again."); }
  const nullableTime = (value: unknown) => value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
  const nullableText = (value: unknown) => value === null || typeof value === "string";
  if (!binding || binding.version !== 1 || binding.profile !== profile || binding.host_session_id !== host ||
      !RECEIVE_MODES.includes(binding.requested_mode) || !RECEIVE_PROVIDERS.includes(binding.provider) ||
      typeof binding.cwd !== "string" || typeof binding.idle !== "boolean" ||
      ![binding.turn_verified_at, binding.last_turn_started_at, binding.last_turn_ended_at, binding.channel_heartbeat_at, binding.wake_verified_at].every(nullableTime) ||
      ![binding.hook_file, binding.hook_command, binding.channel_config].every(nullableText) ||
      (binding.channel_instance_id !== null && (typeof binding.channel_instance_id !== "string" || !ONBOARDING_UUID.test(binding.channel_instance_id))) ||
      (binding.canary !== null && (!binding.canary || !ONBOARDING_UUID.test(binding.canary.nonce) ||
        typeof binding.canary.requested_at !== "string" || !Number.isFinite(Date.parse(binding.canary.requested_at)) ||
        !nullableTime(binding.canary.received_at) || typeof binding.canary.emitted_while_idle !== "boolean" ||
        (binding.canary.signal_id !== null && (typeof binding.canary.signal_id !== "string" || !ONBOARDING_UUID.test(binding.canary.signal_id))))) ||
      (binding.channel_pid !== null && (!Number.isSafeInteger(binding.channel_pid) || binding.channel_pid < 1))) {
    throw new AgentSetupError("receive_state_invalid", "Receive settings do not match this profile and session. Configure this session again.");
  }
  return binding;
}

export async function updateReceiveBinding(profile: string, host: string, update: (binding: ReceiveBinding) => ReceiveBinding): Promise<ReceiveBinding> {
  const path = receiveBindingPath(profile, host);
  return withFileLock(dirname(path), `receive-${profileScopeKey(host)}`, async () => {
    const current = await readReceiveBinding(profile, host);
    if (current === null) throw new AgentSetupError("receive_not_configured", "Configure this session's receive mode first.");
    const next = update(current);
    await writeSecureJsonFile(path, JSON.stringify(next));
    return next;
  }, { timeoutMs: 2_000 });
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function receiveStatus(binding: ReceiveBinding | null, now = Date.now()) {
  const channelLive = binding !== null && binding.channel_pid !== null &&
    binding.channel_heartbeat_at !== null && now - Date.parse(binding.channel_heartbeat_at) >= 0 && now - Date.parse(binding.channel_heartbeat_at) <= RECEIVE_HEARTBEAT_MAX_AGE_MS &&
    processAlive(binding.channel_pid);
  const wakeVerified = binding?.requested_mode === "wake" && channelLive && binding?.wake_verified_at !== null;
  const mcpPath = binding !== null ? (binding.channel_config ?? claudeMcpConfigPath(binding.cwd)) : null;
  return {
    requested_mode: binding?.requested_mode ?? null,
    effective_mode: wakeVerified ? "wake" : "turn",
    turn_check: binding === null || binding.hook_file === null ? "instruction" : binding.turn_verified_at === null ? "pending_host" : "verified",
    wake_verified: Boolean(wakeVerified),
    channel_running: Boolean(channelLive),
    host_session_id: binding?.host_session_id ?? null,
    next_action: binding === null ? "Ask the user to choose wakeups or turn checks, then run cswarm receive configure." :
      wakeVerified ? null : binding.requested_mode === "wake" ?
        (channelLive
          ? "The Claude channel is running. Run cswarm receive test, end the turn, then confirm with cswarm receive status. Use cswarm check meanwhile."
          : `Wake is not verified. Channel entry written to ${mcpPath}. Restart Claude Code to start the channel, run cswarm receive test, end the turn, then confirm with cswarm receive status. Use cswarm check meanwhile.`) :
        channelLive ? "Turn mode is selected; the previous channel is stopping. Confirm channel_running is false with cswarm receive status." :
        binding.hook_file !== null && binding.turn_verified_at === null ?
          "Turn hook installed but not yet run. Trust it if the host asks, then start another turn in this same session. Confirm with cswarm receive status; use cswarm check meanwhile." : null,
  };
}

async function ownedRegular(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) {
      throw new AgentSetupError("hook_file_unsafe", "The host settings file must be an owned regular file.");
    }
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Merge only our exact command. Never remove another agent's hooks. */
export function mergeReceiveHooks(settings: Record<string, unknown>, command: string, previous: string | null, wake: boolean): Record<string, unknown> {
  if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks))) {
    throw new AgentSetupError("hook_config_invalid", "The existing host hooks are not valid JSON settings. Repair them before installing turn checks.");
  }
  const hooks = { ...(settings.hooks as Record<string, unknown> | undefined) };
  for (const event of RECEIVE_HOOK_EVENTS) {
    const raw = hooks[event];
    if (raw !== undefined && !Array.isArray(raw)) throw new AgentSetupError("hook_config_invalid", "The existing host hook event is not a list.");
    const groups = (raw as unknown[] | undefined ?? []).flatMap(group => {
      if (!group || typeof group !== "object" || Array.isArray(group)) throw new AgentSetupError("hook_config_invalid", "An existing host hook group is invalid.");
      const g = group as Record<string, unknown>;
      if (!Array.isArray(g.hooks)) throw new AgentSetupError("hook_config_invalid", "An existing host hook group has no hook list.");
      const remaining = g.hooks.filter(h => !h || typeof h !== "object" || ![command, previous].includes((h as Record<string, unknown>).command as string));
      return remaining.length > 0 ? [{ ...g, hooks: remaining }] : [];
    });
    if (event !== "Stop" || wake) groups.push({ hooks: [{ type: "command", command, timeout: 5 }] });
    if (groups.length > 0) hooks[event] = groups;
    else delete hooks[event];
  }
  return { ...settings, hooks };
}

async function ignoreLocalHook(cwd: string, file: string): Promise<void> {
  let root: string;
  try { root = (await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"])).stdout.trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as { code?: number }).code === 128) return;
    throw error;
  }
  const relative = file.slice(root.length + 1);
  const tracked = (await exec("git", ["-C", root, "ls-files", "--", relative])).stdout.trim();
  if (tracked) throw new AgentSetupError("hook_file_tracked", "This host settings file is tracked by git. Use a local untracked host configuration for this agent.");
  try { await exec("git", ["-C", root, "check-ignore", "--quiet", "--", relative]); return; }
  catch (error) { if ((error as { code?: number }).code !== 1) throw error; }
  const exclude = resolve(root, (await exec("git", ["-C", root, "rev-parse", "--git-path", "info/exclude"])).stdout.trim());
  const exists = await ownedRegular(exclude);
  const before = exists ? await readFile(exclude, "utf8") : "";
  await mkdir(dirname(exclude), { recursive: true });
  await writeFile(exclude, `${before}${before.endsWith("\n") || !before ? "" : "\n"}/${relative.replace(/[\\*?\[\] #!]/g, "\\$&")}\n`, { mode: 0o600 });
}

async function installReceiveHooks(binding: ReceiveBinding, command: string): Promise<string> {
  const folder = join(binding.cwd, binding.provider === "claude" ? ".claude" : ".codex");
  try {
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new AgentSetupError("hook_directory_unsafe", "The host settings directory must be owned and must not be a symlink.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const file = join(folder, binding.provider === "claude" ? "settings.local.json" : "hooks.json");
  const lock = createHash("sha256").update(file).digest("hex");
  await withFileLock(join(homedir(), ".cswarm", "hook-locks"), lock, async () => {
    const before = await ownedRegular(file) ? await readFile(file, "utf8") : "{}";
    let settings: Record<string, unknown>;
    try { settings = JSON.parse(before); } catch { throw new AgentSetupError("hook_config_invalid", "The host settings file is not valid JSON. Repair it before installing turn checks."); }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new AgentSetupError("hook_config_invalid", "The host settings file must be a JSON object.");
    const next = `${JSON.stringify(mergeReceiveHooks(settings, command, binding.hook_command, binding.requested_mode === "wake"), null, 2)}\n`;
    await ignoreLocalHook(binding.cwd, file);
    if (before === next) return;
    if (before !== "{}") await writeSecureJsonFile(join(dirname(binding.profile), "hook-backups", `${lock}-${randomUUID()}.json`), before);
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, next, { mode: 0o600, flag: "wx" });
    await rename(temp, file);
  });
  return file;
}

export async function configureAgentReceive(options: {
  profilePath: string; mode: string; provider?: string; hostSessionId?: string; cwd?: string;
  previewChannel?: boolean; execution: { command: string; args: string[] };
}) {
  const profile = privatePath(options.profilePath);
  if (!(RECEIVE_MODES as readonly string[]).includes(options.mode)) throw new AgentSetupError("receive_mode_invalid", `--mode must be ${RECEIVE_MODES.join(" or ")}.`);
  const provider = options.provider ?? "instructions";
  if (!(RECEIVE_PROVIDERS as readonly string[]).includes(provider)) throw new AgentSetupError("receive_provider_invalid", `--provider must be ${RECEIVE_PROVIDERS.join(" or ")}.`);
  const host = checkedHostSessionId(options.hostSessionId);
  if (provider !== "instructions" && host === "manual") throw new AgentSetupError("host_session_required", "A host hook needs this session's ID. Supply --host-session-id, or use --provider instructions for prompt-based turn checks.");
  if (options.mode === "wake" && provider !== RECEIVE_WAKE_PROVIDER) throw new AgentSetupError("wake_host_unsupported", `Wake supports --provider ${RECEIVE_WAKE_PROVIDER} only. Use --mode turn on this host.`);
  if (options.mode === "wake" && !options.previewChannel) throw new AgentSetupError("wake_preview_consent_required", "Claude custom channels are a research preview and need a host approval step. Explain that to the user before choosing wake; then add --preview-channel. Turn checks need no preview channel.");
  await readAgentProfile(profile);
  const cwd = await realpath(options.cwd ?? process.cwd());
  return withFileLock(dirname(profile), `receive-${profileScopeKey(host)}`, async () => {
    const existing = await readReceiveBinding(profile, host);
    if (existing && existing.provider !== provider) throw new AgentSetupError("receive_provider_conflict", "This session ID already has a different host binding. Use the current host's session ID.");
    if (existing && existing.cwd !== cwd) throw new AgentSetupError("receive_directory_conflict", "This session is bound to a different project directory. Configure from that directory.");
    let binding: ReceiveBinding = existing ?? {
      version: 1, profile, host_session_id: host, provider: provider as ReceiveProvider,
      requested_mode: options.mode as ReceiveMode, cwd, hook_file: null, hook_command: null,
      turn_verified_at: null, last_turn_started_at: null, last_turn_ended_at: null, idle: false,
      channel_config: null, channel_instance_id: null, channel_pid: null, channel_heartbeat_at: null,
      wake_verified_at: null, canary: null,
    };
    const changed = binding.requested_mode !== options.mode;
    binding = { ...binding, requested_mode: options.mode as ReceiveMode, ...(changed ? { wake_verified_at: null, canary: null } : {}) };
    if (provider !== "instructions") {
      const command = [options.execution.command, ...options.execution.args, "check", "--profile", profile, "--hook", "--host-session-id", host].map(shellQuote).join(" ");
      const hookFile = await installReceiveHooks(binding, command);
      binding = { ...binding, hook_file: hookFile, hook_command: command };
    }
    let startCommand: string | null = null;
    if (options.mode === "wake" && provider === "claude") {
      const mcpFile = claudeMcpConfigPath(cwd);
      await ownedRegular(mcpFile);
      let gitRoot: string | null = null;
      try { gitRoot = (await exec("git", ["-C", binding.cwd, "rev-parse", "--show-toplevel"])).stdout.trim(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as { code?: number }).code !== 128) throw error;
      }
      if (gitRoot) {
        const relative = mcpFile.startsWith(gitRoot + "/") ? mcpFile.slice(gitRoot.length + 1) : mcpFile;
        const tracked = (await exec("git", ["-C", gitRoot, "ls-files", "--", relative])).stdout.trim();
        if (tracked) throw new AgentSetupError("mcp_file_tracked", "The .mcp.json file is tracked by git. Use an untracked or ignored .mcp.json for local channel wakeups.");
        await ignoreLocalHook(binding.cwd, mcpFile);
      }
      const lock = createHash("sha256").update(mcpFile).digest("hex");
      await withFileLock(join(homedir(), ".cswarm", "hook-locks"), lock, async () => {
        const before = (await ownedRegular(mcpFile)) ? await readFile(mcpFile, "utf8") : "{}";
        let settings: Record<string, unknown>;
        try { settings = JSON.parse(before); }
        catch { throw new AgentSetupError("mcp_config_invalid", "The project .mcp.json file is not valid JSON. Repair it before configuring wake mode."); }
        if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
          throw new AgentSetupError("mcp_config_invalid", "The project .mcp.json file is not valid JSON. Repair it before configuring wake mode.");
        }
        const mcpServers = (settings.mcpServers && typeof settings.mcpServers === "object" && !Array.isArray(settings.mcpServers))
          ? { ...(settings.mcpServers as Record<string, unknown>) }
          : {};
        mcpServers[CSWARM_MCP_SERVER_NAME] = {
          command: options.execution.command,
          args: [...options.execution.args, "receive", "serve", "--profile", profile, "--host-session-id", host],
        };
        const next = `${JSON.stringify({ ...settings, mcpServers }, null, 2)}\n`;
        if (before !== "{}" && before !== next) {
          await writeSecureJsonFile(join(dirname(binding.profile), "hook-backups", `${lock}-${randomUUID()}.json`), before);
        }
        if (before !== next) {
          const temp = `${mcpFile}.${randomUUID()}.tmp`;
          await writeFile(temp, next, { mode: 0o600, flag: "wx" });
          await rename(temp, mcpFile);
        }
      });
      binding = { ...binding, channel_config: mcpFile };
      startCommand = `claude --resume ${shellQuote(host)} --dangerously-load-development-channels server:cswarm`;
    } else if (options.mode === "turn") {
      const mcpFile = claudeMcpConfigPath(cwd);
      if (await ownedRegular(mcpFile)) {
        const lock = createHash("sha256").update(mcpFile).digest("hex");
        await withFileLock(join(homedir(), ".cswarm", "hook-locks"), lock, async () => {
          const before = await readFile(mcpFile, "utf8");
          let settings: Record<string, unknown>;
          try { settings = JSON.parse(before); }
          catch { return; }
          if (!settings || typeof settings !== "object" || Array.isArray(settings)) return;
          const mcpServers = (settings.mcpServers && typeof settings.mcpServers === "object" && !Array.isArray(settings.mcpServers))
            ? (settings.mcpServers as Record<string, unknown>)
            : null;
          if (mcpServers && CSWARM_MCP_SERVER_NAME in mcpServers) {
            delete mcpServers[CSWARM_MCP_SERVER_NAME];
            if (Object.keys(mcpServers).length === 0) delete settings.mcpServers;
            const next = `${JSON.stringify(settings, null, 2)}\n`;
            if (before !== next) {
              if (before !== "{}") {
                await writeSecureJsonFile(join(dirname(binding.profile), "hook-backups", `${lock}-${randomUUID()}.json`), before);
              }
              const temp = `${mcpFile}.${randomUUID()}.tmp`;
              await writeFile(temp, next, { mode: 0o600, flag: "wx" });
              await rename(temp, mcpFile);
            }
          }
        });
      }
      binding = { ...binding, channel_config: null };
    }
    await writeSecureJsonFile(receiveBindingPath(profile, host), JSON.stringify(binding));
    return {
      ...receiveStatus(binding), profile, hook_file: binding.hook_file,
      instruction: turnCheckInstruction(profile, host),
      ...(startCommand ? {
        start_command: startCommand,
        host_step: "Resume this same Claude session with this command and approve the channel when Claude asks. Organization policy still applies. Channel entry written to " + binding.channel_config + ". This command does not start a separate worker.",
      } : {}),
    };
  }, { timeoutMs: 2_000 });
}

/** A configured hook proves its own session via host stdin, never inherited env vars. */
export async function receiveHookEvent(profile: string, host: string, input: unknown): Promise<{ check: boolean; provider: ReceiveProvider | null }> {
  const binding = await readReceiveBinding(profile, host);
  if (!binding || !input || typeof input !== "object" || Array.isArray(input)) return { check: false, provider: null };
  const event = input as Record<string, unknown>;
  let eventCwd: string | null = null;
  if (typeof event.cwd === "string") {
    try { eventCwd = await realpath(event.cwd); } catch { /* Unknown location is not a match. */ }
  }
  if (event.session_id !== binding.host_session_id || typeof event.hook_event_name !== "string" ||
      !(RECEIVE_HOOK_EVENTS as readonly string[]).includes(event.hook_event_name) ||
      eventCwd !== binding.cwd || event.agent_id !== undefined) return { check: false, provider: null };
  const now = new Date().toISOString();
  await updateReceiveBinding(profile, host, b => ({
    ...b, turn_verified_at: now,
    ...(event.hook_event_name === "Stop" ? { last_turn_ended_at: now, idle: true } : { last_turn_started_at: now, idle: false }),
  }));
  return { check: event.hook_event_name !== "Stop", provider: binding.provider };
}

export async function requestReceiveCanary(profile: string, host: string) {
  const next = await updateReceiveBinding(profile, host, binding => {
    if (binding.requested_mode !== "wake") throw new AgentSetupError("wake_not_selected", "Choose wake mode before testing it.");
    if (!receiveStatus(binding).channel_running) throw new AgentSetupError("channel_not_running", "Resume this session with its configured channel before testing wakeups.");
    return { ...binding, wake_verified_at: null, canary: { nonce: randomUUID(), requested_at: new Date().toISOString(), signal_id: null, emitted_while_idle: false, received_at: null } };
  });
  return { state: "pending", next_action: "End this turn so the session becomes idle. The channel will send a self-addressed test message. After this same session receives it, run cswarm receive status to confirm wake_verified is true.", host_session_id: next.host_session_id };
}
