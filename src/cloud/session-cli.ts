import type { CloudTarget } from "./config.js";
import { readAgentSignalDirectory } from "./signals.js";
import { CommandTransportError, ThinCommandClient } from "./command-client.js";
import {
  SESSION_MODES,
  SESSION_PROVIDERS,
  type SessionMode,
  type SessionProvider,
  type AgentSessionErrorCode,
} from "./session-contract.js";
import { AgentSessionError } from "./session-errors.js";
import {
  AgentSessionClient,
  type ServerSessionStatus,
} from "./session-client.js";
import { AgentSessionManager } from "./session-manager.js";
import {
  currentHostInjection,
  registerHostInjection,
  runInteractiveReceiveOnce,
  runInteractiveReceiver,
  type HostInjectionCallback,
  type InteractiveReceiverStatus,
} from "./session-receiver.js";
import {
  assertAcquireBindingMatches,
  assertLocalSessionBinding,
  assertSameIdentity,
  defaultSessionContextPath,
  SessionContextError,
  isReleasedSession,
  markSessionReleased,
  newSessionBinding,
  publicSessionStatus,
  readSessionContext,
  readSessionContextIfPresent,
  sessionLifecycleState,
  sessionProofOf,
  writeSessionContext,
  type LocalSessionBinding,
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

/**
 * Local binding checks first (no fetch). Opening a credential session can
 * renew the token, so a mismatch must refuse before that.
 */
export async function openBoundAgentCredential<
  T extends { bearer(): Promise<string> },
>(input: {
  context: SessionContextDocument;
  target: CloudTarget;
  workspaceId: string;
  tokenPrincipalId?: string | null;
  tokenFile?: string | null;
  fetcher: typeof fetch;
  openSession: (boundFetcher: typeof fetch) => Promise<T>;
  readIdentity?: typeof readSessionIdentity;
}): Promise<{ bearer: string; fetcher: typeof fetch; session: T }> {
  const local: LocalSessionBinding = {
    target: input.target,
    tokenPrincipalId: input.tokenPrincipalId,
    flagWorkspaceId: input.workspaceId,
    flagUrl: input.target.url,
    tokenFile: input.tokenFile,
  };
  assertLocalSessionBinding(input.context, local);
  const bound = boundAgentFetcher(input.fetcher, input.context);
  const session = await input.openSession(bound);
  const bearer = await session.bearer();
  const readIdentity = input.readIdentity ?? readSessionIdentity;
  const identity = await readIdentity(
    input.target,
    bearer,
    input.workspaceId,
    bound,
  );
  assertSameIdentity(input.context, { ...local, identity });
  return { bearer, fetcher: bound, session };
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
    assertAcquireBindingMatches(existing, draft);
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
    hostInjection: options.hostInjection ?? currentHostInjection(),
    hostIdentityTrusted: options.hostIdentityTrusted === true,
    fetcher,
    signal: options.signal,
  });
  return { context, contextPath, retried, interactive };
}

function reconcileSessionView(
  context: SessionContextDocument,
  server: ServerSessionStatus,
): {
  state: "running" | "stopped" | "unacquired" | "expired";
  enforcement: SessionContextDocument["enforcement"];
} {
  const localState = sessionLifecycleState(context);
  const sameSession = server.session_id !== null &&
    server.session_id === context.session_id;
  const live = server.is_live === true &&
    sameSession &&
    sessionProofOf(context) !== null;
  const state = localState === "stopped"
    ? "stopped"
    : localState === "unacquired"
    ? "unacquired"
    : live
    ? "running"
    : "expired";
  const enforcement = server.lifecycle_state === "disabled" ||
      server.managed_at === null
    ? "unmanaged"
    : server.lifecycle_state === "enabled" || server.managed_at !== null
    ? "enabled"
    : "unknown";
  return { state, enforcement };
}

export async function readManagedSessionStatus(input: {
  contextPath: string;
  target: CloudTarget;
  credential: string;
  fetcher?: typeof fetch;
}): Promise<{
  context: SessionContextDocument;
  status: Record<string, unknown>;
}> {
  const context = await readSessionContext(input.contextPath);
  const local = publicSessionStatus(context, {
    session_key: undefined,
    credential: undefined,
  });
  const client = new AgentSessionClient({
    target: input.target,
    fetcher: input.fetcher,
  });
  const server = await client.readStatus({
    credential: input.credential,
    workspaceId: context.workspace_id,
    principalId: context.principal_id,
  });
  const reconciled = reconcileSessionView(context, server);
  return {
    context,
    status: {
      ...local,
      state: reconciled.state,
      enforcement: reconciled.enforcement,
      local: {
        state: local.state,
        enforcement: context.enforcement,
        session_id: context.session_id,
        generation: context.generation,
        has_private_proof: local.has_private_proof,
      },
      server: {
        session_id: server.session_id,
        generation: server.generation,
        lifecycle_state: server.lifecycle_state,
        is_live: server.is_live,
        expired_at: server.expired_at,
        managed_at: server.managed_at,
        provider: server.provider,
        host_label: server.host_label,
        host_session_ref: server.host_session_ref,
      },
    },
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
  let serverRefusal: AgentSessionErrorCode | null = null;
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
    if (
      error instanceof AgentSessionError &&
      DEAD_PROOF_ON_STOP.includes(error.code)
    ) {
      /* The server no longer honours this proof (expired, retired by a human
         recover, or invalid): the execution is over whatever we do, so the
         local context is retired too. The code is reported, not hidden. */
      serverRefusal = error.code;
    } else {
      throw error;
    }
  }
  const released = markSessionReleased(context);
  await writeSessionContext(input.contextPath, released);
  return {
    state: "stopped",
    next: `Confirm with: cswarm session status --session-context ${input.contextPath}`,
    status: publicSessionStatus(
      released,
      serverRefusal === null ? {} : { server_refusal: serverRefusal },
    ),
  };
}

/** Codes that mean the server already treats this execution as over. */
export const DEAD_PROOF_ON_STOP: readonly AgentSessionErrorCode[] = [
  "session_expired",
  "session_retired",
  "session_proof_invalid",
];

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

export const SESSION_START_MODES = ["acquired", "foreground"] as const;
export type SessionStartCopyMode = (typeof SESSION_START_MODES)[number];

const SESSION_START_COPY = {
  acquired:
    "Interactive session acquired. This process did not start an ACP model and did not claim or surface asks. Run the same command with --foreground to claim and surface into the bound host conversation.",
  foreground:
    "Interactive session acquired. This process did not start an ACP model. It claims and surfaces into the bound host conversation only when the host registered an injection callback; without one it stays manual and claims nothing.",
} as const satisfies Record<SessionStartCopyMode, string>;

export function sessionStartCopy(input: {
  mode: SessionMode;
  runReceiver: boolean;
}): { mode: SessionStartCopyMode; message: string } {
  const copyMode: SessionStartCopyMode = input.runReceiver ? "foreground" : "acquired";
  return { mode: copyMode, message: SESSION_START_COPY[copyMode] };
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

export { currentHostInjection, registerHostInjection, runInteractiveReceiveOnce };
