import type { CloudTarget } from "./config.js";
import { readAgentSignalDirectory } from "./signals.js";
import { CommandTransportError, ThinCommandClient } from "./command-client.js";
import {
  SESSION_MODES,
  SESSION_PROVIDERS,
  type SessionMode,
  type SessionProvider,
} from "./session-contract.js";
import { AgentSessionError } from "./session-errors.js";
import { AgentSessionClient } from "./session-client.js";
import { AgentSessionManager } from "./session-manager.js";
import {
  runInteractiveReceiveOnce,
  runInteractiveReceiver,
  type HostInjectionCallback,
  type InteractiveReceiverStatus,
} from "./session-receiver.js";
import {
  assertSameIdentity,
  defaultSessionContextPath,
  SessionContextError,
  isReleasedSession,
  markSessionReleased,
  newSessionBinding,
  publicSessionStatus,
  readSessionContext,
  readSessionContextIfPresent,
  sessionProofOf,
  writeSessionContext,
  type SessionContextDocument,
  type SessionIdentity,
} from "./session-context.js";
import { bindSessionProof } from "./session-proof.js";

export function parseSessionMode(value: string | undefined): SessionMode {
  if (value === undefined || !(SESSION_MODES as readonly string[]).includes(value)) {
    throw new Error(`--mode must be ${SESSION_MODES.join(" or ")}`);
  }
  return value as SessionMode;
}

export function parseSessionProvider(value: string | undefined): SessionProvider {
  if (
    value === undefined ||
    !(SESSION_PROVIDERS as readonly string[]).includes(value)
  ) {
    throw new Error(`--provider must be ${SESSION_PROVIDERS.join("|")}`);
  }
  return value as SessionProvider;
}

export async function readSessionIdentity(
  target: CloudTarget,
  credential: string,
  workspaceId: string,
  fetcher: typeof fetch = fetch,
): Promise<SessionIdentity> {
  const directory = await readAgentSignalDirectory(
    target,
    credential,
    workspaceId,
    { fetcher },
  );
  if (directory.identity === undefined) {
    throw new Error(
      "this deployment authenticated the credential but did not return its identity; update the read service before starting a managed session",
    );
  }
  return {
    principal_id: directory.identity.principal_id,
    workspace_id: directory.identity.workspace_id,
  };
}

export interface SessionStartOptions {
  target: CloudTarget;
  workspaceId: string;
  credential: string;
  tokenFile: string;
  tokenPrincipalId?: string | null;
  mode: SessionMode;
  provider: SessionProvider;
  hostSessionId: string;
  hostLabel?: string | null;
  contextPath?: string;
  fetcher?: typeof fetch;
  readIdentity?: typeof readSessionIdentity;
  hostInjection?: HostInjectionCallback | null;
  hostIdentityTrusted?: boolean;
  runReceiver?: boolean;
  signal?: AbortSignal;
}

export interface SessionStartResult {
  context: SessionContextDocument;
  contextPath: string;
  retried: boolean;
  interactive?: InteractiveReceiverStatus;
  next?: string;
}

export async function startManagedSession(
  options: SessionStartOptions,
): Promise<SessionStartResult> {
  const fetcher = options.fetcher ?? fetch;
  const readIdentity = options.readIdentity ?? readSessionIdentity;
  const identity = await readIdentity(
    options.target,
    options.credential,
    options.workspaceId,
    fetcher,
  );
  const principalId = identity.principal_id;
  if (options.workspaceId.toLowerCase() !== identity.workspace_id.toLowerCase()) {
    throw new Error("authenticated workspace does not match --workspace-id");
  }
  if (
    options.tokenPrincipalId !== undefined &&
    options.tokenPrincipalId !== null &&
    options.tokenPrincipalId.toLowerCase() !== principalId.toLowerCase()
  ) {
    throw new Error(
      "token artifact principal does not match the authenticated identity",
    );
  }
  const draft = newSessionBinding({
    target: options.target,
    workspaceId: identity.workspace_id,
    principalId,
    provider: options.provider,
    mode: options.mode,
    hostSessionId: options.hostSessionId,
    tokenFile: options.tokenFile,
    hostLabel: options.hostLabel,
  });
  const contextPath = options.contextPath ??
    defaultSessionContextPath(draft.workspace_id, draft.principal_id, draft.session_id);
  const existing = await readSessionContextIfPresent(contextPath);
  let context = draft;
  let retried = false;
  if (existing !== null && !isReleasedSession(existing)) {
    if (existing.generation >= 1) {
      throw new SessionContextError(
        "session_context_conflict",
        "a live session context already exists at this path; run cswarm session stop first",
      );
    }
    context = existing;
    retried = true;
  }
  assertSameIdentity(context, {
    identity,
    target: options.target,
    tokenPrincipalId: options.tokenPrincipalId,
    flagWorkspaceId: options.workspaceId,
    flagUrl: options.target.url,
    hostSessionId: options.hostSessionId,
  });
  await writeSessionContext(contextPath, context);
  const client = new AgentSessionClient({
    target: options.target,
    fetcher,
  });
  let generation: number;
  try {
    const acquired = await client.acquire({
      credential: options.credential,
      workspaceId: context.workspace_id,
      context,
      commandId: context.acquire_command_id,
    });
    generation = acquired.generation;
  } catch (error) {
    if (error instanceof AgentSessionError && error.code === "session_not_managed") {
      context = { ...context, enforcement: "unmanaged" };
      await writeSessionContext(contextPath, context);
    }
    throw error;
  }
  context = {
    ...context,
    generation,
    enforcement: "enabled",
  };
  await writeSessionContext(contextPath, context);
  if (options.mode === "worker") {
    return {
      context,
      contextPath,
      retried,
      next:
        `Managed worker session acquired. Start the worker with: cswarm listen start --agent-token-file ${context.token_file} --session-context ${contextPath} --provider ${context.provider} --workspace-id ${context.workspace_id}`,
    };
  }
  if (options.runReceiver === false) {
    return { context, contextPath, retried };
  }
  const manager = new AgentSessionManager({
    client,
    credential: async () => options.credential,
    workspaceId: context.workspace_id,
    contextPath,
    context,
  });
  await manager.applyGeneration(generation);
  const interactive = await runInteractiveReceiver({
    target: options.target,
    credential: options.credential,
    contextPath,
    context,
    manager,
    hostInjection: options.hostInjection ?? null,
    hostIdentityTrusted: options.hostIdentityTrusted === true,
    fetcher,
    signal: options.signal,
  });
  return { context, contextPath, retried, interactive };
}

export async function readManagedSessionStatus(contextPath: string): Promise<{
  context: SessionContextDocument;
  status: Record<string, unknown>;
}> {
  const context = await readSessionContext(contextPath);
  return {
    context,
    status: publicSessionStatus(context, {
      session_key: undefined,
      credential: undefined,
    }),
  };
}

export async function stopManagedSession(input: {
  target: CloudTarget;
  credential: string;
  contextPath: string;
  fetcher?: typeof fetch;
}): Promise<{
  state: "stopping" | "stopped";
  next: string;
  status: Record<string, unknown>;
}> {
  const context = await readSessionContext(input.contextPath);
  const proof = sessionProofOf(context);
  if (proof === null) {
    return {
      state: "stopped",
      next: `Confirm with: cswarm session status --session-context ${input.contextPath}`,
      status: publicSessionStatus(context, { state: "stopped" }),
    };
  }
  const client = new AgentSessionClient({
    target: input.target,
    fetcher: input.fetcher,
  });
  const manager = new AgentSessionManager({
    client,
    credential: async () => input.credential,
    workspaceId: context.workspace_id,
    contextPath: input.contextPath,
    context,
  });
  try {
    await manager.release();
  } catch (error) {
    if (error instanceof CommandTransportError) {
      return {
        state: "stopping",
        next: `This is still in progress. Confirm with: cswarm session status --session-context ${input.contextPath}`,
        status: publicSessionStatus(context, { state: "stopping" }),
      };
    }
    throw error;
  }
  const released = markSessionReleased(context);
  await writeSessionContext(input.contextPath, released);
  return {
    state: "stopped",
    next: `Confirm with: cswarm session status --session-context ${input.contextPath}`,
    status: publicSessionStatus(released),
  };
}

export async function runHumanSessionLifecycle(
  kind: "enable" | "disable" | "recover",
  input: {
    target: CloudTarget;
    credential: string;
    workspaceId: string;
    principalId: string;
    fetcher?: typeof fetch;
  },
): Promise<{ kind: string; principal_id: string; status: "accepted" }> {
  const client = new AgentSessionClient({
    target: input.target,
    fetcher: input.fetcher,
  });
  const request = {
    credential: input.credential,
    workspaceId: input.workspaceId,
    principalId: input.principalId,
  };
  if (kind === "enable") await client.enable(request);
  else if (kind === "disable") await client.disable(request);
  else await client.recover(request);
  return { kind, principal_id: input.principalId, status: "accepted" };
}

export function boundAgentFetcher(
  fetcher: typeof fetch,
  context: SessionContextDocument,
): typeof fetch {
  return bindSessionProof(fetcher, sessionProofOf(context));
}

/** Bind proof when a live session context is present; otherwise leave the fetcher unchanged. */
export function fetcherForSessionContext(
  fetcher: typeof fetch,
  context: SessionContextDocument | null | undefined,
): typeof fetch {
  if (context === null || context === undefined) return fetcher;
  return boundAgentFetcher(fetcher, context);
}

export async function revokeAgentToken(input: {
  target: CloudTarget;
  credential: string;
  workspaceId: string;
  tokenId: string;
  fetcher?: typeof fetch;
  context?: SessionContextDocument;
}): Promise<{ status: string; token_id: string; command_event_ids?: unknown }> {
  const client = new ThinCommandClient(
    input.target,
    fetcherForSessionContext(input.fetcher ?? fetch, input.context),
  );
  const result = await client.sendConnect({
    workspaceId: input.workspaceId,
    credential: input.credential,
    command: { kind: "revoke_agent_token", token_id: input.tokenId },
  });
  if (result.response.status !== "accepted") {
    throw new Error(
      `Credential surrender was refused: ${
        result.response.reason ?? "required condition not met"
      }. The credential is unchanged.`,
    );
  }
  return {
    status: result.response.status,
    token_id: input.tokenId,
    command_event_ids: result.response.event_ids,
  };
}

export { runInteractiveReceiveOnce };
