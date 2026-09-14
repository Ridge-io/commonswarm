import { stat, readFile } from "node:fs/promises";
import { AgentSetupError } from "./agent-onboarding-contract.js";

export const GROK_BOT_GATEWAY_PATHS = ["/home/box/agent-data/gateway.json", "/home/box/sand-data/gateway.json"] as const;

export async function findGrokBotGateway(paths: readonly string[] = GROK_BOT_GATEWAY_PATHS): Promise<string> {
  for (const path of paths) {
    try { if ((await stat(path)).isFile()) return path; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AgentSetupError("grok_bot_gateway_unreadable", "Cannot read the local Bot gateway descriptor."); }
  }
  throw new AgentSetupError("grok_bot_gateway_missing", `Configure wake on the Bot computer with gateway.json at ${GROK_BOT_GATEWAY_PATHS.join(" or ")}.`);
}

/** Read secrets at serve time; never copy them to a receive binding or an error. */
export async function openGrokBotGateway(options: { paths?: readonly string[]; env?: NodeJS.ProcessEnv; fetcher?: typeof fetch } = {}) {
  const path = await findGrokBotGateway(options.paths);
  let descriptor: { token?: unknown; port?: unknown };
  try { descriptor = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new AgentSetupError("grok_bot_gateway_invalid", "Cannot parse the local Bot gateway descriptor."); }
  const port = Number((options.env ?? process.env).SAND_HOST_PORT || descriptor?.port || 1340);
  if (!descriptor || typeof descriptor.token !== "string" || !/^[A-Za-z0-9_-]+$/.test(descriptor.token) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AgentSetupError("grok_bot_gateway_invalid", "The local Bot gateway needs a bearer token and a valid port.");
  }
  const token = descriptor.token;
  return {
    async sendPrompt(agentId: string, prompt: string, signal?: AbortSignal): Promise<void> {
      try {
        const response = await (options.fetcher ?? fetch)(`http://127.0.0.1:${port}/api/sendPrompt`, {
          method: "POST", redirect: "error", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ agentId, prompt }),
          signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
        });
        await response.body?.cancel();
        if (!response.ok) throw new AgentSetupError("grok_bot_gateway_refused", "The local Bot gateway refused the wake request.");
      } catch (error) {
        if (error instanceof AgentSetupError) throw error;
        throw new AgentSetupError("grok_bot_gateway_failed", "The local Bot gateway request failed. Check the gateway on this computer.");
      }
    },
  };
}
