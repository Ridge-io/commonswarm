import { randomBytes } from "node:crypto";
import {
  reduceTask,
  upcastEnvelope,
  type Command,
  type EventEnvelope,
  type StoredResponse,
  type TaskState,
} from "../protocol/index.js";
import {
  CLIENT_PROTOCOL_VERSION,
  commandEndpoint,
  type CloudTarget,
} from "./config.js";

const AGENT_TOKEN_RE = /^swm_agt_[A-Za-z0-9_-]{43}$/;
export const INVITATION_TOKEN_RE = /^swm_inv_[A-Za-z0-9_-]{43}$/;

export type StreamRoute =
  | { kind: "workspace" }
  | { kind: "repo"; repo_mapping_id: string };

export interface CommandRequest {
  workspaceId: string;
  stream: StreamRoute;
  command: Command;
  credential: string;
  commandId?: string;
}

export interface CommandHttpResponse extends StoredResponse {
  status: "accepted" | "rejected";
  events?: EventEnvelope[];
  min_client_version?: string;
  invitation_id?: string;
  invitation_token?: string;
  workspace_name?: string;
  inviter_display_name?: string;
  inviter_user_id?: string;
  principal_id?: string;
  token_id?: string;
  run_id?: string;
  agent_token?: string;
  workspace_id?: string;
  signal?: SignalRecord;
}

export interface CommandResult {
  httpStatus: number;
  response: CommandHttpResponse;
  projection: TaskState | null;
}

export type ConnectCommand =
  | { kind: "invite_member"; email: string; ttl_ms?: number }
  | { kind: "accept_invitation"; token: string }
  | { kind: "create_agent_principal"; name: string }
  | {
    kind: "mint_agent_token";
    principal_id: string;
    run_id: string;
    task_id: string;
    epoch: number;
    device_id: string;
    ttl_ms?: number;
  };

export interface ConnectCommandRequest {
  /** Omitted for accept_invitation; the capability derives tenancy server-side. */
  workspaceId?: string;
  command: ConnectCommand;
  credential: string;
  commandId?: string;
}

export interface ConnectCommandResult {
  httpStatus: number;
  response: CommandHttpResponse;
}

export type SignalKind = "working-on" | "note" | "ask";

export interface PostSignalCommand {
  kind: "post_signal";
  signal_kind: SignalKind;
  body: string;
  to_user_id: string | null;
  about: string | null;
  until_ms?: number;
}

export interface SignalRecord {
  id: string;
  workspace_id: string;
  from: string;
  from_kind: "user" | "agent";
  to: string | null;
  about: string | null;
  kind: SignalKind;
  body: string;
  until: string;
  created_at: string;
}

export interface PostSignalRequest {
  workspaceId: string;
  command: PostSignalCommand;
  credential: string;
  commandId?: string;
}

export interface PostSignalResult {
  httpStatus: number;
  response: CommandHttpResponse;
}

export class CommandTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandTransportError";
  }
}

export class CommandHttpError extends Error {
  constructor(
    readonly status: number,
    message = `command failed (HTTP ${status})`,
  ) {
    super(message);
    this.name = "CommandHttpError";
  }
}

export function newCommandId(): string {
  return `cmd_${randomBytes(18).toString("base64url")}`;
}

export function assertAgentToken(value: string): void {
  if (!AGENT_TOKEN_RE.test(value)) {
    throw new Error(
      "agent credential must be swm_agt_ followed by 32 base64url-encoded random bytes",
    );
  }
}

export function assertInvitationToken(value: string): void {
  if (!INVITATION_TOKEN_RE.test(value)) {
    throw new Error(
      "invitation capability must be swm_inv_ followed by 32 base64url-encoded random bytes",
    );
  }
}

function semver(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(value);
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : null;
}

function compareVersion(left: string, right: string): number | null {
  const a = semver(left);
  const b = semver(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function responseBody(value: unknown): CommandHttpResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("command endpoint returned a non-object response");
  }
  const body = value as Record<string, unknown>;
  if (body.status !== "accepted" && body.status !== "rejected") {
    throw new Error("command endpoint response is missing a valid status");
  }
  if (typeof body.ok !== "boolean" || !Array.isArray(body.event_ids)) {
    throw new Error("command endpoint response is missing StoredResponse fields");
  }
  if (
    body.status === "accepted" && body.ok !== true ||
    body.status === "rejected" && body.ok !== false
  ) {
    throw new Error("command endpoint response status and ok fields disagree");
  }
  return body as unknown as CommandHttpResponse;
}

async function parsedJson(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new CommandTransportError(
      "command response was interrupted before its outcome could be read",
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`command endpoint returned non-JSON (HTTP ${response.status})`);
  }
}

export class ThinCommandClient {
  private readonly projections = new Map<string, TaskState>();

  constructor(
    private readonly target: CloudTarget,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  projection(taskId: string): TaskState | null {
    return this.projections.get(taskId) ?? null;
  }

  async send(request: CommandRequest): Promise<CommandResult> {
    const commandId = request.commandId ?? newCommandId();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let response: Response;
    try {
      response = await this.fetcher(commandEndpoint(this.target), {
        method: "POST",
        headers: {
          authorization: `Bearer ${request.credential}`,
          apikey: this.target.anonKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command_id: commandId,
          client_version: CLIENT_PROTOCOL_VERSION,
          workspace_id: request.workspaceId,
          stream: request.stream,
          command: request.command,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new CommandTransportError("command request timed out");
      }
      throw new CommandTransportError("command request failed before a response");
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 403) {
      // Forbidden responses carry no actionable client-side distinction.
      throw new CommandHttpError(403);
    }
    const raw = await parsedJson(response);
    if (!response.ok) {
      const error = raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).error
        : null;
      throw new CommandHttpError(
        response.status,
        `command failed (HTTP ${response.status}): ${
          typeof error === "string" ? error : "unknown_error"
        }`,
      );
    }
    const body = responseBody(raw);
    if (body.min_client_version !== undefined) {
      const order = compareVersion(CLIENT_PROTOCOL_VERSION, body.min_client_version);
      if (order === null) {
        throw new Error("server returned a malformed min_client_version");
      }
      if (order < 0) {
        throw new Error(
          `client upgrade required (minimum ${body.min_client_version})`,
        );
      }
    }

    let projection = this.projection(request.command.task_id);
    if (body.status === "accepted" && Array.isArray(body.events)) {
      for (const rawEvent of body.events) {
        const event = upcastEnvelope(rawEvent);
        if (projection === null && event.type !== "TaskCreated") {
          // A one-shot thin command has no prior stream history. The server
          // outcome is still printed; in-memory folding becomes available when
          // commands are driven in one process (the dogfood sequence).
          continue;
        }
        projection = reduceTask(projection, event);
      }
      if (projection !== null) {
        this.projections.set(request.command.task_id, projection);
      }
    }
    return { httpStatus: response.status, response: body, projection };
  }

  async sendConnect(request: ConnectCommandRequest): Promise<ConnectCommandResult> {
    const command = request.command;
    const accepting = command.kind === "accept_invitation";
    if (command.kind === "accept_invitation") {
      if (request.workspaceId !== undefined) {
        throw new Error("accept_invitation tenancy is derived from its capability");
      }
      assertInvitationToken(command.token);
    } else if (!request.workspaceId) {
      throw new Error("workspaceId is required for this command");
    }
    const commandId = request.commandId ?? newCommandId();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let response: Response;
    try {
      response = await this.fetcher(commandEndpoint(this.target), {
        method: "POST",
        headers: {
          authorization: `Bearer ${request.credential}`,
          apikey: this.target.anonKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command_id: commandId,
          client_version: CLIENT_PROTOCOL_VERSION,
          ...(accepting
            ? {}
            : {
              workspace_id: request.workspaceId,
              stream: { kind: "workspace" },
            }),
          command,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new CommandTransportError("command request timed out");
      }
      throw new CommandTransportError("command request failed before a response");
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 403) {
      // Invitation failures are deliberately byte-identical. Do not decode or
      // branch on their body; recovery is membership-side.
      throw new CommandHttpError(403);
    }
    const raw = await parsedJson(response);
    if (!response.ok) {
      const error = raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).error
        : null;
      throw new CommandHttpError(
        response.status,
        `command failed (HTTP ${response.status}): ${
          typeof error === "string" ? error : "unknown_error"
        }`,
      );
    }
    const body = responseBody(raw);
    if (body.min_client_version !== undefined) {
      const order = compareVersion(CLIENT_PROTOCOL_VERSION, body.min_client_version);
      if (order === null) {
        throw new Error("server returned a malformed min_client_version");
      }
      if (order < 0) {
        throw new Error(
          `client upgrade required (minimum ${body.min_client_version})`,
        );
      }
    }
    return { httpStatus: response.status, response: body };
  }

  async sendSignal(request: PostSignalRequest): Promise<PostSignalResult> {
    const commandId = request.commandId ?? newCommandId();
    const command: PostSignalCommand = {
      kind: "post_signal",
      signal_kind: request.command.signal_kind,
      body: request.command.body,
      to_user_id: request.command.to_user_id,
      about: request.command.about,
      ...(request.command.until_ms === undefined
        ? {}
        : { until_ms: request.command.until_ms }),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let response: Response;
    try {
      response = await this.fetcher(commandEndpoint(this.target), {
        method: "POST",
        headers: {
          authorization: `Bearer ${request.credential}`,
          apikey: this.target.anonKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command_id: commandId,
          client_version: CLIENT_PROTOCOL_VERSION,
          workspace_id: request.workspaceId,
          stream: { kind: "workspace" },
          command,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new CommandTransportError("signal request timed out");
      }
      throw new CommandTransportError(
        "signal request failed before a response",
      );
    } finally {
      clearTimeout(timer);
    }

    let raw: unknown;
    try {
      raw = await parsedJson(response);
    } catch (error) {
      if (response.status >= 500) {
        throw new CommandHttpError(
          response.status,
          `signal failed (HTTP ${response.status})`,
        );
      }
      throw error;
    }
    if (!response.ok) {
      const error = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : {};
      throw new CommandHttpError(
        response.status,
        typeof error.message === "string"
          ? error.message
          : `signal failed (HTTP ${response.status}): ${
            typeof error.error === "string" ? error.error : "unknown_error"
          }`,
      );
    }
    const body = responseBody(raw);
    if (body.status !== "accepted" || body.signal === undefined) {
      throw new Error("signal endpoint accepted without a signal receipt");
    }
    if (body.min_client_version !== undefined) {
      const order = compareVersion(CLIENT_PROTOCOL_VERSION, body.min_client_version);
      if (order === null) {
        throw new Error("server returned a malformed min_client_version");
      }
      if (order < 0) {
        throw new Error(
          `client upgrade required (minimum ${body.min_client_version})`,
        );
      }
    }
    return { httpStatus: response.status, response: body };
  }
}
