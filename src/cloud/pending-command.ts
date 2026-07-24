import { createHash } from "node:crypto";
import { canonicalJson } from "../protocol/index.js";
import {
  CommandTransportError,
  newCommandId,
  type ConnectCommand,
  type ConnectCommandResult,
  type ThinCommandClient,
} from "./command-client.js";
import type {
  CredentialProfile,
  CredentialStore,
} from "./storage.js";

const MAX_PENDING_COMMANDS = 32;

function intentHash(
  workspace: string | undefined,
  command: ConnectCommand,
): string {
  return createHash("sha256")
    .update(canonicalJson({ workspace_id: workspace ?? null, command }))
    .digest("hex");
}

async function pendingCommandId(
  credentials: CredentialStore,
  userId: string,
  workspace: string | undefined,
  command: ConnectCommand,
): Promise<{ intent: string; commandId: string }> {
  const intent = intentHash(workspace, command);
  return await credentials.withLock(async () => {
    const current = await credentials.readProfile();
    const profile: CredentialProfile = current.userId === userId
      ? current
      : {
        version: 1,
        userId,
        workspaceId: null,
        pendingCommands: {},
      };
    const existing = profile.pendingCommands[intent];
    if (existing) return { intent, commandId: existing.commandId };
    const entries = Object.entries(profile.pendingCommands)
      .sort((left, right) => left[1].createdAt - right[1].createdAt);
    while (entries.length >= MAX_PENDING_COMMANDS) {
      const removed = entries.shift();
      if (removed) delete profile.pendingCommands[removed[0]];
    }
    const commandId = newCommandId();
    profile.pendingCommands[intent] = {
      commandId,
      kind: command.kind,
      createdAt: Date.now(),
    };
    await credentials.writeProfile(profile);
    return { intent, commandId };
  });
}

async function clearPendingCommand(
  credentials: CredentialStore,
  userId: string,
  intent: string,
): Promise<void> {
  await credentials.withLock(async () => {
    const profile = await credentials.readProfile();
    if (profile.userId !== userId || !profile.pendingCommands[intent]) return;
    delete profile.pendingCommands[intent];
    await credentials.writeProfile(profile);
  });
}

export async function sendConnectWithPending(
  client: ThinCommandClient,
  session: {
    accessToken: string;
    userId: string;
    store: CredentialStore;
  },
  workspace: string | undefined,
  command: ConnectCommand,
): Promise<ConnectCommandResult> {
  const pending = await pendingCommandId(
    session.store,
    session.userId,
    workspace,
    command,
  );
  try {
    const result = await client.sendConnect({
      ...(workspace === undefined ? {} : { workspaceId: workspace }),
      command,
      credential: session.accessToken,
      commandId: pending.commandId,
    });
    await clearPendingCommand(session.store, session.userId, pending.intent);
    return result;
  } catch (error) {
    if (!(error instanceof CommandTransportError)) {
      await clearPendingCommand(session.store, session.userId, pending.intent);
      throw error;
    }
    throw new CommandTransportError(
      `${error.message}; retry the same command to resolve its pending outcome`,
    );
  }
}
