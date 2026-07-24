#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Command } from "./protocol/index.js";
import {
  login,
  logout,
  refreshedCredential,
  type RefreshedCredential,
} from "./cloud/auth.js";
import {
  assertAgentToken,
  assertInvitationToken,
  ThinCommandClient,
  type CommandResult,
  type ConnectCommandResult,
  type StreamRoute,
} from "./cloud/command-client.js";
import {
  CLIENT_PROTOCOL_VERSION,
  cloudTarget,
  type CloudTarget,
} from "./cloud/config.js";
import { seedDogfood } from "./cloud/seed.js";
import {
  credentialStore,
  type CredentialStore,
} from "./cloud/storage.js";
import { sendConnectWithPending } from "./cloud/pending-command.js";
import {
  acceptInviteLink,
  cloudAcceptOperations,
  originPin,
  type AcceptProgress,
  type AcceptSession,
  writeAcceptProgress,
} from "./cloud/accept-link.js";
import {
  cloudTarget as inviteCloudTarget,
} from "./cloud/config.js";
import {
  decodeInviteLink,
  encodeInviteLink,
  parseAcceptPositional,
  type InviteLinkPayload,
} from "./cloud/invite-link.js";

const BOOLEAN_FLAGS = new Set([
  "agent-token-stdin",
  "all-devices",
  "force-file-store",
  "help",
  "invitation-token-stdin",
  "json",
  "link-stdin",
  "no-browser",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function packageVersion(): string {
  try {
    const value = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    return typeof value.version === "string" ? value.version : "unknown";
  } catch {
    return "unknown";
  }
}

const CLI_BUILD_VERSION = packageVersion();

class Arguments {
  readonly positionals: string[] = [];
  private readonly flags = new Map<string, string[]>();

  constructor(values: string[]) {
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index]!;
      if (!value.startsWith("--")) {
        this.positionals.push(value);
        continue;
      }
      const name = value.slice(2);
      if (!name || name.includes("=")) {
        throw new Error(`invalid option: ${value}`);
      }
      if (BOOLEAN_FLAGS.has(name)) {
        this.push(name, "true");
        continue;
      }
      const next = values[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`--${name} requires a value`);
      }
      this.push(name, next);
      index += 1;
    }
  }

  private push(name: string, value: string): void {
    this.flags.set(name, [...(this.flags.get(name) ?? []), value]);
  }

  has(name: string): boolean {
    return this.flags.has(name);
  }

  optional(name: string): string | undefined {
    const values = this.flags.get(name);
    if (!values) return undefined;
    if (values.length !== 1) throw new Error(`--${name} may only be provided once`);
    return values[0];
  }

  required(name: string): string {
    const value = this.optional(name);
    if (value === undefined) throw new Error(`--${name} is required`);
    return value;
  }

  all(name: string): string[] {
    return [...(this.flags.get(name) ?? [])];
  }

  assertShape(
    allowedFlags: readonly string[],
    positionals: number,
  ): void {
    if (this.positionals.length !== positionals) {
      throw new Error("unexpected positional argument");
    }
    const allowed = new Set(allowedFlags);
    for (const name of this.flags.keys()) {
      if (!allowed.has(name)) throw new Error(`unknown option: --${name}`);
    }
  }
}

const TARGET_FLAGS = ["url", "anon-key", "force-file-store"] as const;
const ROUTE_FLAGS = ["workspace-id", "repo-mapping-id"] as const;
const CREDENTIAL_FLAGS = ["agent-token-stdin"] as const;
const TASK_FLAGS = [
  "task-id",
  "slug",
  "ttl-ms",
  "epoch",
  "to-owner",
  "grant-id",
  "branch",
  "head-sha",
  "evidence",
  "disposition",
] as const;

function usage(): string {
  return `coswarm ${CLI_BUILD_VERSION} (protocol ${CLIENT_PROTOCOL_VERSION})

Usage:
  coswarm login --url <project-url> --anon-key <key> [--no-browser]
  coswarm logout --url <project-url> --anon-key <key> [--all-devices]
  coswarm invite --url <url> --anon-key <key> [--workspace-id <uuid>] --email <email>
  coswarm accept --link-stdin [--name <name>] [--no-browser] [--json]
  coswarm accept <coswarm://accept/...> [--name <name>] [--no-browser] [--json]  # unsafe: shell history/process list
  coswarm accept --invitation-token-stdin --url <url> --anon-key <key>
  coswarm accept <invitation-token> --url <url> --anon-key <key>  # unsafe: shell history/process list
  coswarm principal create --url <url> --anon-key <key> [--workspace-id <uuid>] --name <name>
  coswarm token mint --url <url> --anon-key <key> [--workspace-id <uuid>] --principal-id <uuid> --run-id <uuid> --task-id <uuid> --epoch <n> [--ttl-ms <ms>]
  coswarm command <kind> --url <url> --anon-key <key> [--workspace-id <uuid>] [command fields]
  coswarm dogfood --url <url> --anon-key <key> [--workspace-id <uuid>] --slug <slug> --branch <branch> --head-sha <sha> --evidence <ref>
  coswarm seed-fixture --uid <auth-user-uuid> [--device-id <uuid>] [--workspace-id <uuid>]

Credential selection for command/dogfood:
  default                 refresh the human login from secure storage
  --agent-token-stdin     read one seeded swm_agt_ credential from stdin

Invite, legacy token accept, principal create, and token mint require a stored
human login. Invite-link accept signs in when needed, then accepts and registers
one principal. Invitation links and agent credentials appear only in fresh
success responses.
GitHub identities with the same verified email may resolve to one GoTrue user;
a second human must log in with a distinct verified email before accepting.

Target/workspace flags may also be set with SWARM_CLOUD_URL,
SWARM_CLOUD_ANON_KEY, and SWARM_CLOUD_WORKSPACE_ID. A sole accepted workspace
is saved in the local profile and used when --workspace-id is omitted. An invite
link supplies its whole target and cannot be combined with --url or --anon-key.
For an unrecognized origin, --link-stdin and --json hard-fail without a prompt;
use a positional link without --json when an interactive confirmation is needed.
The fixture bridge is test-only. It reads its privileged database connection only
from DATABASE_URL and writes a newly minted agent token only to the absolute
create-new path in SEED_TOKEN_OUT. --workspace-id selects an explicit fixture
workspace only for callers who already hold that full-database credential; it
grants no new authority and is not a governed product workspace-creation path.`;
}

function target(args: Arguments): CloudTarget {
  return cloudTarget(
    args.optional("url") ?? process.env.SWARM_CLOUD_URL ?? "",
    args.optional("anon-key") ?? process.env.SWARM_CLOUD_ANON_KEY ?? "",
  );
}

async function store(
  args: Arguments,
  cloud: CloudTarget,
): Promise<CredentialStore> {
  return await credentialStore({
    target: cloud,
    forceFile: args.has("force-file-store"),
  });
}

function integer(
  args: Arguments,
  name: string,
  options: { minimum?: number; maximum?: number } = {},
): number {
  const value = Number(args.required(name));
  const minimum = options.minimum ?? 0;
  const maximum = options.maximum ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function nullableUuid(args: Arguments, name: string): string | null {
  return args.optional(name) ?? null;
}

function stream(args: Arguments): StreamRoute {
  const repository = args.optional("repo-mapping-id");
  return repository
    ? { kind: "repo", repo_mapping_id: repository }
    : { kind: "workspace" };
}

async function stdinCredential(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error(
      "--agent-token-stdin requires a piped secret; it is never accepted as a command-line argument",
    );
  }
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk.toString();
    if (value.length > 256) throw new Error("agent credential input is too large");
  }
  const credential = value.trim();
  assertAgentToken(credential);
  return credential;
}

async function invitationCredential(args: Arguments): Promise<string> {
  if (args.has("invitation-token-stdin")) {
    args.assertShape([...TARGET_FLAGS, "invitation-token-stdin"], 1);
    if (process.stdin.isTTY) {
      throw new Error(
        "--invitation-token-stdin requires the capability to be piped on stdin",
      );
    }
    let value = "";
    for await (const chunk of process.stdin) {
      value += chunk.toString();
      if (value.length > 256) {
        throw new Error("invitation capability input is too large");
      }
    }
    const capability = value.trim();
    assertInvitationToken(capability);
    return capability;
  }
  args.assertShape([...TARGET_FLAGS], 2);
  process.stderr.write(
    "Warning: positional invitation capabilities may be recorded in shell history and process listings; prefer --invitation-token-stdin.\n",
  );
  const capability = args.positionals[1]!;
  assertInvitationToken(capability);
  return capability;
}

async function stdinInviteLink(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error("--link-stdin requires an invite link to be piped on stdin");
  }
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk.toString();
    if (value.length > 16_384) throw new Error("invite link input is too large");
  }
  const link = value.trim();
  if (!link) throw new Error("--link-stdin received an empty invite link");
  return link;
}

async function confirmationLine(prompt: string): Promise<string> {
  const reader = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: Boolean(process.stdin.isTTY),
  });
  try {
    return await reader.question(prompt);
  } finally {
    reader.close();
  }
}

async function credential(
  args: Arguments,
  cloud: CloudTarget,
): Promise<string> {
  if (args.has("agent-token-stdin")) return await stdinCredential();
  const credentials = await store(args, cloud);
  return (await refreshedCredential(cloud, credentials)).accessToken;
}

interface HumanSession extends RefreshedCredential {
  store: CredentialStore;
}

async function humanCredential(
  args: Arguments,
  cloud: CloudTarget,
): Promise<HumanSession> {
  const credentials = await store(args, cloud);
  return {
    ...await refreshedCredential(cloud, credentials),
    store: credentials,
  };
}

function checkedUuid(value: string, source: string): string {
  if (!UUID_RE.test(value)) throw new Error(`${source} must be a UUID`);
  return value;
}

async function workspaceId(
  args: Arguments,
  cloud: CloudTarget,
  credentials?: CredentialStore,
): Promise<string> {
  const explicit = args.optional("workspace-id");
  if (explicit !== undefined) return checkedUuid(explicit, "--workspace-id");
  const environmental = process.env.SWARM_CLOUD_WORKSPACE_ID;
  if (environmental) {
    return checkedUuid(environmental, "SWARM_CLOUD_WORKSPACE_ID");
  }
  const profileStore = credentials ?? await store(args, cloud);
  const profile = await profileStore.withLock(() => profileStore.readProfile());
  if (profile.workspaceId === null) {
    throw new Error(
      "--workspace-id is required because this profile has no default; set SWARM_CLOUD_WORKSPACE_ID or accept an invitation first",
    );
  }
  return profile.workspaceId;
}

async function writeWorkspaceDefault(
  credentials: CredentialStore,
  userId: string,
  value: string,
): Promise<void> {
  await credentials.withLock(async () => {
    const profile = await credentials.readProfile();
    const sameUser = profile.userId === userId;
    const sameWorkspace = sameUser && profile.workspaceId === value;
    await credentials.writeProfile({
      ...(sameUser
        ? profile
        : {
          version: 1 as const,
          userId,
          workspaceId: null,
          email: null,
          principalId: null,
          principalName: null,
          pendingCommands: {},
        }),
      userId,
      workspaceId: value,
      principalId: sameWorkspace ? profile.principalId ?? null : null,
      principalName: sameWorkspace ? profile.principalName ?? null : null,
    });
  });
}

function uuid(value: string | undefined, field: string): string {
  if (
    value === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
  ) {
    throw new Error(`server returned a malformed ${field}`);
  }
  return value;
}

function acceptedConnect(
  label: string,
  result: ConnectCommandResult,
): ConnectCommandResult["response"] {
  if (result.response.status !== "accepted") {
    throw new Error(
      `${label} was rejected: ${result.response.reason ?? "domain rejection"}`,
    );
  }
  return result.response;
}

function printJson(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runInvite(args: Arguments): Promise<void> {
  args.assertShape([...TARGET_FLAGS, "workspace-id", "email"], 1);
  const cloud = target(args);
  const human = await humanCredential(args, cloud);
  const workspace = await workspaceId(args, cloud, human.store);
  const response = acceptedConnect(
    "invite",
    await sendConnectWithPending(
      new ThinCommandClient(cloud),
      human,
      workspace,
      { kind: "invite_member", email: args.required("email") },
    ),
  );
  if (response.invitation_token === undefined) {
    throw new Error(
      "the invitation was accepted on a prior attempt, but its secret is fresh-response-only; run invite again to issue a new capability",
    );
  }
  assertInvitationToken(response.invitation_token);
  const responseWorkspaceId = uuid(response.workspace_id, "workspace_id");
  if (
    typeof response.workspace_name !== "string" ||
    typeof response.inviter_display_name !== "string"
  ) {
    throw new Error(
      "the invitation was created without its fresh display labels; run invite again to issue a complete link",
    );
  }
  const payload: InviteLinkPayload = {
    v: 1,
    url: cloud.url,
    anon_key: cloud.anonKey,
    workspace_id: responseWorkspaceId,
    invitation_token: response.invitation_token,
    workspace_name: response.workspace_name,
    inviter_display_name: response.inviter_display_name,
    ...(typeof response.inviter_user_id === "string"
      ? { inviter_user_id: response.inviter_user_id }
      : {}),
  };
  const inviteLink = encodeInviteLink(payload);
  printJson({
    message:
      "Invitation created. Share the one-time link below with its intended recipient. It can be accepted once before it expires; use a GitHub account with a distinct verified email for a second person.",
    status: response.status,
    invitation_id: uuid(response.invitation_id, "invitation_id"),
    invite_link: inviteLink,
  });
}

async function runLegacyAccept(args: Arguments): Promise<void> {
  const invitationToken = await invitationCredential(args);
  const cloud = target(args);
  const human = await humanCredential(args, cloud);
  const response = acceptedConnect(
    "accept",
    await sendConnectWithPending(
      new ThinCommandClient(cloud),
      human,
      undefined,
      { kind: "accept_invitation", token: invitationToken },
    ),
  );
  const acceptedWorkspace = uuid(response.workspace_id, "workspace_id");
  await writeWorkspaceDefault(human.store, human.userId, acceptedWorkspace);
  printJson({
    message:
      "Invitation accepted. Coswarm saved the workspace as your default so later commands need fewer flags.",
    status: response.status,
    workspace_id: acceptedWorkspace,
  });
}

function progressWriter(json: boolean): (progress: AcceptProgress) => void {
  return (progress) =>
    writeAcceptProgress(progress, {
      json,
      stdout: process.stdout,
      stderr: process.stderr,
    });
}

async function runLinkAccept(
  args: Arguments,
  payload: InviteLinkPayload,
): Promise<void> {
  if (args.has("url") || args.has("anon-key")) {
    throw new Error(
      "an invite link supplies its complete Cloud target; do not combine it with --url or --anon-key",
    );
  }
  const cloud = inviteCloudTarget(payload.url, payload.anon_key);
  const credentials = await store(args, cloud);
  const json = args.has("json");
  const operations = cloudAcceptOperations(cloud, credentials);
  const emit = progressWriter(json);
  const runtime = {
    ...operations,
    pinOrigin: originPin({
      interactive: Boolean(
        process.stdin.isTTY && !json && !args.has("link-stdin"),
      ),
      output: process.stderr,
      readConfirmation: process.stdin.isTTY
        ? async () => await confirmationLine("")
        : undefined,
      devAllowedOrigins: process.env.COSWARM_DEV_ALLOWED_ORIGINS,
    }),
    async currentSession(
      selected: CloudTarget,
      selectedStore: CredentialStore,
    ): Promise<AcceptSession | null> {
      try {
        const refreshed = await refreshedCredential(selected, selectedStore);
        const profile = await selectedStore.readProfile();
        return {
          ...refreshed,
          email: profile.userId === refreshed.userId
            ? profile.email ?? null
            : null,
        };
      } catch {
        return null;
      }
    },
    async loginSession(
      selected: CloudTarget,
      selectedStore: CredentialStore,
    ): Promise<AcceptSession> {
      const result = await login({
        target: selected,
        store: selectedStore,
        openBrowser: args.has("no-browser") ? async () => false : undefined,
        input: args.has("no-browser") ? process.stdin : undefined,
        output: process.stderr,
      });
      const refreshed = await refreshedCredential(selected, selectedStore);
      return { ...refreshed, email: result.email };
    },
    emit,
  };
  const result = await acceptInviteLink({
    payload,
    target: cloud,
    store: credentials,
    runtime,
    ...(args.optional("name") === undefined
      ? {}
      : { explicitName: args.required("name") }),
  });
  if (json) {
    process.stdout.write(`${JSON.stringify({
      type: "result",
      status: "connected",
      workspace_id: result.workspaceId,
      principal_id: result.principalId,
      principal_name: result.principalName,
      accepted_fresh: result.acceptedFresh,
      checkpoint_short_circuit: result.checkpointShortCircuit,
    })}\n`);
  }
}

async function runAccept(args: Arguments): Promise<void> {
  if (args.has("link-stdin")) {
    args.assertShape(
      [...TARGET_FLAGS, "link-stdin", "no-browser", "json", "name"],
      1,
    );
    const payload = decodeInviteLink(await stdinInviteLink());
    await runLinkAccept(args, payload);
    return;
  }
  if (args.has("invitation-token-stdin")) {
    await runLegacyAccept(args);
    return;
  }
  if (args.positionals.length !== 2) {
    throw new Error(
      "accept expects one swm_inv_ capability or coswarm://accept/<invite-link>",
    );
  }
  const parsed = parseAcceptPositional(args.positionals[1]!);
  if (parsed.mode === "token") {
    await runLegacyAccept(args);
    return;
  }
  args.assertShape(
    [...TARGET_FLAGS, "no-browser", "json", "name"],
    2,
  );
  process.stderr.write(
    "Warning: positional invite links may be recorded in shell history and process listings; prefer --link-stdin.\n",
  );
  await runLinkAccept(args, parsed.payload);
}

async function runPrincipal(args: Arguments): Promise<void> {
  args.assertShape([...TARGET_FLAGS, "workspace-id", "name"], 2);
  if (args.positionals[1] !== "create") {
    throw new Error(`unknown principal command: ${args.positionals[1]}`);
  }
  const cloud = target(args);
  const human = await humanCredential(args, cloud);
  const workspace = await workspaceId(args, cloud, human.store);
  const response = acceptedConnect(
    "principal create",
    await sendConnectWithPending(
      new ThinCommandClient(cloud),
      human,
      workspace,
      {
        kind: "create_agent_principal",
        name: args.required("name"),
      },
    ),
  );
  printJson({
    message:
      "Agent identity created. It makes this machine's agent auditable inside the shared workspace.",
    status: response.status,
    principal_id: uuid(response.principal_id, "principal_id"),
  });
}

async function runToken(args: Arguments): Promise<void> {
  args.assertShape(
    [
      ...TARGET_FLAGS,
      "workspace-id",
      "principal-id",
      "run-id",
      "task-id",
      "epoch",
      "ttl-ms",
    ],
    2,
  );
  if (args.positionals[1] !== "mint") {
    throw new Error(`unknown token command: ${args.positionals[1]}`);
  }
  const cloud = target(args);
  const human = await humanCredential(args, cloud);
  const workspace = await workspaceId(args, cloud, human.store);
  const ttl = args.optional("ttl-ms");
  const response = acceptedConnect(
    "token mint",
    await sendConnectWithPending(
      new ThinCommandClient(cloud),
      human,
      workspace,
      {
        kind: "mint_agent_token",
        principal_id: args.required("principal-id"),
        run_id: args.required("run-id"),
        task_id: args.required("task-id"),
        epoch: integer(args, "epoch"),
        device_id: human.deviceId,
        ...(ttl === undefined
          ? {}
          : {
            ttl_ms: integer(args, "ttl-ms", {
              minimum: 1,
              maximum: 28_800_000,
            }),
          }),
      },
    ),
  );
  if (response.agent_token === undefined) {
    throw new Error(
      "the token mint was accepted on a prior attempt, but its secret is fresh-response-only; run token mint again to issue a new credential",
    );
  }
  assertAgentToken(response.agent_token);
  printJson({
    message:
      "Agent credential minted. It is bound to this task and run so the agent's work stays scoped and attributable.",
    status: response.status,
    token_id: uuid(response.token_id, "token_id"),
    run_id: uuid(response.run_id, "run_id"),
    agent_token: response.agent_token,
  });
}

function command(args: Arguments, kind: string): Command {
  const taskId = args.required("task-id");
  switch (kind) {
    case "create":
      return { kind, task_id: taskId, slug: args.required("slug") };
    case "acquire":
      return {
        kind,
        task_id: taskId,
        ttl_ms: integer(args, "ttl-ms", { minimum: 1, maximum: 14_400_000 }),
      };
    case "renew":
      return {
        kind,
        task_id: taskId,
        epoch: integer(args, "epoch"),
        ttl_ms: integer(args, "ttl-ms", { minimum: 1, maximum: 14_400_000 }),
      };
    case "handoff":
      return {
        kind,
        task_id: taskId,
        epoch: integer(args, "epoch"),
        to_owner: args.required("to-owner"),
        ttl_ms: integer(args, "ttl-ms", { minimum: 1, maximum: 14_400_000 }),
      };
    case "takeover":
      return {
        kind,
        task_id: taskId,
        grant_id: nullableUuid(args, "grant-id"),
        ttl_ms: integer(args, "ttl-ms", { minimum: 1, maximum: 14_400_000 }),
      };
    case "submit": {
      const evidence = args.all("evidence");
      if (evidence.length === 0) throw new Error("--evidence is required");
      return {
        kind,
        task_id: taskId,
        epoch: integer(args, "epoch"),
        branch: args.required("branch"),
        head_sha: args.required("head-sha"),
        evidence_set: evidence,
      };
    }
    case "close": {
      const disposition = args.required("disposition");
      if (!["merged", "pr", "archive", "discard"].includes(disposition)) {
        throw new Error("--disposition must be merged, pr, archive, or discard");
      }
      return {
        kind,
        task_id: taskId,
        epoch: integer(args, "epoch"),
        disposition: disposition as "merged" | "pr" | "archive" | "discard",
        grant_id: nullableUuid(args, "grant-id"),
      };
    }
    case "reopen":
      return { kind, task_id: taskId, epoch: integer(args, "epoch") };
    default:
      throw new Error(`unknown task command: ${kind}`);
  }
}

function printable(result: CommandResult): Record<string, unknown> {
  return {
    message: result.response.status === "accepted"
      ? "Command accepted. The workspace recorded the change so collaborators and agents share the same authoritative state."
      : `Command rejected because ${
        result.response.reason ?? "a required condition was not met"
      }. No accepted state change was recorded.`,
    status: result.response.status,
    ok: result.response.ok,
    event_ids: result.response.event_ids,
    ...(result.response.class ? { class: result.response.class } : {}),
    ...(result.response.reason ? { reason: result.response.reason } : {}),
    ...(result.response.detail ? { detail: result.response.detail } : {}),
    ...(result.response.events ? { events: result.response.events } : {}),
    ...(result.projection ? { projection: result.projection } : {}),
  };
}

function printResult(label: string, result: CommandResult): void {
  process.stdout.write(`${label}: ${JSON.stringify(printable(result), null, 2)}\n`);
}

function accepted(label: string, result: CommandResult): void {
  printResult(label, result);
  if (result.response.status !== "accepted") {
    throw new Error(
      `${label} was rejected: ${result.response.reason ?? "domain rejection"}`,
    );
  }
}

async function runTaskCommand(args: Arguments): Promise<void> {
  args.assertShape(
    [...TARGET_FLAGS, ...ROUTE_FLAGS, ...CREDENTIAL_FLAGS, ...TASK_FLAGS],
    2,
  );
  const kind = args.positionals[1];
  if (!kind) throw new Error("command kind is required");
  const cloud = target(args);
  const selectedWorkspace = await workspaceId(args, cloud);
  const bearer = await credential(args, cloud);
  const client = new ThinCommandClient(cloud);
  const result = await client.send({
    workspaceId: selectedWorkspace,
    stream: stream(args),
    command: command(args, kind),
    credential: bearer,
  });
  printResult(kind, result);
}

async function runDogfood(args: Arguments): Promise<void> {
  args.assertShape(
    [
      ...TARGET_FLAGS,
      ...ROUTE_FLAGS,
      ...CREDENTIAL_FLAGS,
      "task-id",
      "slug",
      "ttl-ms",
      "branch",
      "head-sha",
      "evidence",
    ],
    1,
  );
  const cloud = target(args);
  const selectedWorkspace = await workspaceId(args, cloud);
  const bearer = await credential(args, cloud);
  const client = new ThinCommandClient(cloud);
  const route = stream(args);
  const taskId = args.optional("task-id") ?? randomUUID();
  const ttl = Number(args.optional("ttl-ms") ?? "3600000");
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 14_400_000) {
    throw new Error("--ttl-ms must be an integer in 1..14400000");
  }
  const evidence = args.all("evidence");
  if (evidence.length === 0) throw new Error("--evidence is required");
  const common = {
    workspaceId: selectedWorkspace,
    stream: route,
    credential: bearer,
  };
  accepted("create", await client.send({
    ...common,
    command: {
      kind: "create",
      task_id: taskId,
      slug: args.required("slug"),
    },
  }));
  accepted("acquire", await client.send({
    ...common,
    command: { kind: "acquire", task_id: taskId, ttl_ms: ttl },
  }));
  accepted("submit", await client.send({
    ...common,
    command: {
      kind: "submit",
      task_id: taskId,
      epoch: 1,
      branch: args.required("branch"),
      head_sha: args.required("head-sha"),
      evidence_set: evidence,
    },
  }));
  accepted("close", await client.send({
    ...common,
    command: {
      kind: "close",
      task_id: taskId,
      epoch: 1,
      disposition: "archive",
      grant_id: null,
    },
  }));
}

async function runSeed(args: Arguments): Promise<void> {
  args.assertShape(
    [
      "uid",
      "device-id",
      "workspace-id",
      "display-name",
      "workspace-name",
      "agent-name",
    ],
    1,
  );
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the fixture bridge");
  }
  const tokenOut = process.env.SEED_TOKEN_OUT;
  if (!tokenOut || !isAbsolute(tokenOut)) {
    throw new Error("SEED_TOKEN_OUT must be an absolute path");
  }

  const tokenFile = await open(tokenOut, "wx", 0o600).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("SEED_TOKEN_OUT already exists; refusing to overwrite it");
    }
    throw error;
  });
  let tokenWritten = false;
  try {
    await tokenFile.chmod(0o600);
    const fileInfo = await tokenFile.stat();
    if (!fileInfo.isFile() || (fileInfo.mode & 0o777) !== 0o600) {
      throw new Error("SEED_TOKEN_OUT could not be secured to mode 0600");
    }
    if (
      typeof process.getuid === "function" &&
      fileInfo.uid !== process.getuid()
    ) {
      throw new Error("SEED_TOKEN_OUT is not owned by the current user");
    }

    const result = await seedDogfood({
      databaseUrl,
      userId: args.required("uid"),
      deviceId: args.optional("device-id"),
      workspaceId: args.optional("workspace-id"),
      displayName: args.optional("display-name"),
      workspaceName: args.optional("workspace-name"),
      agentName: args.optional("agent-name"),
    });
    if (result.agentToken) {
      await tokenFile.writeFile(result.agentToken, "utf8");
      await tokenFile.sync();
      tokenWritten = true;
    }
    await tokenFile.close();
    if (!tokenWritten) await unlink(tokenOut);

    process.stdout.write(`${JSON.stringify({
      userId: result.userId,
      membershipRole: result.membershipRole,
      workspaceId: result.workspaceId,
      workspaceName: result.workspaceName,
      streamId: result.streamId,
      principalId: result.principalId,
      tokenWritten,
    }, null, 2)}\n`);
  } catch (error) {
    await tokenFile.close().catch(() => undefined);
    if (!tokenWritten) await unlink(tokenOut).catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  const args = new Arguments(process.argv.slice(2));
  const verb = args.positionals[0];
  if (!verb || verb === "help" || args.has("help")) {
    if (verb === "help") args.assertShape([], 1);
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (verb === "login") {
    args.assertShape([...TARGET_FLAGS, "no-browser"], 1);
    const cloud = target(args);
    const credentials = await store(args, cloud);
    process.stderr.write(
      "Swarm stores the rotating refresh credential in the OS keychain when available; the access token remains in memory only.\n",
    );
    const result = await login({
      target: cloud,
      store: credentials,
      openBrowser: args.has("no-browser") ? async () => false : undefined,
    });
    process.stdout.write(
      `Login complete for ${result.userId}. This device (${result.deviceId}) is registered so its agent credentials can be governed independently; refresh credential: ${result.storage}; ${
        result.workspaceId
          ? `workspace ${result.workspaceId} is now the default`
          : "no workspace is selected yet—accept an invitation to choose one"
      }.\n`,
    );
    return;
  }
  if (verb === "logout") {
    args.assertShape([...TARGET_FLAGS, "device", "all-devices"], 1);
    if (args.optional("device") !== undefined) {
      throw new Error(
        "--device is deferred until the server-side device authority endpoint ships",
      );
    }
    const cloud = target(args);
    const credentials = await store(args, cloud);
    const allDevices = args.has("all-devices");
    const removed = await logout(
      cloud,
      credentials,
      allDevices ? "global" : "local",
    );
    process.stdout.write(
      removed
        ? allDevices
          ? "Logged out on all devices. Every refresh session for this identity was revoked for account-wide containment.\n"
          : "Logged out on this device. Other machines stay signed in so collaborators are not disrupted.\n"
        : "Already logged out.\n",
    );
    return;
  }
  if (verb === "invite") {
    await runInvite(args);
    return;
  }
  if (verb === "accept") {
    await runAccept(args);
    return;
  }
  if (verb === "principal") {
    await runPrincipal(args);
    return;
  }
  if (verb === "token") {
    await runToken(args);
    return;
  }
  if (verb === "command") {
    await runTaskCommand(args);
    return;
  }
  if (verb === "dogfood") {
    await runDogfood(args);
    return;
  }
  if (verb === "seed-fixture") {
    await runSeed(args);
    return;
  }
  throw new Error(`unknown command: ${verb}\n${usage()}`);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown error";
  return message
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .slice(0, 1000);
}

main().catch((error) => {
  process.stderr.write(`coswarm: ${safeError(error)}\n`);
  process.exitCode = 1;
});
