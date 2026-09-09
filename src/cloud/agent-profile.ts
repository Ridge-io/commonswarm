import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { cloudTarget, type CloudTarget } from "./config.js";
import { parseAgentCredentialInput, type AgentCredentialInput } from "./agent-credential-input.js";
import { agentCredentialStore, credentialLineageKey } from "./agent-credential.js";
import { AgentCredentialSession } from "./renewal.js";
import { assertLocalSessionBinding, defaultSessionContextPath, listSessionContexts, sessionProofOf } from "./session-context.js";
import { readSecureJsonFileIfPresent, writeSecureJsonFile, withFileLock } from "./storage.js";
import {
  AGENT_CONNECTION_FIELDS, AGENT_CONNECTION_VERSION,
  type AgentConnectionEnvelope,
} from "./agent-onboarding-contract.js";
import {
  isAgentConnectionToken,
  decodeAgentConnectionToken,
  encodeAgentConnectionToken,
} from "./agent-connection-token.js";


export const ONBOARDING_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ONBOARDING_MAX_FILE_BYTES = 16 * 1024;

export class AgentSetupError extends Error {
  readonly name = "AgentSetupError";
  constructor(readonly code: string, message: string) { super(message); }
}

export interface AgentProfile {
  version: 1;
  url: string;
  anon_key: string;
  workspace_id: string;
  principal_id: string;
  credential_file: string;
}

export function privatePath(path: string): string {
  if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new AgentSetupError("profile_path_invalid", "Use an absolute private file path outside a repository.");
  }
  return resolve(path);
}

/** Check each existing ancestor, including repos reached through an ancestor symlink. */
export async function assertPrivateLocation(path: string): Promise<string> {
  const absolute = privatePath(path);
  let current = dirname(absolute);
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        // macOS /tmp and /var are system aliases. Resolve them, then inspect the real tree.
        const resolved = await realpath(current);
        if (current !== "/tmp" && current !== "/var") {
          throw new AgentSetupError("profile_symlink", "A private state path must not pass through a symlink.");
        }
        await assertPrivateLocation(join(resolved, "probe"));
      }
      try {
        await lstat(join(current, ".git"));
        throw new AgentSetupError("profile_inside_repository", "Keep the connection file and agent profile outside repositories.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return absolute;
}

export { isAgentConnectionToken, decodeAgentConnectionToken, encodeAgentConnectionToken };

export function parseAgentConnection(raw: string): AgentConnectionEnvelope {
  if (isAgentConnectionToken(raw)) {
    return decodeAgentConnectionToken(raw);
  }
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw); } catch {
    throw new AgentSetupError("connection_invalid", raw.includes("\\_") || /^\s*```/.test(raw)
      ? "The connection file appears to contain Markdown formatting. Use ‘Use a setup file’ in CommonSwarm and run setup with that file. Do not edit credentials or paste them into chat."
      : "The connection file is not valid JSON. Use ‘Use a setup file’ in CommonSwarm and run setup with that file. Do not paste its contents into chat.");
  }
  if (!value || Array.isArray(value) || typeof value !== "object" ||
      value.version !== AGENT_CONNECTION_VERSION ||
      Object.keys(value).length !== AGENT_CONNECTION_FIELDS.length ||
      AGENT_CONNECTION_FIELDS.some(key => !Object.hasOwn(value, key)) ||
      typeof value.url !== "string" || typeof value.anon_key !== "string" ||
      typeof value.workspace_id !== "string" || !ONBOARDING_UUID.test(value.workspace_id) ||
      typeof value.principal_id !== "string" || !ONBOARDING_UUID.test(value.principal_id) ||
      !value.credential || typeof value.credential !== "object" || Array.isArray(value.credential)) {
    throw new AgentSetupError("connection_invalid", `Expected connection version ${AGENT_CONNECTION_VERSION} with fields: ${AGENT_CONNECTION_FIELDS.join(", ")}. Save the supplied file unchanged.`);
  }
  if (/^\s*\[[\s\S]*\]\(/.test(value.url)) {
    throw new AgentSetupError("connection_target_invalid", "The connection URL appears to be a Markdown link. Use ‘Use a setup file’ in CommonSwarm and run setup with that file. Do not edit credentials or paste them into chat.");
  }
  const target = checkedTarget(value.url, value.anon_key);
  const agent = parseAgentCredentialInput(JSON.stringify(value.credential), { kind: "stdin" });
  if (!agent.durable || agent.principalId !== value.principal_id.toLowerCase()) {
    throw new AgentSetupError("connection_identity_mismatch", "The connection and credential name different agents. Ask for a new connection file.");
  }
  return {
    version: AGENT_CONNECTION_VERSION, url: target.url, anon_key: target.anonKey,
    workspace_id: value.workspace_id.toLowerCase(), principal_id: agent.principalId,
    credential: value.credential as Record<string, unknown>,
  };
}

function checkedTarget(url: string, anonKey: string): CloudTarget {
  try {
    const target = cloudTarget(url, anonKey);
    const parsed = new URL(target.url);
    if (parsed.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) throw new Error();
    if (anonKey.length > 4096 || /[\u0000-\u0020\u007f]/.test(anonKey)) throw new Error();
    return target;
  } catch {
    throw new AgentSetupError("connection_target_invalid", "Use an HTTPS deployment origin and its public key. HTTP is allowed only for local tests.");
  }
}

export function defaultAgentProfilePath(connection: Pick<AgentProfile, "url" | "anon_key" | "workspace_id" | "principal_id">): string {
  const target = checkedTarget(connection.url, connection.anon_key);
  return join(homedir(), ".cswarm", "agents", target.profileId, connection.workspace_id, connection.principal_id, "profile.json");
}

export async function readAgentProfile(path: string): Promise<AgentProfile> {
  path = await assertPrivateLocation(path);
  const raw = await readSecureJsonFileIfPresent(path, ONBOARDING_MAX_FILE_BYTES);
  if (raw === null) throw new AgentSetupError("profile_missing", "The agent profile is missing. Run cswarm setup with the connection file.");
  let p: AgentProfile;
  try { p = JSON.parse(raw); } catch { throw new AgentSetupError("profile_invalid", "The agent profile is damaged. Run setup again."); }
  if (!p || p.version !== 1 || Object.keys(p).sort().join() !== ["version", "url", "anon_key", "workspace_id", "principal_id", "credential_file"].sort().join() ||
      typeof p.url !== "string" || typeof p.anon_key !== "string" ||
      typeof p.workspace_id !== "string" || !ONBOARDING_UUID.test(p.workspace_id) ||
      typeof p.principal_id !== "string" || !ONBOARDING_UUID.test(p.principal_id) ||
      p.credential_file !== join(dirname(path), "credential.json")) {
    throw new AgentSetupError("profile_invalid", "The agent profile is damaged. Run setup again.");
  }
  checkedTarget(p.url, p.anon_key);
  return p;
}

export async function readProfileCredential(profile: AgentProfile): Promise<AgentCredentialInput> {
  const raw = await readSecureJsonFileIfPresent(profile.credential_file, ONBOARDING_MAX_FILE_BYTES);
  if (raw === null) throw new AgentSetupError("profile_credential_missing", "The profile credential is missing. Run setup again.");
  const agent = parseAgentCredentialInput(raw, { kind: "file", path: profile.credential_file });
  if (agent.principalId !== profile.principal_id) throw new AgentSetupError("profile_identity_mismatch", "The saved credential belongs to a different agent. Run setup again.");
  return agent;
}

export async function openProfileCredential(profile: AgentProfile, fetcher: typeof fetch = fetch): Promise<AgentCredentialSession> {
  const agent = await readProfileCredential(profile);
  const target = checkedTarget(profile.url, profile.anon_key);
  const store = await agentCredentialStore({ target, lineageKey: credentialLineageKey(agent.token) });
  return AgentCredentialSession.open({ target, workspaceId: profile.workspace_id, presented: agent, store, fetcher });
}

export async function saveAgentProfile(path: string, connection: AgentConnectionEnvelope): Promise<AgentProfile> {
  path = await assertPrivateLocation(path);
  const profile: AgentProfile = {
    version: 1, url: connection.url, anon_key: connection.anon_key,
    workspace_id: connection.workspace_id, principal_id: connection.principal_id,
    credential_file: join(dirname(path), "credential.json"),
  };
  await withFileLock(dirname(path), "setup", async () => {
    const existingRaw = await readSecureJsonFileIfPresent(path, ONBOARDING_MAX_FILE_BYTES);
    if (existingRaw !== null) {
      const existing = await readAgentProfile(path);
      if (existing.url !== profile.url || existing.workspace_id !== profile.workspace_id || existing.principal_id !== profile.principal_id) {
        throw new AgentSetupError("profile_conflict", "This profile belongs to another workspace or agent. Use a different profile path.");
      }
    }
    await writeSecureJsonFile(profile.credential_file, JSON.stringify(connection.credential));
    await writeSecureJsonFile(path, JSON.stringify(profile));
  });
  return profile;
}

export function profileScopeKey(hostSessionId?: string): string {
  return hostSessionId === undefined ? "manual" : createHash("sha256").update(hostSessionId).digest("hex");
}

export function profileTarget(profile: AgentProfile): CloudTarget {
  return checkedTarget(profile.url, profile.anon_key);
}

/** A supplied host ID may select its own managed proof; never take another session's proof. */
export async function profileSessionContext(profile: AgentProfile, hostSessionId?: string) {
  if (hostSessionId === undefined || hostSessionId === "manual") return null;
  const contexts = (await listSessionContexts(profile.workspace_id, profile.principal_id)).filter(c => sessionProofOf(c) !== null);
  if (contexts.length === 0) return null;
  const matches = contexts.filter(c => c.host_session_id === hostSessionId);
  if (matches.length !== 1) throw new AgentSetupError("profile_session_conflict", "This agent has no single managed context for this host session. Check cswarm session status; do not use another session's context.");
  const context = matches[0]!;
  assertLocalSessionBinding(context, {
    target: profileTarget(profile), tokenPrincipalId: profile.principal_id,
    flagWorkspaceId: profile.workspace_id, tokenFile: profile.credential_file, hostSessionId,
  });
  return { context, path: defaultSessionContextPath(profile.workspace_id, profile.principal_id, context.session_id) };
}
