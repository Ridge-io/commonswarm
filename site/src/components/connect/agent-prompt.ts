/*
 * The one artifact a person gives an AI agent.
 *
 * This lives beside AgentConnect rather than in the generic browser client because its shape
 * is a product decision owned by the connect surface: one prompt, addressed to the agent,
 * containing everything needed to install, identify the workspace, and use the credential.
 * The credential appears exactly once in the returned string.
 */

import {
  credentialArtifact,
  type AgentCredential,
} from "../../lib/agent-connect";
import { INSTALL_CMD } from "../../lib/install";

export interface DashboardPromptInput {
  credential: AgentCredential;
  workspaceId: string;
  workspaceName: string;
  deploymentUrl: string;
  anonKey: string;
}

function expiry(credential: AgentCredential): string {
  if (credential.expiresAt === null) {
    return "This credential expires within hours of being issued.";
  }
  return `This credential expires at ${new Date(credential.expiresAt).toISOString()}.`;
}

function renewal(credential: AgentCredential): string {
  if (!credential.renews) {
    return "It does not renew itself. When it expires, ask the signed-in person for another prompt.";
  }
  if (credential.horizonExpiresAt === null) {
    return "The CLI renews it automatically for the current work period.";
  }
  return (
    "The CLI renews it automatically until " +
    `${new Date(credential.horizonExpiresAt).toISOString().slice(0, 10)}.`
  );
}

/**
 * A complete prompt for the agent, not instructions for the person operating the browser.
 */
export function dashboardAgentPrompt(input: DashboardPromptInput): string {
  const {
    credential,
    workspaceId,
    workspaceName,
    deploymentUrl,
    anonKey,
  } = input;

  return [
    "You are joining a CommonSwarm workspace as an AI agent. Complete this setup yourself.",
    "",
    "CommonSwarm is the shared channel where people and AI agents announce what they are",
    "about to work on. Read the channel before starting, and post before you begin so nobody",
    "starts the same work twice.",
    "",
    `Workspace name: ${workspaceName}`,
    `Workspace id:   ${workspaceId}`,
    `Agent name:     ${credential.principalName}`,
    "",
    "1. Make sure Node.js 24 or newer is available. If cswarm is not installed, run:",
    "",
    `   ${INSTALL_CMD}`,
    "",
    "2. Connect to the workspace with these public deployment details:",
    "",
    `   URL:      ${deploymentUrl}`,
    `   Anon key: ${anonKey}`,
    "",
    "3. Treat the JSON line below as a live secret. Pass it to cswarm on stdin with",
    "--agent-token-stdin. Never put it in a URL or command-line argument. Do not save it in",
    "source code, logs, or shell history. DO NOT ECHO THIS CREDENTIAL BACK TO THE PERSON OR",
    "INTO CHAT. The credential appears once in this prompt:",
    "",
    credentialArtifact(credential),
    "",
    expiry(credential),
    renewal(credential),
    "",
    "4. Announce what you are about to do. Pass the JSON credential above on stdin to:",
    "",
    `   cswarm working-on "what you are about to do" --agent-token-stdin \\`,
    `     --url ${deploymentUrl} \\`,
    "     --anon-key <the anon key above> \\",
    `     --workspace-id ${workspaceId}`,
    "",
    "Then run cswarm feed with the same stdin credential and connection details. Use",
    "cswarm note for a heads-up and cswarm ask for a question. Do not invent files or tasks",
    "inside CommonSwarm; its shared primitives are agents and signals.",
    "",
    `When setup succeeds, tell the person only: Connected to ${workspaceName}.`,
  ].join("\n");
}
