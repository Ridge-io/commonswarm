import { createHash } from "node:crypto";
import { canonicalJson } from "../protocol/index.js";
import {
  CommandHttpError,
  CommandTransportError,
  newCommandId,
  ReauthenticationRequired,
  type CapabilityCommand,
  type CapabilityCommandResult,
  type ConnectCommand,
  type ConnectCommandResult,
  type PostSignalCommand,
  type PostSignalResult,
  type ThinCommandClient,
} from "./command-client.js";
import type {
  CredentialProfile,
  CredentialStore,
  PendingProfileStore,
} from "./storage.js";

const MAX_PENDING_COMMANDS = 32;
export const SIGNAL_PENDING_RECOVERY_MS = 60 * 60 * 1000;

function intentHash(
  workspace: string | undefined,
  command: ConnectCommand | CapabilityCommand,
): string {
  return createHash("sha256")
    .update(canonicalJson({ workspace_id: workspace ?? null, command }))
    .digest("hex");
}

async function pendingCommandId(
  credentials: CredentialStore,
  userId: string,
  workspace: string | undefined,
  command: ConnectCommand | CapabilityCommand,
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
    if (error instanceof ReauthenticationRequired) {
      // A fresh-login refusal is explicitly not ledgered. Preserve the intent
      // so the post-login retry proves that the same command id can be
      // evaluated afresh without risking a second destructive intent.
      throw error;
    }
    if (!(error instanceof CommandTransportError)) {
      await clearPendingCommand(session.store, session.userId, pending.intent);
      throw error;
    }
    throw new CommandTransportError(
      `${error.message}; retry the same command to resolve its pending outcome`,
    );
  }
}

/**
 * Same pending-id discipline as a connect command, so an interrupted mint resolves as a
 * replay rather than issuing a second live credential. A replay deliberately returns no
 * token — the caller reports that and mints afresh rather than pretending it has one.
 */
export async function sendCapabilityWithPending(
  client: ThinCommandClient,
  session: {
    accessToken: string;
    userId: string;
    store: CredentialStore;
  },
  workspace: string,
  command: CapabilityCommand,
): Promise<CapabilityCommandResult> {
  const pending = await pendingCommandId(
    session.store,
    session.userId,
    workspace,
    command,
  );
  try {
    const result = await client.sendCapability({
      workspaceId: workspace,
      command,
      credential: session.accessToken,
      commandId: pending.commandId,
    });
    await clearPendingCommand(session.store, session.userId, pending.intent);
    return result;
  } catch (error) {
    /* A 5xx IS AMBIGUOUS, AND TREATING IT AS FAILURE MINTS A SECOND LIVE CREDENTIAL.
     *
     * This used to clear the pending command_id on ANY non-transport error. The gateway
     * can answer 502/503/504 AFTER the mint transaction has already committed a
     * swarm.capability_urls row — so the link exists, the CLI reports "could not tell
     * whether the link was created… run the same command again", and the retry then
     * finds no pending id, generates a fresh one, misses the idempotency ledger, and
     * issues a SECOND live anonymous-read credential for the same work item. The
     * operator sees one link and two are live; the first was never printed, so in
     * practice it cannot be revoked, and it serves that work item for up to 7 days.
     *
     * sendSignalWithPending already had this right. The capability copy dropped the
     * status>=500 arm, which is the arm that makes the retry a REPLAY rather than a
     * second mint. Preserving the id is what lets the server recognise the retry. */
    const ambiguous = error instanceof CommandTransportError ||
      (error instanceof CommandHttpError && error.status >= 500);
    if (!ambiguous) {
      await clearPendingCommand(session.store, session.userId, pending.intent);
      throw error;
    }
    if (error instanceof CommandHttpError) {
      throw new CommandHttpError(
        error.status,
        `${error.message}; retry the same command to resolve its pending outcome`,
      );
    }
    throw new CommandTransportError(
      `${error.message}; retry the same command to resolve its pending outcome`,
    );
  }
}

function signalIntentHash(
  workspace: string,
  command: PostSignalCommand,
  credentialIdentity: string,
): string {
  return createHash("sha256")
    .update(canonicalJson({
      workspace_id: workspace,
      command,
      credential_identity: credentialIdentity,
    }))
    .digest("hex");
}

async function pendingSignalCommandId(
  credentials: PendingProfileStore,
  workspace: string,
  command: PostSignalCommand,
  credentialIdentity: string,
): Promise<{ intent: string; commandId: string }> {
  const intent = signalIntentHash(workspace, command, credentialIdentity);
  return await credentials.withLock(async () => {
    const profile = await credentials.readProfile();
    const now = Date.now();
    for (const [pendingIntent, record] of
      Object.entries(profile.pendingCommands)) {
      if (
        record.createdAt > now ||
        now - record.createdAt >= SIGNAL_PENDING_RECOVERY_MS
      ) {
        delete profile.pendingCommands[pendingIntent];
      }
    }
    const existing = profile.pendingCommands[intent];
    if (existing) {
      await credentials.writeProfile(profile);
      return { intent, commandId: existing.commandId };
    }
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
      createdAt: now,
    };
    await credentials.writeProfile(profile);
    return { intent, commandId };
  });
}

async function clearPendingSignal(
  credentials: PendingProfileStore,
  intent: string,
): Promise<void> {
  await credentials.withLock(async () => {
    const profile = await credentials.readProfile();
    if (!profile.pendingCommands[intent]) return;
    delete profile.pendingCommands[intent];
    await credentials.writeProfile(profile);
  });
}

export async function sendSignalWithPending(
  client: ThinCommandClient,
  session: {
    credential: string;
    credentialIdentity: string;
    store: PendingProfileStore;
  },
  workspace: string,
  command: PostSignalCommand,
): Promise<PostSignalResult> {
  const pending = await pendingSignalCommandId(
    session.store,
    workspace,
    command,
    session.credentialIdentity,
  );
  try {
    const result = await client.sendSignal({
      workspaceId: workspace,
      command,
      credential: session.credential,
      commandId: pending.commandId,
    });
    await clearPendingSignal(session.store, pending.intent);
    return result;
  } catch (error) {
    const ambiguous = error instanceof CommandTransportError ||
      (error instanceof CommandHttpError && error.status >= 500);
    if (!ambiguous) {
      await clearPendingSignal(session.store, pending.intent);
      throw error;
    }
    if (error instanceof CommandHttpError) {
      throw new CommandHttpError(
        error.status,
        `${error.message}; retry the same signal to resolve its pending outcome`,
      );
    }
    throw new CommandTransportError(
      `${error.message}; retry the same signal to resolve its pending outcome`,
    );
  }
}
