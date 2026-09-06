import {
  CLIENT_PROTOCOL_VERSION,
  commandEndpoint,
  type CloudTarget,
} from "./config.js";
import { CommandTransportError, newCommandId } from "./command-client.js";
import {
  ACQUIRE_AGENT_SESSION_KIND,
  AGENT_SESSION_ID_HEADER,
  AGENT_SESSION_KEY_HEADER,
  DISABLE_AGENT_MANAGEMENT_KIND,
  ENABLE_AGENT_MANAGEMENT_KIND,
  RECOVER_AGENT_SESSION_KIND,
  RELEASE_AGENT_SESSION_KIND,
  RENEW_AGENT_SESSION_KIND,
  type AgentSessionProof,
} from "./session-contract.js";
import {
  AgentSessionError,
  agentSessionErrorFromBody,
} from "./session-errors.js";
import { proofHeaders, redactSessionHeaders } from "./session-proof.js";
import type { SessionContextDocument } from "./session-context.js";

export interface SessionCommandClientOptions {
  target: CloudTarget;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export interface AcquireSessionRequest {
  credential: string;
  workspaceId: string;
  context: SessionContextDocument;
  commandId?: string;
}

export interface AcquireSessionResult {
  generation: number;
  commandId: string;
}

export interface HumanSessionLifecycleRequest {
  credential: string;
  workspaceId: string;
  principalId: string;
  commandId?: string;
}

async function postSessionCommand(
  options: SessionCommandClientOptions,
  input: {
    credential: string;
    workspaceId: string;
    command: Record<string, unknown>;
    commandId: string;
    proof?: AgentSessionProof | null;
    acquireProof?: { session_id: string; key: string };
  },
): Promise<{ status: number; body: unknown }> {
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 30_000,
  );
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.credential}`,
    apikey: options.target.anonKey,
    "content-type": "application/json",
    ...(input.proof ? proofHeaders(input.proof) : {}),
    ...(input.acquireProof
      ? {
        [AGENT_SESSION_ID_HEADER]: input.acquireProof.session_id,
        [AGENT_SESSION_KEY_HEADER]: input.acquireProof.key,
      }
      : {}),
  };
  let response: Response;
  try {
    response = await fetcher(commandEndpoint(options.target), {
      method: "POST",
      headers,
      body: JSON.stringify({
        command_id: input.commandId,
        client_version: CLIENT_PROTOCOL_VERSION,
        workspace_id: input.workspaceId,
        stream: { kind: "workspace" },
        command: input.command,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const safeHeaders = JSON.stringify(redactSessionHeaders(headers));
    if ((error as Error).name === "AbortError") {
      throw new CommandTransportError(
        `session command timed out ${safeHeaders}`,
      );
    }
    throw new CommandTransportError(
      `session command failed before a response ${safeHeaders}`,
    );
  } finally {
    clearTimeout(timer);
  }
  let body: unknown = null;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = null;
  }
  if (!response.ok) {
    const sessionError = agentSessionErrorFromBody(response.status, body);
    if (sessionError) throw sessionError;
    throw new CommandTransportError(
      `session command failed (HTTP ${response.status})`,
    );
  }
  return { status: response.status, body };
}

function acceptedGeneration(body: unknown): number {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new CommandTransportError("session command returned a malformed body");
  }
  const row = body as Record<string, unknown>;
  if (typeof row.generation === "number" && Number.isSafeInteger(row.generation)) {
    return row.generation;
  }
  return 1;
}

export class AgentSessionClient {
  constructor(private readonly options: SessionCommandClientOptions) {}

  async acquire(request: AcquireSessionRequest): Promise<AcquireSessionResult> {
    const commandId = request.commandId ?? request.context.acquire_command_id;
    const { body } = await postSessionCommand(this.options, {
      credential: request.credential,
      workspaceId: request.workspaceId,
      commandId,
      /* The server (session-wire.ts parseAgentSessionAcquireHeaders) reads the
         session id and the private key from the proof headers and stores only
         the key's digest; the body carries no key material and no digest. The
         generation header is omitted: nothing has been acquired yet. */
      acquireProof: {
        session_id: request.context.session_id,
        key: request.context.session_key,
      },
      command: {
        kind: ACQUIRE_AGENT_SESSION_KIND,
        session_id: request.context.session_id,
        provider: request.context.provider,
        host_label: request.context.host_label,
        host_session_ref: request.context.host_session_id,
      },
    });
    return { generation: acceptedGeneration(body), commandId };
  }

  async renew(
    credential: string,
    workspaceId: string,
    proof: AgentSessionProof,
    commandId?: string,
  ): Promise<void> {
    await postSessionCommand(this.options, {
      credential,
      workspaceId,
      commandId: commandId ?? newCommandId(),
      proof,
      command: {
        kind: RENEW_AGENT_SESSION_KIND,
        session_id: proof.session_id,
        generation: proof.generation,
      },
    });
  }

  async release(
    credential: string,
    workspaceId: string,
    proof: AgentSessionProof,
    commandId?: string,
  ): Promise<void> {
    await postSessionCommand(this.options, {
      credential,
      workspaceId,
      commandId: commandId ?? newCommandId(),
      proof,
      command: {
        kind: RELEASE_AGENT_SESSION_KIND,
        session_id: proof.session_id,
        generation: proof.generation,
      },
    });
  }

  async enable(request: HumanSessionLifecycleRequest): Promise<void> {
    await postSessionCommand(this.options, {
      credential: request.credential,
      workspaceId: request.workspaceId,
      commandId: request.commandId ?? newCommandId(),
      command: {
        kind: ENABLE_AGENT_MANAGEMENT_KIND,
        principal_id: request.principalId,
      },
    });
  }

  async disable(request: HumanSessionLifecycleRequest): Promise<void> {
    await postSessionCommand(this.options, {
      credential: request.credential,
      workspaceId: request.workspaceId,
      commandId: request.commandId ?? newCommandId(),
      command: {
        kind: DISABLE_AGENT_MANAGEMENT_KIND,
        principal_id: request.principalId,
      },
    });
  }

  async recover(request: HumanSessionLifecycleRequest): Promise<void> {
    await postSessionCommand(this.options, {
      credential: request.credential,
      workspaceId: request.workspaceId,
      commandId: request.commandId ?? newCommandId(),
      command: {
        kind: RECOVER_AGENT_SESSION_KIND,
        principal_id: request.principalId,
      },
    });
  }
}

export { AgentSessionError };
