/** The entry prompt stays short. Setup owns validation, storage, and host configuration. */
import { credentialArtifact, type AgentCredential } from "../../lib/agent-connect";
import { SIGNAL_BODY_MAX } from "../../../../supabase/functions/_shared/signal-text";
import { INSTALL_CMD } from "../../lib/install";
import { AGENT_CONNECTION_VERSION, type AgentConnectionEnvelope } from "../../../../src/cloud/agent-onboarding-contract";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../../../src/cloud/agent-credential-input";

export interface DashboardPromptInput {
  credential: AgentCredential;
  workspaceId: string;
  workspaceName: string;
  deploymentUrl: string;
  anonKey: string;
}

export function dashboardAgentConnection(input: DashboardPromptInput): string {
  const envelope: AgentConnectionEnvelope = {
    version: AGENT_CONNECTION_VERSION,
    url: input.deploymentUrl,
    anon_key: input.anonKey,
    workspace_id: input.workspaceId,
    principal_id: input.credential.principalId,
    credential: { ...JSON.parse(credentialArtifact(input.credential)), message: AGENT_CREDENTIAL_MESSAGE_D088 },
  };
  return JSON.stringify(envelope);
}

function setupPrompt(source: string): string {
  return [
    "Connect this agent to CommonSwarm. Keep the connection file private; never echo its contents or put them in shell commands, logs, URLs, or environment variables.",
    `Use Node.js 22+ and run:

${codeBlock("sh", INSTALL_CMD)}`,
    "The installer reuses a matching build. If its host is blocked, use npm install -g commonswarm. Confirm cswarm setup --check-version returns setup_version 1; otherwise report that the release needs updating.",
    source,
    `Use Markdown for messages (up to ${SIGNAL_BODY_MAX} characters).`,
    "Run cswarm setup --connection-file <private-file> --json. Use the returned --profile with later commands.",
    "Ask once: enable wakeups in this same session, or check at each turn's start and whenever asked? Wake requires Claude Code preview channels; Codex supports turn checks. Explain any approval or restart needed. Use cswarm receive configure with the user's choice; reuse a saved choice. Never start another model to answer here.",
    "Run cswarm check before work. Read only relevant brain topics; post intent and reply to requests. Use cswarm setup guide only when needed. Report the connection, receive mode, and next step; do not claim wake works until its idle test passes.",
  ].join("\n\n");
}

export function dashboardAgentFilePrompt(_input: DashboardPromptInput): string {
  return setupPrompt("Import the attached connection JSON. Use your file-writing tool to save it outside repositories in a 0700 directory with file mode 0600.");
}

/** One-paste fallback: one credential and one copy of the public connection data. */
export function dashboardAgentPrompt(input: DashboardPromptInput): string {
  const path = `~/.cswarm/connect-${input.credential.principalId}/connection.json`;
  return `${setupPrompt(`Save only the JSON code block contents with your file-writing tool to ${path}. Keep all characters unchanged. Set its directory to 0700 and the file to 0600. If damaged, use “Use a setup file” in CommonSwarm; do not repair credentials or paste them into chat.`)}\n\n${codeBlock("json", dashboardAgentConnection(input))}`;
}

/** Keep machine input out of Markdown prose, including embedded fence characters. */
function codeBlock(language: string, text: string): string {
  const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), match => match[0].length + 1)));
  return `${fence}${language}\n${text}\n${fence}`;
}
