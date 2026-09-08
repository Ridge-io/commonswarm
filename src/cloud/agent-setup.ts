import { dirname, join } from "node:path";
import { parseAgentCredentialInput } from "./agent-credential-input.js";
import { agentCredentialStore, credentialLineageKey } from "./agent-credential.js";
import { AgentCredentialSession } from "./renewal.js";
import { readAgentSignalDirectory, readAgentSignalPage } from "./signals.js";
import { readSecureJsonFileIfPresent } from "./storage.js";
import {
  AgentSetupError, ONBOARDING_MAX_FILE_BYTES, assertPrivateLocation,
  defaultAgentProfilePath, parseAgentConnection, profileTarget, saveAgentProfile,
  type AgentProfile,
} from "./agent-profile.js";
import { assertProfileIdentity, withAgentDeadline } from "./agent-check.js";
import { AGENT_CONNECTION_VERSION, RECEIVE_CHOICE, RECEIVE_PROVIDERS, RECEIVE_WAKE_PROVIDER } from "./agent-onboarding-contract.js";
import { readReceiveBinding, receiveStatus } from "./agent-receive.js";
import { detectAgentHost } from "./agent-host.js";

export const AGENT_SETUP_TIMEOUT_MS = 10_000;

export async function setupAgent(options: {
  connectionFile: string;
  profilePath?: string;
  hostSessionId?: string;
  fetcher?: typeof fetch;
}) {
  const connectionPath = await assertPrivateLocation(options.connectionFile);
  const raw = await readSecureJsonFileIfPresent(connectionPath, ONBOARDING_MAX_FILE_BYTES);
  if (raw === null) throw new AgentSetupError("connection_missing", "Save the connection file outside repositories in a private 0700 directory, with file mode 0600, then run setup again.");
  const connection = parseAgentConnection(raw);
  const profilePath = await assertPrivateLocation(options.profilePath ?? defaultAgentProfilePath(connection));
  const candidate: AgentProfile = {
    version: 1, url: connection.url, anon_key: connection.anon_key,
    workspace_id: connection.workspace_id, principal_id: connection.principal_id,
    credential_file: join(dirname(profilePath), "credential.json"),
  };
  const hostPromise = detectAgentHost();
  const identity = await withAgentDeadline(AGENT_SETUP_TIMEOUT_MS, async (fetcher, signal) => {
    const target = profileTarget(candidate);
    const agent = parseAgentCredentialInput(JSON.stringify(connection.credential), { kind: "file", path: connectionPath });
    const store = await agentCredentialStore({ target, lineageKey: credentialLineageKey(agent.token) });
    const session = await AgentCredentialSession.open({ target, workspaceId: connection.workspace_id, presented: agent, store, fetcher });
    const token = await session.bearer();
    const [directory, page] = await Promise.all([
      readAgentSignalDirectory(target, token, connection.workspace_id, { fetcher, signal }),
      readAgentSignalPage(target, { kind: "agent", token }, {
        workspaceId: connection.workspace_id, inbox: true, ascending: true, limit: 1,
      }, { fetcher, signal }),
    ]);
    assertProfileIdentity(candidate, directory);
    if (!page.capabilities.cursorAfter) throw new AgentSetupError("check_paging_unsupported", "Update this deployment to support inbox paging before using quick setup.");
    return {
      name: directory.agents.find(a => a.principal_id === connection.principal_id)?.name,
      inbox_pending: page.signals.length > 0,
      expires_at: session.expiry === null ? null : new Date(session.expiry).toISOString(),
    };
  }, options.fetcher);
  await saveAgentProfile(profilePath, connection);
  const receive = await readReceiveBinding(profilePath, options.hostSessionId);
  return {
    setup_version: AGENT_CONNECTION_VERSION, connected: true,
    profile: profilePath, principal_id: connection.principal_id, workspace_id: connection.workspace_id,
    ...identity,
    host: await hostPromise,
    receive_capabilities: { turn: RECEIVE_PROVIDERS, wake: { provider: RECEIVE_WAKE_PROVIDER, preview: true, requires_idle_test: true } },
    receive: receiveStatus(receive),
    ...(receive === null ? { receive_choice: RECEIVE_CHOICE } : {}),
    next_action: receive === null
      ? "Ask the user to choose a receive mode. Run cswarm receive configure with this profile, their choice, and this host's session ID. Read new messages with cswarm check before work."
      : "Receive choice reused. Read new messages with cswarm check; cswarm receive status shows any remaining host step.",
  };
}
