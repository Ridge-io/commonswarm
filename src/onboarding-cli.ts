import { dirname, join, resolve } from "node:path";
import {
  AGENT_CONNECTION_VERSION, AGENT_QUICK_GUIDE, RECEIVE_MODES, RECEIVE_PROVIDERS, turnCheckInstruction,
} from "./cloud/agent-onboarding-contract.js";
import { setupAgent } from "./cloud/agent-setup.js";
import {
  cachedAgentMessage, checkAgentMessages, renderAgentCheck, shellQuote,
} from "./cloud/agent-check.js";
import { AgentSetupError, privatePath, profileScopeKey, readAgentProfile } from "./cloud/agent-profile.js";
import {
  checkedHostSessionId, configureAgentReceive, readReceiveBinding,
  receiveHookEvent, receiveStatus, requestReceiveCanary,
} from "./cloud/agent-receive.js";
import { readSecureJsonFileIfPresent, writeSecureJsonFile } from "./cloud/storage.js";

export interface OnboardingArguments {
  positionals: string[];
  has(name: string): boolean;
  optional(name: string): string | undefined;
  required(name: string): string;
  assertShape(flags: readonly string[], positionals: number): void;
}

export const ONBOARDING_VALUE_FLAGS = ["connection-file", "profile", "message-id"] as const;
export const ONBOARDING_BOOLEAN_FLAGS = ["check-version", "hook", "full", "preview-channel"] as const;

export function onboardingUsage(): string {
  return `  cswarm setup --connection-file <private-file> [--profile <absolute-path>] [--host-session-id <id>] [--json]
  cswarm setup --check-version [--json]
  cswarm setup guide
  cswarm check --profile <absolute-path> [--host-session-id <id>] [--force] [--full | --message-id <uuid>] [--json]
  cswarm receive configure --profile <absolute-path> --mode ${RECEIVE_MODES.join("|")} [--provider ${RECEIVE_PROVIDERS.join("|")}] [--host-session-id <id>] [--cwd <path>] [--preview-channel] [--json]
  cswarm receive status --profile <absolute-path> [--host-session-id <id>] [--json]
  cswarm receive test --profile <absolute-path> --host-session-id <id> [--json]
  cswarm receive serve --profile <absolute-path> --host-session-id <id>

setup imports a private connection file and checks the authenticated identity. It starts no listener.
check reads new directed messages without a listener; --force also performs a fresh read (there is no cooldown).
--message-id reads the full body from the bounded local preview cache. Fetching does not ACK a delivery.
receive configure records the user's choice. Host hooks require the current session ID; inherited host variables are not trusted.
Wake uses a Claude Code preview channel in this same session. It remains unverified until an idle canary is received.
Turn mode uses a scoped host hook or a saved instruction. No background process renews credentials in turn mode.
Agent commands also accept --profile instead of repeated credential and connection flags.`;
}

export async function writeOnboardingOutput(value: string): Promise<void> {
  if (!value) return;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    process.stdout.once("error", onError);
    process.stdout.write(value, error => {
      process.stdout.off("error", onError);
      if (error) reject(error); else resolve();
    });
  });
}

async function output(value: unknown): Promise<void> {
  await writeOnboardingOutput(`${JSON.stringify(value)}\n`);
}

async function hookInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); process.stdin.destroy(); }, 1_000);
  try {
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 256 * 1024) throw new AgentSetupError("hook_input_too_large", "The host hook input is too large.");
      chunks.push(buffer);
    }
    if (controller.signal.aborted) return null;
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function runTurnHook(args: OnboardingArguments): Promise<void> {
  const profile = privatePath(args.required("profile"));
  const host = checkedHostSessionId(args.required("host-session-id"));
  const diagnostic = join(dirname(profile), `check-error-${profileScopeKey(host)}.json`);
  try {
    const event = await hookInput();
    const result = await receiveHookEvent(profile, host, event);
    if (!result.check) return;
    await checkAgentMessages({ profilePath: profile, hostSessionId: host, present: async result => {
      const text = renderAgentCheck(result);
      if (text) await writeOnboardingOutput(text);
    } });
    const previous = await readSecureJsonFileIfPresent(diagnostic, 4096);
    if (previous !== null && previous !== '"ok"') await writeOnboardingOutput("CommonSwarm message checks are working again.\n");
    if (previous !== '"ok"') await writeSecureJsonFile(diagnostic, '"ok"');
  } catch (error) {
    const code = error instanceof AgentSetupError ? error.code : "check_failed";
    let changed = true;
    try {
      changed = await readSecureJsonFileIfPresent(diagnostic, 4096) !== JSON.stringify(code);
      if (changed) await writeSecureJsonFile(diagnostic, JSON.stringify(code));
    } catch { /* A broken state directory cannot hold a diagnostic. */ }
    if (changed) await writeOnboardingOutput(`CommonSwarm check failed (${code}); the inbox was not proved empty. Run cswarm check --profile ${shellQuote(profile)} to see the error.\n`).catch(() => undefined);
    // A coordination outage must not block the user's host turn.
  }
}

export async function runOnboardingCommand(args: OnboardingArguments): Promise<boolean> {
  const verb = args.positionals[0];
  if (verb === "setup") {
    if (args.has("check-version")) {
      args.assertShape(["check-version", "json"], 1);
      await output({ setup_version: AGENT_CONNECTION_VERSION });
    } else if (args.positionals[1] === "guide") {
      args.assertShape([], 2);
      await writeOnboardingOutput(`${AGENT_QUICK_GUIDE}\n`);
    } else {
      args.assertShape(["connection-file", "profile", "host-session-id", "json"], 1);
      if (args.has("host-session-id")) checkedHostSessionId(args.required("host-session-id"));
      await output(await setupAgent({ connectionFile: args.required("connection-file"), profilePath: args.optional("profile"), hostSessionId: args.optional("host-session-id") }));
    }
    return true;
  }
  if (verb === "check") {
    args.assertShape(["profile", "host-session-id", "force", "full", "message-id", "json", "hook"], 1);
    if (args.has("hook")) {
      if (args.has("full") || args.has("message-id") || args.has("json")) throw new AgentSetupError("hook_options_invalid", "A host hook cannot also request full text or JSON output.");
      await runTurnHook(args);
    } else if (args.has("message-id")) {
      if (args.has("full")) throw new AgentSetupError("check_options_invalid", "Use either --full or --message-id.");
      const message = await cachedAgentMessage(args.required("profile"), args.required("message-id"), args.optional("host-session-id"));
      await output({ source: "local_preview_cache", message });
    } else {
      if (args.has("host-session-id")) checkedHostSessionId(args.required("host-session-id"));
      await checkAgentMessages({
        profilePath: args.required("profile"), hostSessionId: args.optional("host-session-id"), full: args.has("full"),
        present: async result => args.has("json") ? output(result) : writeOnboardingOutput(renderAgentCheck(result)),
      });
    }
    return true;
  }
  if (verb === "receive") {
    const action = args.positionals[1];
    const common = ["profile", "host-session-id", "json"];
    if (action === "configure") {
      args.assertShape([...common, "mode", "provider", "cwd", "preview-channel"], 2);
      await output(await configureAgentReceive({
        profilePath: args.required("profile"), mode: args.required("mode"), provider: args.optional("provider"),
        hostSessionId: args.optional("host-session-id"), cwd: args.optional("cwd"), previewChannel: args.has("preview-channel"),
        execution: { command: process.execPath, args: [...process.execArgv, resolve(process.argv[1]!)] },
      }));
    } else if (action === "status") {
      args.assertShape(common, 2);
      await output(receiveStatus(await readReceiveBinding(args.required("profile"), args.optional("host-session-id"))));
    } else if (action === "test") {
      args.assertShape(common, 2);
      await output(await requestReceiveCanary(args.required("profile"), checkedHostSessionId(args.required("host-session-id"))));
    } else if (action === "serve") {
      args.assertShape(["profile", "host-session-id"], 2);
      const { serveAgentChannel } = await import("./cloud/agent-channel.js");
      await serveAgentChannel({ profilePath: args.required("profile"), hostSessionId: checkedHostSessionId(args.required("host-session-id")) });
    } else throw new AgentSetupError("receive_command_invalid", "Run cswarm --help for receive commands.");
    return true;
  }
  if (verb === "resume" && args.has("profile")) {
    args.assertShape(["profile", "host-session-id", "json"], 1);
    const path = privatePath(args.required("profile"));
    const profile = await readAgentProfile(path);
    const binding = await readReceiveBinding(path, args.optional("host-session-id"));
    await output({ profile: path, principal_id: profile.principal_id, workspace_id: profile.workspace_id,
      authenticated_now: false, ...receiveStatus(binding),
      instruction: turnCheckInstruction(path, binding?.host_session_id),
    });
    return true;
  }
  return false;
}
