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
export const CAPABILITY_TOKEN_RE = /^swm_cap_[A-Za-z0-9_-]{43}$/;
const CONTROL_RE =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

/** Mirrors the bound the command function enforces, so a typo fails before the round trip. */
export const WORKSPACE_NAME_MAX_LENGTH = 80;

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
  stream_id?: string;
  signal?: SignalRecord;
  capability_id?: string;
  /**
   * Fresh-response-only. A replayed mint deliberately omits it: the raw credential is
   * never persisted in the server's idempotency ledger, so there is nothing to replay.
   */
  capability_token?: string;
  expires_at?: string;
  revoked_at?: string;
}

export interface CommandResult {
  httpStatus: number;
  response: CommandHttpResponse;
  projection: TaskState | null;
}

export type ConnectCommand =
  | { kind: "invite_member"; email: string; ttl_ms?: number }
  | { kind: "revoke_invitation"; invitation_id: string }
  | { kind: "accept_invitation"; token: string }
  | { kind: "create_workspace"; workspace_id: string; name: string }
  | { kind: "remove_member"; user_id: string }
  | { kind: "create_agent_principal"; name: string; model?: string }
  | { kind: "revoke_agent_principal"; principal_id: string }
  | {
    kind: "mint_agent_token";
    principal_id: string;
    run_id: string;
    task_id: string;
    epoch: number;
    device_id: string;
    ttl_ms?: number;
  }
  | { kind: "revoke_agent_token"; token_id: string };

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

/**
 * Capability-URL commands are human-interactive-credential operations (SWARM-CLOUD.md
 * §7, "Human-mint-only") and are deliberately NOT ConnectCommands: the command function
 * reads them ahead of route resolution and refuses a request that pins a stream, because
 * the stream is derived server-side from (workspace_id, task_id) and is not selectable.
 */
export type CapabilityCommand =
  | { kind: "mint_capability_url"; task_id: string; ttl_ms?: number }
  | { kind: "revoke_capability_url"; capability_id: string };

export interface CapabilityCommandRequest {
  workspaceId: string;
  command: CapabilityCommand;
  credential: string;
  commandId?: string;
}

export interface CapabilityCommandResult {
  httpStatus: number;
  response: CommandHttpResponse;
}

/** Bounds the server's own TTL window locally, so a typo fails before a credential exists. */
export const CAPABILITY_MIN_TTL_MS = 60_000;
export const CAPABILITY_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type SignalKind = "working-on" | "note" | "ask";

export interface PostSignalCommand {
  kind: "post_signal";
  signal_kind: SignalKind;
  body: string;
  /** Human recipient; mutually exclusive with to_agent_principal_id. */
  to_user_id: string | null;
  /** Agent recipient; mutually exclusive with to_user_id. Always sent (null when absent). */
  to_agent_principal_id: string | null;
  /** Correlates a reply to the signal it answers. Always sent (null when absent). */
  in_reply_to: string | null;
  about: string | null;
  until_ms?: number;
}

export interface SignalRecord {
  id: string;
  workspace_id: string;
  from: string;
  from_kind: "user" | "agent";
  to: string | null;
  to_agent: string | null;
  in_reply_to: string | null;
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

export class ReauthenticationRequired extends CommandHttpError {
  constructor() {
    super(
      401,
      "Sign in again with cswarm login, then repeat the member remove command. No membership change was recorded.",
    );
    this.name = "ReauthenticationRequired";
  }
}

/**
 * Creating a project is the one refusal a stranger meets before they have any
 * context, so it carries a sentence instead of a status code.
 */
export class CreateWorkspaceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CreateWorkspaceError";
  }
}

/**
 * Turns a refused create_workspace response into something the person who typed
 * the command can act on, rather than a raw HTTP status.
 */
export function createWorkspaceError(
  status: number,
  body: unknown,
): CreateWorkspaceError {
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const code = typeof record.error === "string" ? record.error : "unknown";
  if (status === 403 && code === "workspace_limit_reached") {
    const limit = typeof record.limit === "number" ? record.limit : null;
    return new CreateWorkspaceError(
      status,
      code,
      `${
        limit === null
          ? "You have already created as many projects as this account allows."
          : `You have already created ${limit} projects, which is the limit for one account.`
      } Archiving a project frees its slot; the CLI cannot archive one yet, so ask whoever operates this deployment. Projects you were invited to do not count against the limit.`,
    );
  }
  if (status === 403) {
    return new CreateWorkspaceError(
      status,
      "forbidden",
      "CommonSwarm did not create the project. Creating your own project is not open on this deployment yet, and it also needs a confirmed email address on your account. If someone has already invited you, cswarm accept --link-stdin joins their project.",
    );
  }
  if (status === 426) {
    const minimum = typeof record.min_client_version === "string"
      ? record.min_client_version
      : null;
    return new CreateWorkspaceError(
      status,
      "upgrade_required",
      `This copy of cswarm is older than the deployment accepts${
        minimum === null ? "" : ` (minimum ${minimum})`
      }. Update cswarm, then run the same command again.`,
    );
  }
  if (status === 400) {
    return new CreateWorkspaceError(
      status,
      code === "unknown" ? "invalid_request" : code,
      "The deployment did not accept the request. Nothing was created. Check cswarm --version against the deployment before trying again.",
    );
  }
  if (status === 401) {
    return new CreateWorkspaceError(
      status,
      "unauthenticated",
      "Your sign-in is no longer valid for this deployment. Run cswarm login, then run the same command again.",
    );
  }
  return new CreateWorkspaceError(
    status,
    code,
    `CommonSwarm could not tell whether the project was created (HTTP ${status}). Run cswarm workspaces to see whether it exists before trying again.`,
  );
}

/**
 * A refused capability-link command. Separate from CommandHttpError because two of its
 * refusals are recoverable by the person who typed the command (the live-link ceiling and
 * the hourly rate limit) and deserve a sentence rather than a status code.
 */
export class CapabilityCommandError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CapabilityCommandError";
  }
}

/**
 * Turns a refused capability command into something actionable. It never carries a
 * credential: the raw swm_cap_ token exists only in a fresh 200 body, so no failure path
 * has one to leak into a message.
 */
export function capabilityCommandError(
  status: number,
  body: unknown,
  verb: "mint" | "revoke",
): CapabilityCommandError {
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const code = typeof record.error === "string" ? record.error : "unknown";
  if (status === 403 && code === "capability_limit_reached") {
    const limit = typeof record.limit === "number" ? record.limit : null;
    return new CapabilityCommandError(
      status,
      code,
      `This project already has ${
        limit === null ? "as many live links as it allows" : `${limit} live links`
      }. Revoke one you no longer need with cswarm link revoke --capability-id <uuid>, or wait for some to expire.`,
    );
  }
  if (status === 403) {
    return new CapabilityCommandError(
      status,
      "forbidden",
      verb === "mint"
        ? "CommonSwarm did not create the link. Links are minted by a project owner or admin signed in with a confirmed email, for a work item that exists in this project — and never by an agent credential. Nothing was created."
        : "CommonSwarm did not revoke that link. Either it is not a live link in this project, or your account may not revoke links here — and an agent credential may never revoke one. Nothing changed.",
    );
  }
  if (status === 429) {
    const message = typeof record.message === "string"
      ? record.message.slice(0, 400)
      : "Too many link requests in the last hour. Try again shortly.";
    return new CapabilityCommandError(status, "rate_limited", message);
  }
  if (status === 426) {
    const minimum = typeof record.min_client_version === "string"
      ? record.min_client_version
      : null;
    return new CapabilityCommandError(
      status,
      "upgrade_required",
      `This copy of cswarm is older than the deployment accepts${
        minimum === null ? "" : ` (minimum ${minimum})`
      }. Update cswarm, then run the same command again.`,
    );
  }
  if (status === 409) {
    return new CapabilityCommandError(
      status,
      "command_id_conflict",
      "A different command already used this request id. Run the command again to issue a fresh one.",
    );
  }
  if (status === 400) {
    return new CapabilityCommandError(
      status,
      code === "unknown" ? "invalid_request" : code,
      "The deployment did not accept the request. Nothing changed. Check cswarm --version against the deployment before trying again.",
    );
  }
  if (status === 401) {
    return new CapabilityCommandError(
      status,
      "unauthenticated",
      "Your sign-in is no longer valid for this deployment. Run cswarm login, then run the same command again.",
    );
  }
  return new CapabilityCommandError(
    status,
    code,
    `CommonSwarm could not tell whether the link ${
      verb === "mint" ? "was created" : "was revoked"
    } (HTTP ${status}). Run the same command again to resolve its outcome.`,
  );
}

/** Bounds the name here so a typo is answered locally, in the same words the server uses. */
export function assertWorkspaceName(value: string): void {
  if (value.length === 0) {
    throw new Error("a project name is required");
  }
  if (value.length > WORKSPACE_NAME_MAX_LENGTH) {
    throw new Error(
      `a project name may be at most ${WORKSPACE_NAME_MAX_LENGTH} characters; this one is ${value.length}`,
    );
  }
  if (CONTROL_RE.test(value)) {
    throw new Error("a project name may not contain control characters");
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

/**
 * Why it exists separately from the message it guards: a capability credential must be
 * proven well-formed without ever being quoted, so this reports the shape and never the
 * value. Nothing else in the CLI may put a swm_cap_ string into an Error.
 */
export function assertCapabilityToken(value: string): void {
  if (!CAPABILITY_TOKEN_RE.test(value)) {
    throw new Error(
      "capability link credential must be swm_cap_ followed by 32 base64url-encoded random bytes",
    );
  }
}

// A human login is a GoTrue access token: three base64url segments separated by dots.
// Checked positively rather than by denying swm_ prefixes, so a credential kind invented
// tomorrow is refused here by default instead of being waved through.
const HUMAN_ACCESS_TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Why it exists although the server already refuses: §7 is human-mint-only, and the
 * server's 403 is deliberately uniform, so a caller holding an agent credential learns
 * only that something was forbidden. This says which rule was hit, before the round trip.
 * It reports the credential's kind and never its value, like the assertions above.
 */
export function assertHumanCapabilityCredential(
  credential: string,
  verb: "create" | "revoke",
): void {
  if (HUMAN_ACCESS_TOKEN_RE.test(credential)) return;
  const agent = AGENT_TOKEN_RE.test(credential);
  throw new Error(
    `only a signed-in person can ${verb} a capability link, and this command was given ${
      agent ? "an agent credential" : "a credential that is not a human login"
    }. The link is minted by a project owner or admin whose email is confirmed; an agent credential can never mint or revoke one, so a compromised worker cannot hand out board state. Run cswarm login as that person, or ask an owner or admin to run this command.`,
  );
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
      if (response.status === 401 && error === "fresh_auth_required") {
        throw new ReauthenticationRequired();
      }
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
    const creating = command.kind === "create_workspace";
    // Both of these run before the caller has a tenancy to route to, so neither
    // may carry workspace_id or stream: the command function reads them ahead of
    // route resolution and rejects a request that pins a route it cannot check.
    const untenanted = command.kind === "accept_invitation" || creating;
    if (command.kind === "accept_invitation") {
      if (request.workspaceId !== undefined) {
        throw new Error("accept_invitation tenancy is derived from its capability");
      }
      assertInvitationToken(command.token);
    } else if (creating) {
      if (request.workspaceId !== undefined) {
        throw new Error(
          "create_workspace carries its own client-generated workspace_id and cannot be routed to an existing one",
        );
      }
      assertWorkspaceName(command.name);
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
          ...(untenanted
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

    if (creating && !response.ok) {
      // The one connect command whose refusals do differ for the caller: the
      // limit is recoverable, a closed front door is not. Read the body once.
      let body: unknown = null;
      try {
        body = await parsedJson(response);
      } catch (error) {
        // A body that never arrived is a transport fact, not a refusal.
        if (error instanceof CommandTransportError) throw error;
      }
      throw createWorkspaceError(response.status, body);
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
      if (response.status === 401 && error === "fresh_auth_required") {
        throw new ReauthenticationRequired();
      }
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

  /**
   * Capability-link mint/revoke. The body carries no `stream` key at all — the command
   * function refuses one, because the only thing a caller may name about the target is
   * the task id; its stream and tenant are resolved server-side and FK-pinned.
   */
  async sendCapability(
    request: CapabilityCommandRequest,
  ): Promise<CapabilityCommandResult> {
    const command = request.command;
    if (!request.workspaceId) {
      throw new Error("workspaceId is required for a capability link command");
    }
    if (
      command.kind === "mint_capability_url" &&
      command.ttl_ms !== undefined &&
      (!Number.isSafeInteger(command.ttl_ms) ||
        command.ttl_ms < CAPABILITY_MIN_TTL_MS ||
        command.ttl_ms > CAPABILITY_MAX_TTL_MS)
    ) {
      throw new Error(
        `a capability link lifetime must be between ${CAPABILITY_MIN_TTL_MS} and ${CAPABILITY_MAX_TTL_MS} milliseconds (7 days)`,
      );
    }
    const commandId = request.commandId ?? newCommandId();
    const verb = command.kind === "mint_capability_url" ? "mint" : "revoke";
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
          command,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new CommandTransportError("capability link request timed out");
      }
      throw new CommandTransportError(
        "capability link request failed before a response",
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let body: unknown = null;
      try {
        body = await parsedJson(response);
      } catch (error) {
        // A body that never arrived is a transport fact, not a refusal.
        if (error instanceof CommandTransportError) throw error;
      }
      throw capabilityCommandError(response.status, body, verb);
    }
    const body = responseBody(await parsedJson(response));
    if (body.min_client_version !== undefined) {
      const order = compareVersion(
        CLIENT_PROTOCOL_VERSION,
        body.min_client_version,
      );
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
    // New clients always send both target fields and in_reply_to (null when absent).
    const command: PostSignalCommand = {
      kind: "post_signal",
      signal_kind: request.command.signal_kind,
      body: request.command.body,
      to_user_id: request.command.to_user_id,
      to_agent_principal_id: request.command.to_agent_principal_id,
      in_reply_to: request.command.in_reply_to,
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
