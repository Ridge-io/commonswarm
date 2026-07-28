import { hostname, userInfo } from "node:os";
import {
  CommandHttpError,
  ThinCommandClient,
  type ConnectCommandResult,
} from "./command-client.js";
import type { CloudTarget } from "./config.js";
import {
  requirePinnedOrigin,
  sanitizeDisplayLabel,
  sanitizePrincipalName,
  validateExplicitPrincipalName,
  type InviteLinkPayload,
  type OriginPinOptions,
} from "./invite-link.js";
import { sendConnectWithPending } from "./pending-command.js";
import type {
  CredentialProfile,
  CredentialStore,
} from "./storage.js";

const AUTO_NAME_ATTEMPTS = 5;

export interface AcceptSession {
  accessToken: string;
  userId: string;
  deviceId: string;
  email: string | null;
}

export interface PrincipalSummary {
  principalId: string;
  name: string;
}

export interface AcceptProgress {
  step:
    | "preview"
    | "login"
    | "membership"
    | "principal"
    | "default"
    | "ready";
  message: string;
  data?: Record<string, unknown>;
}

export interface AcceptOutput {
  json: boolean;
  stdout: { write(value: string): unknown };
  stderr: { write(value: string): unknown };
}

export function writeAcceptProgress(
  progress: AcceptProgress,
  output: AcceptOutput,
): void {
  const note = progress.data?.note === true;
  const human = output.json || note ? output.stderr : output.stdout;
  human.write(`${progress.message}\n`);
  if (output.json) {
    output.stdout.write(`${JSON.stringify({
      type: "progress",
      step: progress.step,
      message: progress.message,
      ...(progress.data ?? {}),
    })}\n`);
  }
}

export interface AcceptLinkRuntime {
  pinOrigin(target: CloudTarget): Promise<void>;
  currentSession(target: CloudTarget, store: CredentialStore): Promise<AcceptSession | null>;
  loginSession(target: CloudTarget, store: CredentialStore): Promise<AcceptSession>;
  membershipExists(session: AcceptSession, workspaceId: string): Promise<boolean>;
  principalById(
    session: AcceptSession,
    workspaceId: string,
    principalId: string,
  ): Promise<PrincipalSummary | null>;
  livePrincipalByName(
    session: AcceptSession,
    workspaceId: string,
    name: string,
  ): Promise<PrincipalSummary | null>;
  acceptInvitation(
    session: AcceptSession,
    workspaceHint: string,
    token: string,
  ): Promise<{ status: "accepted"; workspaceId: string } | { status: "forbidden" }>;
  createPrincipal(
    session: AcceptSession,
    workspaceId: string,
    name: string,
  ): Promise<
    | { status: "accepted"; principalId: string }
    | { status: "name_taken" }
  >;
  emit(progress: AcceptProgress): void;
  autoName?(session: AcceptSession): string;
}

export interface AcceptLinkOptions {
  payload: InviteLinkPayload;
  target: CloudTarget;
  store: CredentialStore;
  runtime: AcceptLinkRuntime;
  explicitName?: string;
}

export interface AcceptLinkResult {
  workspaceId: string;
  principalId: string;
  principalName: string;
  acceptedFresh: boolean;
  checkpointShortCircuit: boolean;
}

function sessionLabel(session: AcceptSession): string {
  return session.email ?? session.userId.slice(0, 8);
}

function profileForUser(
  profile: CredentialProfile,
  userId: string,
): CredentialProfile {
  return profile.userId === userId
    ? profile
    : {
      version: 1,
      userId,
      workspaceId: null,
      email: null,
      principalId: null,
      principalName: null,
      pendingCommands: {},
    };
}

async function writeProfile(
  store: CredentialStore,
  userId: string,
  change: (
    profile: CredentialProfile,
  ) => CredentialProfile,
): Promise<CredentialProfile> {
  return await store.withLock(async () => {
    const current = profileForUser(await store.readProfile(), userId);
    const next = change(current);
    await store.writeProfile(next);
    return next;
  });
}

export function deviceStablePrincipalName(
  deviceId: string,
  username?: string,
  host = hostname(),
): string {
  let selectedUser = username;
  if (selectedUser === undefined) {
    try {
      selectedUser = userInfo().username;
    } catch {
      selectedUser = "user";
    }
  }
  const suffix = `-${deviceId.slice(0, 8).toLowerCase()}`;
  const machine = sanitizePrincipalName(
    `${selectedUser}@${host}`,
    { truncate: true },
  )
    .slice(0, 80 - suffix.length)
    .replace(/-+$/g, "");
  return `${machine}${suffix}`;
}

function autoPrincipalName(session: AcceptSession): string {
  return deviceStablePrincipalName(session.deviceId);
}

function suffixedName(base: string, attempt: number): string {
  if (attempt === 1) return base;
  const suffix = `-${attempt}`;
  return `${base.slice(0, 80 - suffix.length).replace(/-+$/g, "")}${suffix}`;
}

function acceptedResponse(
  result: ConnectCommandResult,
): ConnectCommandResult["response"] {
  if (result.response.status !== "accepted") {
    throw new Error(
      `command was rejected: ${result.response.reason ?? "domain rejection"}`,
    );
  }
  return result.response;
}

function uuid(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
  ) {
    throw new Error(`server returned a malformed ${field}`);
  }
  return value;
}

export async function acceptInviteLink(
  options: AcceptLinkOptions,
): Promise<AcceptLinkResult> {
  const { payload, target, store, runtime } = options;
  const workspaceName = sanitizeDisplayLabel(payload.workspace_name, "this swarm");
  const inviterName = sanitizeDisplayLabel(
    payload.inviter_display_name,
    "the inviter",
  );
  const explicitName = options.explicitName === undefined
    ? undefined
    : validateExplicitPrincipalName(options.explicitName);

  await runtime.pinOrigin(target);
  runtime.emit({
    step: "preview",
    message:
      `You're accepting an invitation to the "${workspaceName}" swarm from ${inviterName}. This will sign you in with GitHub and register this machine's agent identity.`,
  });

  let session = await runtime.currentSession(target, store);
  if (session) {
    runtime.emit({
      step: "login",
      message: `Already signed in as ${sessionLabel(session)}.`,
    });
  } else {
    runtime.emit({
      step: "login",
      message: "Signing you in with GitHub… opening your browser.",
    });
    session = await runtime.loginSession(target, store);
    runtime.emit({
      step: "login",
      message: `Signed in as ${sessionLabel(session)}.`,
    });
  }

  if (payload.inviter_user_id === session.userId) {
    throw new Error(
      "You're signed in as the person who sent this invitation. To join as a second person, use a GitHub account with a different verified email.",
    );
  }

  let profile = profileForUser(await store.readProfile(), session.userId);
  if (
    profile.workspaceId === payload.workspace_id &&
    profile.principalId
  ) {
    const [membership, principal] = await Promise.all([
      runtime.membershipExists(session, payload.workspace_id),
      runtime.principalById(
        session,
        payload.workspace_id,
        profile.principalId,
      ),
    ]);
    if (membership && principal) {
      if (
        explicitName !== undefined &&
        explicitName !== (profile.principalName ?? principal.name)
      ) {
        runtime.emit({
          step: "principal",
          message: `Already connected as ${principal.name}; --name ignored.`,
          data: { note: true },
        });
      }
      runtime.emit({
        step: "membership",
        message: `You're already a member of "${workspaceName}".`,
        data: { workspace_id: payload.workspace_id, recovered: true },
      });
      runtime.emit({
        step: "principal",
        message: `This machine already has an agent identity: ${principal.name}.`,
        data: { principal_id: principal.principalId, name: principal.name },
      });
      runtime.emit({
        step: "ready",
        message:
          `You're connected to "${workspaceName}". Your agent gets its credential when it starts work (cswarm token mint).`,
        data: {
          workspace_id: payload.workspace_id,
          principal_id: principal.principalId,
          principal_name: principal.name,
        },
      });
      return {
        workspaceId: payload.workspace_id,
        principalId: principal.principalId,
        principalName: principal.name,
        acceptedFresh: false,
        checkpointShortCircuit: true,
      };
    }
  }

  let workspaceId: string;
  let acceptedFresh = false;
  try {
    const accepted = await runtime.acceptInvitation(
      session,
      payload.workspace_id,
      payload.invitation_token,
    );
    if (accepted.status === "accepted") {
      workspaceId = accepted.workspaceId;
      acceptedFresh = true;
      runtime.emit({
        step: "membership",
        message: `You're now a member of "${workspaceName}".`,
        data: { workspace_id: workspaceId },
      });
    } else {
      const membership = await runtime.membershipExists(
        session,
        payload.workspace_id,
      );
      if (!membership) {
        throw new Error(
          `This invitation can't be used — it may have expired, already been used, or been revoked. Ask ${inviterName} for a new link.`,
        );
      }
      workspaceId = payload.workspace_id;
      runtime.emit({
        step: "membership",
        message:
          `You're already a member of this workspace. If you expected this link to add you somewhere new, it can't be used — ask ${inviterName} for a new invite.`,
        data: { workspace_id: workspaceId, invitation_accepted: false },
      });
    }
  } catch (error) {
    if (!(error instanceof CommandHttpError) || error.status !== 403) throw error;
    const membership = await runtime.membershipExists(
      session,
      payload.workspace_id,
    );
    if (!membership) {
      throw new Error(
        `This invitation can't be used — it may have expired, already been used, or been revoked. Ask ${inviterName} for a new link.`,
      );
    }
    workspaceId = payload.workspace_id;
    runtime.emit({
      step: "membership",
      message:
        `You're already a member of this workspace. If you expected this link to add you somewhere new, it can't be used — ask ${inviterName} for a new invite.`,
      data: { workspace_id: workspaceId, invitation_accepted: false },
    });
  }

  const previousDefault = profile.workspaceId;
  if (acceptedFresh) {
    profile = await writeProfile(store, session.userId, (current) => ({
      ...current,
      userId: session.userId,
      workspaceId,
      email: session.email ?? current.email ?? null,
      principalId: current.workspaceId === workspaceId
        ? current.principalId ?? null
        : null,
      principalName: current.workspaceId === workspaceId
        ? current.principalName ?? null
        : null,
    }));
  }

  const selectedBase = explicitName ??
    (
      profile.workspaceId === workspaceId && profile.principalName
        ? profile.principalName
        : runtime.autoName?.(session) ?? autoPrincipalName(session)
    );
  const baseName = sanitizePrincipalName(selectedBase, {
    truncate: explicitName === undefined,
  });
  let principal: PrincipalSummary | null = null;
  let chosenName = baseName;

  for (let attempt = 1; attempt <= AUTO_NAME_ATTEMPTS; attempt += 1) {
    chosenName = explicitName === undefined
      ? suffixedName(baseName, attempt)
      : baseName;
    principal = await runtime.livePrincipalByName(
      session,
      workspaceId,
      chosenName,
    );
    if (principal) {
      runtime.emit({
        step: "principal",
        message: `This machine already has an agent identity: ${principal.name}.`,
        data: { principal_id: principal.principalId, name: principal.name },
      });
      break;
    }
    const created = await runtime.createPrincipal(
      session,
      workspaceId,
      chosenName,
    );
    if (created.status === "accepted") {
      principal = { principalId: created.principalId, name: chosenName };
      runtime.emit({
        step: "principal",
        message: `Registered this machine's agent identity: ${chosenName}.`,
        data: { principal_id: created.principalId, name: chosenName },
      });
      break;
    }
    const raced = await runtime.livePrincipalByName(
      session,
      workspaceId,
      chosenName,
    );
    if (raced) {
      principal = raced;
      runtime.emit({
        step: "principal",
        message: `This machine already has an agent identity: ${raced.name}.`,
        data: { principal_id: raced.principalId, name: raced.name },
      });
      break;
    }
    if (explicitName !== undefined) {
      throw new Error(
        `The name "${chosenName}" is already taken in this workspace. Re-run with a different --name.`,
      );
    }
  }

  if (!principal) {
    throw new Error(
      `Couldn't pick an automatic name for this machine's agent identity — names like "${baseName}" are already taken here. Re-run with --name <your-choice> to pick one explicitly.`,
    );
  }

  if (
    acceptedFresh ||
    previousDefault === null ||
    previousDefault === workspaceId
  ) {
    profile = await writeProfile(store, session.userId, (current) => ({
      ...current,
      userId: session.userId,
      workspaceId:
        acceptedFresh ||
          current.workspaceId === null ||
          current.workspaceId === workspaceId
          ? workspaceId
          : current.workspaceId,
      email: session.email ?? current.email ?? null,
      principalId:
        acceptedFresh ||
          current.workspaceId === null ||
          current.workspaceId === workspaceId
          ? principal!.principalId
          : current.principalId ?? null,
      principalName:
        acceptedFresh ||
          current.workspaceId === null ||
          current.workspaceId === workspaceId
          ? principal!.name
          : current.principalName ?? null,
    }));
  }

  if (
    acceptedFresh &&
    previousDefault !== null &&
    previousDefault !== workspaceId
  ) {
    runtime.emit({
      step: "default",
      message:
        `Your default workspace is now "${workspaceName}" (was another workspace).`,
      data: { workspace_id: workspaceId, previous_workspace_id: previousDefault },
    });
  }
  runtime.emit({
    step: "ready",
    message:
      `You're connected to "${workspaceName}". Your agent gets its credential when it starts work (cswarm token mint).`,
    data: {
      workspace_id: workspaceId,
      principal_id: principal.principalId,
      principal_name: principal.name,
    },
  });
  return {
    workspaceId,
    principalId: principal.principalId,
    principalName: principal.name,
    acceptedFresh,
    checkpointShortCircuit: false,
  };
}

async function rows(
  target: CloudTarget,
  session: AcceptSession,
  resource: string,
  parameters: Record<string, string>,
  fetcher: typeof fetch,
): Promise<Array<Record<string, unknown>>> {
  const url = new URL(`/rest/v1/${resource}`, target.url);
  for (const [key, value] of Object.entries(parameters)) {
    url.searchParams.set(key, value);
  }
  const response = await fetcher(url, {
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      apikey: target.anonKey,
      "accept-profile": "swarm_read",
    },
  });
  if (!response.ok) {
    throw new Error(`workspace read failed (HTTP ${response.status})`);
  }
  const body = await response.json().catch(() => null);
  if (!Array.isArray(body)) {
    throw new Error("workspace read returned malformed JSON");
  }
  return body.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
  );
}

export function cloudAcceptOperations(
  target: CloudTarget,
  store: CredentialStore,
  fetcher: typeof fetch = fetch,
): Pick<
  AcceptLinkRuntime,
  | "membershipExists"
  | "principalById"
  | "livePrincipalByName"
  | "acceptInvitation"
  | "createPrincipal"
> {
  const client = new ThinCommandClient(target, fetcher);
  return {
    async membershipExists(session, workspaceId) {
      const found = await rows(
        target,
        session,
        "memberships",
        {
          select: "workspace_id",
          workspace_id: `eq.${workspaceId}`,
          user_id: `eq.${session.userId}`,
          revoked_at: "is.null",
          limit: "1",
        },
        fetcher,
      );
      return found.length === 1;
    },
    async principalById(session, workspaceId, principalId) {
      const found = await rows(
        target,
        session,
        "agent_principals",
        {
          select: "principal_id,name",
          workspace_id: `eq.${workspaceId}`,
          owner_user_id: `eq.${session.userId}`,
          principal_id: `eq.${principalId}`,
          revoked_at: "is.null",
          limit: "1",
        },
        fetcher,
      );
      const principal = found[0];
      return principal &&
          typeof principal.principal_id === "string" &&
          typeof principal.name === "string"
        ? { principalId: principal.principal_id, name: principal.name }
        : null;
    },
    async livePrincipalByName(session, workspaceId, name) {
      const found = await rows(
        target,
        session,
        "agent_principals",
        {
          select: "principal_id,name",
          workspace_id: `eq.${workspaceId}`,
          owner_user_id: `eq.${session.userId}`,
          name: `eq.${name}`,
          revoked_at: "is.null",
          limit: "1",
        },
        fetcher,
      );
      const principal = found[0];
      return principal &&
          typeof principal.principal_id === "string" &&
          typeof principal.name === "string"
        ? { principalId: principal.principal_id, name: principal.name }
        : null;
    },
    async acceptInvitation(session, _workspaceHint, token) {
      try {
        const response = acceptedResponse(
          await sendConnectWithPending(
            client,
            { ...session, store },
            undefined,
            { kind: "accept_invitation", token },
          ),
        );
        return {
          status: "accepted" as const,
          workspaceId: uuid(response.workspace_id, "workspace_id"),
        };
      } catch (error) {
        if (error instanceof CommandHttpError && error.status === 403) {
          return { status: "forbidden" as const };
        }
        throw error;
      }
    },
    async createPrincipal(session, workspaceId, name) {
      const result = await sendConnectWithPending(
        client,
        { ...session, store },
        workspaceId,
        { kind: "create_agent_principal", name },
      );
      if (result.response.status === "accepted") {
        return {
          status: "accepted" as const,
          principalId: uuid(result.response.principal_id, "principal_id"),
        };
      }
      if (String(result.response.reason) === "principal_name_taken") {
        return { status: "name_taken" as const };
      }
      throw new Error(
        `principal creation was rejected: ${
          result.response.reason ?? "domain rejection"
        }`,
      );
    },
  };
}

export function originPin(
  options: OriginPinOptions,
): (target: CloudTarget) => Promise<void> {
  return async (target) => await requirePinnedOrigin(target, options);
}
