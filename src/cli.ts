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
  assertCapabilityToken,
  assertHumanCapabilityCredential,
  assertInvitationToken,
  assertWorkspaceName,
  CAPABILITY_MAX_TTL_MS,
  CAPABILITY_MIN_TTL_MS,
  CommandTransportError,
  ThinCommandClient,
  type CommandResult,
  type ConnectCommandResult,
  type PostSignalCommand,
  type PostSignalResult,
  type SignalKind,
  type StreamRoute,
} from "./cloud/command-client.js";
import {
  CLIENT_PROTOCOL_VERSION,
  cloudTarget,
  type CloudTarget,
} from "./cloud/config.js";
import {
  clearCurrentTarget,
  currentTargetSummary,
  readCurrentTarget,
  resolveCloudTarget,
  writeCurrentTarget,
} from "./cloud/current-target.js";
import { seedDogfood } from "./cloud/seed.js";
import {
  agentCredentialStore,
  credentialLineageKey,
} from "./cloud/agent-credential.js";
import {
  AgentCredentialSession,
  RENEWAL_HORIZON_DEFAULT_MS,
  RENEWAL_HORIZON_MAX_MS,
  RENEWAL_MAX_SUCCESSORS_DEFAULT,
  RenewalReauthorisationRequired,
  RenewalRevoked,
} from "./cloud/renewal.js";
import {
  agentSignalPendingStore,
  credentialStore,
  type CredentialStore,
} from "./cloud/storage.js";
import {
  sendCapabilityWithPending,
  sendConnectWithPending,
  sendSignalWithPending,
} from "./cloud/pending-command.js";
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
  sanitizeDisplayLabel,
  type InviteLinkPayload,
} from "./cloud/invite-link.js";
import {
  capabilitySiteOrigin,
  capabilityTimestamp,
  capabilityUrl,
  CAPABILITY_DISCLOSURE,
  renderCapabilityMint,
  renderCapabilityRevoke,
} from "./cloud/capability-link.js";
import {
  clearWorkspaceDefault,
  archiveKnownGaps,
  cloudWorkspaceDirectory,
  DEFAULT_MEMBERSHIP_REVOKED,
  renderStatus,
  renderWorkspaces,
  resolveWorkspace,
  selectWorkspace,
  WorkspaceCliError,
  WorkspaceUnavailableError,
  resolveWorkspaceMember,
  workspaceOverride,
  writeWorkspaceDefault,
  type WorkspaceDirectory,
  type WorkspaceStatus,
  type WorkspaceSummary,
  type WorkspaceWarning,
} from "./cloud/workspaces.js";
import {
  askWaitJsonPayload,
  formatFollowFrame,
  parseWaitSeconds,
  pollForSignals,
  postSignalTargets,
  readAgentSignalDirectory,
  readSignals,
  renderSignalStatus,
  renderSignals,
  resolveSignalRecipient,
  runInboxFollow,
  settleSignalAuthorLabels,
  settleSignalStatus,
  signalReadJsonPayload,
  waitDeadlineMs,
  type SignalAuthorLabels,
  type SignalCredential,
  type SignalDirectory,
  type ResolvedSignalRecipient,
} from "./cloud/signals.js";

const BOOLEAN_FLAGS = new Set([
  "agent-token-stdin",
  "all-devices",
  "force-file-store",
  "follow",
  "help",
  "include-stale",
  "invitation-token-stdin",
  "json",
  "link-stdin",
  "ndjson",
  "no-browser",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGENT_CREDENTIAL_MESSAGE =
  "Agent credential minted. It is bound to this task and run so the agent's work stays scoped and attributable.";

// Injected by scripts/build-release.sh via esbuild --define. Absent in dev/test builds,
// where the package.json read below is correct. A bundled release has no package.json
// beside it, so without this a release binary reports "unknown" and support cannot ask
// "what version are you on?".
declare const __COSWARM_VERSION__: string;

function packageVersion(): string {
  if (typeof __COSWARM_VERSION__ === "string" && __COSWARM_VERSION__.length > 0) {
    return __COSWARM_VERSION__;
  }
  try {
    const value = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    // usage() is written to the terminal without going through safeError(), so
    // everything interpolated into it must be safe at its source. A version is
    // a short printable token; anything else is reported as unknown rather
    // than passed through.
    const version = value.version;
    if (typeof version !== "string") return "unknown";
    return /^[\x20-\x7e]{1,64}$/.test(version) ? version : "unknown";
  } catch {
    return "unknown";
  }
}

const CLI_BUILD_VERSION = packageVersion();

class Arguments {
  readonly positionals: string[] = [];
  private readonly flags = new Map<string, string[]>();

  constructor(values: string[]) {
    let positionalOnly = false;
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index]!;
      if (positionalOnly || !value.startsWith("--")) {
        this.positionals.push(value);
        continue;
      }
      if (value === "--") {
        positionalOnly = true;
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
    if (this.positionals.length < positionals) {
      throw new Error(
        `too few positional arguments: expected ${positionals}, received ${this.positionals.length}`,
      );
    }
    if (this.positionals.length > positionals) {
      throw new Error(
        `too many positional arguments: expected ${positionals}, received ${this.positionals.length}`,
      );
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

/**
 * An error whose remedy is the usage block. The message is still sanitized —
 * it quotes what the user typed — but the usage block is our own constant and
 * is written verbatim, because safeError() maps the C0 range (newline
 * included) to spaces and would flatten it to one truncated line.
 */
class UsageError extends Error {}

function usage(): string {
  return `cswarm ${CLI_BUILD_VERSION} (protocol ${CLIENT_PROTOCOL_VERSION})

Usage:
  cswarm login [--url <project-url> --anon-key <key>] [--no-browser]
  cswarm logout [--url <project-url> --anon-key <key>] [--all-devices]
  cswarm target [show] [--json]
  cswarm target set --url <project-url> --anon-key <key> [--json]
  cswarm target clear [--json]
  cswarm status [--url <url> --anon-key <key>] [--workspace-id <uuid>] [--json]
  cswarm working-on "<what>" [--url <url> --anon-key <key>] [--workspace-id <uuid>] [--about <ref>] [--until <dur>] [--json]
  cswarm note "<text>" [--url <url> --anon-key <key>] [--workspace-id <uuid>] [--to <member|agent>] [--about <ref>] [--until <dur>] [--json]
  cswarm ask "<text>" [--url <url> --anon-key <key>] [--workspace-id <uuid>] [--to <member|agent>] [--about <ref>] [--until <dur>] [--wait <seconds>] [--json]
  cswarm reply <signal-id> "<text>" [--url <url> --anon-key <key>] [--workspace-id <uuid>] [--until <dur>] [--json]
  cswarm feed [--url <url> --anon-key <key>] [--workspace-id <uuid>] [--about <ref>] [--kind <kind>] [--since <timestamp>] [--limit <n>] [--include-stale] [--json]
  cswarm inbox [--url <url> --anon-key <key>] [--workspace-id <uuid>] [--kind <kind>] [--about <ref>] [--since <timestamp>] [--limit <n>] [--include-stale] [--wait <seconds>] [--json]
  cswarm inbox --follow --ndjson [--url <url> --anon-key <key>] [--workspace-id <uuid>] [--kind <kind>] [--about <ref>] [--since <timestamp>] [--limit <n>] [--include-stale]
  cswarm new "<project name>" [--url <url> --anon-key <key>] [--json]
  cswarm new --name "<project name>" [--url <url> --anon-key <key>] [--json]
  cswarm workspaces [--url <url> --anon-key <key>] [--json]
  cswarm use <full-id|exact-name> [--url <url> --anon-key <key>] [--json]
  cswarm invite [--url <url> --anon-key <key>] [--workspace-id <uuid>] --email <email>
  cswarm member remove <full-user-id|exact-name> --confirm <same-selector> [--url <url> --anon-key <key>] [--workspace-id <uuid>] [--json]
  cswarm accept --link-stdin [--name <name>] [--no-browser] [--json]
  cswarm accept <cswarm://accept/...> [--name <name>] [--no-browser] [--json]  # unsafe: shell history/process list
  cswarm accept --invitation-token-stdin [--url <url> --anon-key <key>]
  cswarm accept <invitation-token> [--url <url> --anon-key <key>]  # unsafe: shell history/process list
  cswarm principal create [--url <url> --anon-key <key>] [--workspace-id <uuid>] --name <name>
  cswarm principal revoke [--url <url> --anon-key <key>] [--workspace-id <uuid>] --principal-id <uuid>
  cswarm token mint [--url <url> --anon-key <key>] [--workspace-id <uuid>] --principal-id <uuid> --run-id <uuid> --task-id <uuid> --epoch <n> [--ttl-ms <ms>]
  cswarm token revoke [--url <url> --anon-key <key>] [--workspace-id <uuid>] --token-id <uuid>
  cswarm token revoke --agent-token-stdin [--url <url> --anon-key <key>] --workspace-id <uuid> [--token-id <uuid>]
  cswarm link new [--url <url> --anon-key <key>] [--workspace-id <uuid>] --task-id <uuid> [--ttl-ms <ms>] [--site <origin>] [--json]
  cswarm link revoke [--url <url> --anon-key <key>] [--workspace-id <uuid>] --capability-id <uuid> [--json]
  cswarm command <kind> [--url <url> --anon-key <key>] [--workspace-id <uuid>] [command fields]
  cswarm dogfood [--url <url> --anon-key <key>] [--workspace-id <uuid>] --slug <slug> --branch <branch> --head-sha <sha> --evidence <ref>
  cswarm seed-fixture --uid <auth-user-uuid> [--device-id <uuid>] [--workspace-id <uuid>]

Credential selection for command/dogfood:
  default                 refresh the human login from secure storage
  --agent-token-stdin     read a mint/seed credential artifact (or legacy swm_agt_) from stdin

Signals (intention sharing) accept the same credential selection. Agent mode
never opens a browser or infers a human's saved project. Durations use a whole
number plus m, h, or d (for example 90m, 24h, or 7d) and are capped at 30d.
Place -- before signal text that itself begins with -- to stop option parsing.

Invite, legacy token accept, principal create/revoke, human token mint/revoke, link, and new require a
stored human login. Agent self-surrender of a token uses --agent-token-stdin and never takes the secret on argv. Invite-link accept signs in when needed, then accepts and
registers one principal. Invitation links, agent credentials, and capability links
appear only in fresh success responses.

cswarm link new hands someone a browser link to ONE work item before they install
anything. It shows that item's name and state, the repository it belongs to, who
invited them, and how long the project has existed — and reaches nothing else, not
the member list, not the message feed, not another work item. The link is printed
once and never again, because only its hash is stored; it lasts a day by default
and at most 7 days, and cswarm link revoke --capability-id <uuid> withdraws it
sooner. Only an owner or admin signed in as a human can create or revoke one; an
agent credential never can, and cswarm says so without contacting the server. The
token rides in the link's # fragment, which browsers never send to any server.
--site (or CSWARM_SITE_ORIGIN) chooses which CommonSwarm page the link points at
and accepts only https://coswarm-site.vercel.app (the default),
https://commonswarm.com, https://www.commonswarm.com, or a loopback host while
that page is being developed — the link is a live credential, so it may not be
aimed at anyone else's server.
GitHub identities with the same verified email may resolve to one GoTrue user;
a second human must log in with a distinct verified email before accepting.

Successful login and invite acceptance save the current Cloud target. Override it
per command with --url/--anon-key or SWARM_CLOUD_URL/SWARM_CLOUD_ANON_KEY;
flags take precedence over environment, which takes precedence over the saved target.
Agent credentials never inherit a human's saved target. Workspace flags may also
be set with SWARM_CLOUD_WORKSPACE_ID. cswarm new starts a project of your own
(a name of 1 to 80 characters) and selects it; whether a deployment accepts that
is a setting on the deployment, and an invite link is the other way in.
Normal project selection is:
cswarm workspaces, then cswarm use <full-id|exact-name>. A sole accepted
project is saved automatically; ambiguous names require the full id and CommonSwarm
never guesses. The workspace-id environment variable is a power-user override,
with --workspace-id taking precedence. An invite link supplies its whole target
and cannot be combined with --url or --anon-key.
For an unrecognized origin, --link-stdin and --json hard-fail without a prompt;
use a positional link without --json when an interactive confirmation is needed.
The fixture bridge is test-only. It reads its privileged database connection only
from DATABASE_URL and writes a newly minted agent token only to the absolute
create-new path in SEED_TOKEN_OUT. --workspace-id selects an explicit fixture
workspace only for callers who already hold that full-database credential; it
grants no new authority and is not a governed product workspace-creation path.`;
}

async function target(args: Arguments): Promise<CloudTarget> {
  return await resolveCloudTarget({
    explicitUrl: args.optional("url"),
    explicitAnonKey: args.optional("anon-key"),
    environmentalUrl: process.env.SWARM_CLOUD_URL,
    environmentalAnonKey: process.env.SWARM_CLOUD_ANON_KEY,
    mode: args.has("agent-token-stdin") ? "agent" : "human",
  });
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

interface AgentCredentialInput {
  token: string;
  principalId: string | null;
  tokenId: string | null;
  runId: string | null;
  /** Epoch ms, when the artifact stated one. Null for a bare or pre-renewal artifact. */
  expiresAt: number | null;
  durable: boolean;
}

/**
 * `expires_at` is OPTIONAL, and both halves of that matter.
 *
 * Optional because artifacts already in circulation have six keys and must keep working —
 * the reader below accepts either shape. Present, from now on, because renewal needs it:
 * without a stated expiry the CLI cannot tell whether a credential handed to it on stdin
 * has fifty-nine minutes left or one, and the only alternatives are to renew eagerly on
 * every first use — which SUPERSEDES a perfectly good credential and spends a successor to
 * learn a number the issuer already knew — or to renew on a 401, which means the person
 * watching sees a failure first. Stating it costs one field and removes both.
 */
function agentCredentialArtifact(input: {
  principalId: string;
  tokenId: string;
  runId: string;
  token: string;
  expiresAt?: number | null;
}): Record<string, unknown> {
  return {
    message: AGENT_CREDENTIAL_MESSAGE,
    status: "accepted",
    principal_id: input.principalId,
    token_id: input.tokenId,
    run_id: input.runId,
    agent_token: input.token,
    ...(input.expiresAt === undefined || input.expiresAt === null
      ? {}
      : { expires_at: new Date(input.expiresAt).toISOString() }),
  };
}

function parsedAgentCredential(value: string): AgentCredentialInput {
  if (!value.startsWith("{")) {
    assertAgentToken(value);
    return {
      token: value,
      principalId: null,
      tokenId: null,
      runId: null,
      expiresAt: null,
      durable: false,
    };
  }
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("agent credential JSON is malformed");
  }
  const artifact = parsed as Record<string, unknown>;
  // Still a closed key set, still exact — there are now two accepted shapes rather than
  // one. `expires_at` is the only addition, and an artifact carrying anything else is as
  // malformed as it ever was.
  const requiredKeys = [
    "agent_token",
    "message",
    "principal_id",
    "run_id",
    "status",
    "token_id",
  ];
  const withExpiry = [...requiredKeys, "expires_at"].sort();
  const actualKeys = Object.keys(artifact).sort();
  const shape = actualKeys.length === requiredKeys.length
    ? requiredKeys
    : withExpiry;
  if (
    actualKeys.length !== shape.length ||
    !actualKeys.every((key, index) => key === shape[index]) ||
    artifact.message !== AGENT_CREDENTIAL_MESSAGE ||
    artifact.status !== "accepted" ||
    typeof artifact.principal_id !== "string" ||
    !UUID_RE.test(artifact.principal_id) ||
    typeof artifact.token_id !== "string" ||
    !UUID_RE.test(artifact.token_id) ||
    typeof artifact.run_id !== "string" ||
    !UUID_RE.test(artifact.run_id) ||
    typeof artifact.agent_token !== "string"
  ) {
    throw new Error("agent credential JSON is malformed");
  }
  let expiresAt: number | null = null;
  if (artifact.expires_at !== undefined) {
    if (typeof artifact.expires_at !== "string") {
      throw new Error("agent credential JSON is malformed");
    }
    const parsedExpiry = Date.parse(artifact.expires_at);
    if (Number.isNaN(parsedExpiry)) {
      throw new Error("agent credential JSON is malformed");
    }
    expiresAt = parsedExpiry;
  }
  assertAgentToken(artifact.agent_token);
  return {
    token: artifact.agent_token,
    principalId: artifact.principal_id.toLowerCase(),
    tokenId: artifact.token_id.toLowerCase(),
    runId: artifact.run_id.toLowerCase(),
    expiresAt,
    durable: true,
  };
}

async function stdinCredential(): Promise<AgentCredentialInput> {
  if (process.stdin.isTTY) {
    throw new Error(
      "--agent-token-stdin requires a piped secret; it is never accepted as a command-line argument",
    );
  }
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk.toString();
    // Mint JSON carries the token plus three UUIDs. Keep stdin bounded while
    // allowing that closed artifact instead of only the legacy bare token.
    if (value.length > 4096) {
      throw new Error("agent credential input is too large");
    }
  }
  const credential = value.trim();
  return parsedAgentCredential(credential);
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

function writeWorkspaceWarning(warning: WorkspaceWarning): void {
  process.stderr.write(`cswarm: ${warning.message}\n`);
  process.stderr.write(`${JSON.stringify(warning)}\n`);
}

async function workspaceId(
  args: Arguments,
  cloud: CloudTarget,
  human: HumanSession,
  options: {
    directory?: WorkspaceDirectory;
    workspaces?: readonly WorkspaceSummary[];
    warn?: (warning: WorkspaceWarning) => void;
    validateOverride?: boolean;
  } = {},
): Promise<string> {
  return await resolveWorkspace({
    explicit: args.optional("workspace-id"),
    environmental: process.env.SWARM_CLOUD_WORKSPACE_ID,
    session: human,
    store: human.store,
    directory: options.directory ?? cloudWorkspaceDirectory(cloud),
    ...(options.workspaces === undefined
      ? {}
      : { workspaces: options.workspaces }),
    ...(options.validateOverride === undefined
      ? {}
      : { validateOverride: options.validateOverride }),
    warn: options.warn ?? writeWorkspaceWarning,
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
  result: { response: ConnectCommandResult["response"] },
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

async function profileIdentity(
  human: HumanSession,
): Promise<{ email: string | null; workspaceId: string | null }> {
  const profile = await human.store.withLock(
    () => human.store.readProfile(),
  );
  return profile.userId === human.userId
    ? {
      email: profile.email ?? null,
      workspaceId: profile.workspaceId,
    }
    : { email: null, workspaceId: null };
}

async function runWorkspaces(args: Arguments): Promise<void> {
  args.assertShape([...TARGET_FLAGS, "json"], 1);
  const cloud = await target(args);
  const human = await humanCredential(args, cloud);
  const directory = cloudWorkspaceDirectory(cloud);
  const projects = await directory.list(human);
  const profile = await profileIdentity(human);
  const selectedWorkspaceId = projects.some(
      (project) => project.workspace_id === profile.workspaceId,
    )
    ? profile.workspaceId
    : null;
  if (args.has("json")) {
    printJson({
      identity: {
        user_id: human.userId,
        email: profile.email,
      },
      selected_workspace_id: selectedWorkspaceId,
      projects,
      known_gaps: archiveKnownGaps(),
    });
    return;
  }
  process.stdout.write(
    `${renderWorkspaces(projects, selectedWorkspaceId)}\n`,
  );
}

async function runUse(args: Arguments): Promise<void> {
  args.assertShape([...TARGET_FLAGS, "json"], 2);
  const cloud = await target(args);
  const human = await humanCredential(args, cloud);
  const directory = cloudWorkspaceDirectory(cloud);
  const selected = await selectWorkspace(
    args.positionals[1]!,
    await directory.list(human),
    human.store,
    human.userId,
  );
  const message =
    `Selected project ${selected.name} (${selected.workspace_id}). Later commands will use it unless --workspace-id or SWARM_CLOUD_WORKSPACE_ID overrides it.`;
  if (args.has("json")) {
    printJson({
      code: "project_selected",
      message,
      project: selected,
    });
    return;
  }
  process.stdout.write(`${message}\n`);
}

async function runNew(args: Arguments): Promise<void> {
  const named = args.has("name");
  if (named && args.positionals.length > 1) {
    throw new Error(
      "give the project name once: as a positional or as --name, not both",
    );
  }
  args.assertShape([...TARGET_FLAGS, "name", "json"], named ? 1 : 2);
  // Validated before any credential or network work, so a typo costs one line.
  const name = (named ? args.required("name") : args.positionals[1]!).trim();
  assertWorkspaceName(name);
  const cloud = await target(args);
  const human = await humanCredential(args, cloud);
  // The id is ours: the project has no route to be addressed by until it exists,
  // so the server takes the one we propose rather than handing one back.
  const proposedId = randomUUID();
  let result: ConnectCommandResult;
  try {
    result = await new ThinCommandClient(cloud).sendConnect({
      command: { kind: "create_workspace", workspace_id: proposedId, name },
      credential: human.accessToken,
    });
  } catch (error) {
    if (error instanceof CommandTransportError) {
      throw new CommandTransportError(
        `${error.message}; run cswarm workspaces to see whether the project exists before creating it again`,
      );
    }
    throw error;
  }
  const response = acceptedConnect("project creation", result);
  const created = uuid(response.workspace_id, "workspace_id");
  if (created !== proposedId) {
    throw new Error(
      "the server confirmed a different project than this command created; run cswarm workspaces before doing anything else",
    );
  }
  await writeWorkspaceDefault(human.store, human.userId, created);
  const message =
    `Created project ${name} (${created}). It is now your selected project, so later commands will use it unless --workspace-id or SWARM_CLOUD_WORKSPACE_ID overrides it.`;
  const next =
    `Next: cswarm invite --email <address> brings someone in, and cswarm working-on "<what>" tells them what you have started.`;
  if (args.has("json")) {
    printJson({
      code: "project_created",
      message: `${message} ${next}`,
      project: {
        workspace_id: created,
        name,
        stream_id: typeof response.stream_id === "string" &&
            UUID_RE.test(response.stream_id)
          ? response.stream_id
          : null,
      },
    });
    return;
  }
  process.stdout.write(`${message}\n${next}\n`);
}

async function runTarget(args: Arguments): Promise<void> {
  const action = args.positionals[1] ?? "show";
  if (action === "show") {
    args.assertShape(["json"], args.positionals[1] === undefined ? 1 : 2);
    const saved = await readCurrentTarget();
    if (args.has("json")) {
      printJson({
        current_target: saved === null ? null : currentTargetSummary(saved),
      });
      return;
    }
    if (saved === null) {
      process.stdout.write(
        "No current Cloud target is saved. Start with cswarm accept --link-stdin, or run cswarm target set --url <project-url> --anon-key <key>.\n",
      );
      return;
    }
    const summary = currentTargetSummary(saved);
    process.stdout.write(
      `Current Cloud target: ${summary.url}\nAnon key fingerprint: ${summary.anon_key_fingerprint}\n`,
    );
    return;
  }
  if (action === "set") {
    args.assertShape(["url", "anon-key", "json"], 2);
    const selected = cloudTarget(
      args.required("url"),
      args.required("anon-key"),
    );
    await writeCurrentTarget(selected);
    const summary = currentTargetSummary(selected);
    if (args.has("json")) {
      printJson({
        code: "current_target_set",
        current_target: summary,
      });
      return;
    }
    process.stdout.write(
      `Current Cloud target set to ${summary.url}. Later human commands will use it unless flags or environment variables override it.\n`,
    );
    return;
  }
  if (action === "clear") {
    args.assertShape(["json"], 2);
    const removed = await clearCurrentTarget();
    if (args.has("json")) {
      printJson({
        code: removed ? "current_target_cleared" : "current_target_absent",
        removed,
      });
      return;
    }
    process.stdout.write(
      removed
        ? "Current Cloud target cleared. Saved login profiles were not deleted.\n"
        : "No current Cloud target was saved.\n",
    );
    return;
  }
  throw new Error(`unknown target command: ${action}`);
}

async function runStatus(args: Arguments): Promise<void> {
  args.assertShape([...TARGET_FLAGS, "workspace-id", "json"], 1);
  const cloud = await target(args);
  const human = await humanCredential(args, cloud);
  const directory = cloudWorkspaceDirectory(cloud);
  const projects = await directory.list(human);
  const profile = await profileIdentity(human);
  const identityLabel = sanitizeDisplayLabel(
    profile.email ?? human.userId,
    human.userId,
  );
  if (projects.length === 0) {
    const warnings: WorkspaceWarning[] = [];
    if (
      profile.workspaceId !== null &&
      await clearWorkspaceDefault(
        human.store,
        human.userId,
        profile.workspaceId,
      )
    ) {
      warnings.push(DEFAULT_MEMBERSHIP_REVOKED);
      if (!args.has("json")) writeWorkspaceWarning(warnings[0]!);
    }
    const message =
      "You're not in any projects yet. Ask a colleague to send you an invitation link, then accept it with cswarm accept --link-stdin.";
    if (args.has("json")) {
      printJson({
        identity: {
          user_id: human.userId,
          email: profile.email,
          device_id: human.deviceId,
        },
        project_count: 0,
        selected_project: null,
        message,
        members: [],
        agents: [],
        tasks: [],
        warnings,
      });
      return;
    }
    process.stdout.write(
      `You: ${identityLabel} (${human.userId})\nYou're not in any projects yet.\nAsk a colleague to send you an invitation link, then accept it with cswarm accept --link-stdin.\n`,
    );
    return;
  }
  const warnings: WorkspaceWarning[] = [];
  const selectedWorkspaceId = await workspaceId(args, cloud, human, {
    directory,
    workspaces: projects,
    warn: (warning) => {
      warnings.push(warning);
      if (!args.has("json")) writeWorkspaceWarning(warning);
    },
  });
  const selected = projects.find(
    (project) => project.workspace_id === selectedWorkspaceId,
  );
  if (!selected) throw new WorkspaceUnavailableError();
  const [status, signalStatus] = await Promise.all([
    directory.status(human, selectedWorkspaceId),
    settleSignalStatus(
      readSignals(cloud, {
        kind: "human",
        accessToken: human.accessToken,
        userId: human.userId,
      }, {
        workspaceId: selectedWorkspaceId,
        inbox: false,
        limit: 5,
      }),
      readSignals(cloud, {
        kind: "human",
        accessToken: human.accessToken,
        userId: human.userId,
      }, {
        workspaceId: selectedWorkspaceId,
        inbox: true,
        kind: "ask",
        limit: 100,
      }),
    ),
  ]);
  const statusWarnings: Array<
    WorkspaceWarning | { code: "signal_status_unavailable"; message: string }
  > = [...warnings];
  if (signalStatus.warning !== null) {
    statusWarnings.push({
      code: "signal_status_unavailable",
      message: signalStatus.warning,
    });
  }
  if (args.has("json")) {
    printJson({
      identity: {
        user_id: human.userId,
        email: profile.email,
        device_id: human.deviceId,
      },
      project_count: projects.length,
      selected_project: selected,
      members: status.members,
      agents: status.agents,
      tasks: status.tasks,
      recent_signals: signalStatus.recentSignals,
      inbox_asks_waiting: signalStatus.waitingAsks,
      warnings: statusWarnings,
      known_gaps: archiveKnownGaps(),
    });
    return;
  }
  const renderedSignalStatus = signalStatus.warning === null
    ? renderSignalStatus(
      signalStatus.recentSignals!,
      signalStatus.waitingAsks!,
      {
        authors: signalAuthorLabelsFromStatus(status, human.userId),
      },
    )
    : `Recent signals:\n${signalStatus.warning}`;
  process.stdout.write(`${renderStatus({
    userId: human.userId,
    identityLabel,
    projectCount: projects.length,
    selected,
    status,
  })}\n\n${renderedSignalStatus}\n`);
}

async function runInvite(args: Arguments): Promise<void> {
  args.assertShape([...TARGET_FLAGS, "workspace-id", "email"], 1);
  const cloud = await target(args);
  const human = await humanCredential(args, cloud);
  const workspace = await workspaceId(args, cloud, human);
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

async function runMember(args: Arguments): Promise<void> {
  args.assertShape(
    [...TARGET_FLAGS, "workspace-id", "confirm", "json"],
    3,
  );
  if (args.positionals[1] !== "remove") {
    throw new UsageError(
      `unknown member command: ${args.positionals[1] ?? "(missing)"}`,
    );
  }
  const selector = args.positionals[2]!;
  if (args.required("confirm") !== selector) {
    throw new Error(
      "--confirm must exactly repeat the member selector; no request was sent",
    );
  }
  const cloud = await target(args);
  const human = await humanCredential(args, cloud);
  const directory = cloudWorkspaceDirectory(cloud);
  const workspace = await workspaceId(args, cloud, human, { directory });
  const status = await directory.status(human, workspace);
  const selected = resolveWorkspaceMember(selector, status.members);
  const response = (
    await sendConnectWithPending(
      new ThinCommandClient(cloud),
      human,
      workspace,
      { kind: "remove_member", user_id: selected.user_id },
    )
  ).response;
  if (response.status !== "accepted") {
    const reason: string = response.reason ?? "";
    const recovery = reason === "landing_authority_unresolved"
      ? " Transfer this member's repository landing authority with the separate audited transfer command, then retry."
      : reason === "last_owner"
      ? " Promote another Owner before retrying."
      : "";
    throw new Error(
      `Member removal was rejected: ${
        reason || "domain rejection"
      }. No membership change was recorded.${recovery}`,
    );
  }
  const output = {
    message:
      `Removed ${selected.name} (${selected.user_id}) from this project. Their access to other projects was not changed.`,
    status: response.status,
    user_id: selected.user_id,
    command_event_ids: response.event_ids,
  };
  if (args.has("json")) {
    printJson(output);
  } else {
    process.stdout.write(`${output.message}\n`);
  }
}

async function runLegacyAccept(args: Arguments): Promise<void> {
  const invitationToken = await invitationCredential(args);
  const cloud = await target(args);
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
  await writeCurrentTarget(cloud);
  printJson({
    message:
      "Invitation accepted. CommonSwarm saved the workspace as your default so later commands need fewer flags.",
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
      devAllowedOrigins: process.env.CSWARM_DEV_ALLOWED_ORIGINS,
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
  await writeCurrentTarget(cloud);
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
      "accept expects one swm_inv_ capability or cswarm://accept/<invite-link>",
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
  const action = args.positionals[1];
  if (action === "create") {
    args.assertShape([...TARGET_FLAGS, "workspace-id", "name"], 2);
    const cloud = await target(args);
    const human = await humanCredential(args, cloud);
    const workspace = await workspaceId(args, cloud, human);
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
    return;
  }
  if (action === "revoke") {
    args.assertShape([...TARGET_FLAGS, "workspace-id", "principal-id", "json"], 2);
    const cloud = await target(args);
    const human = await humanCredential(args, cloud);
    const workspace = await workspaceId(args, cloud, human);
    const principalId = args.required("principal-id");
    const response = (
      await sendConnectWithPending(
        new ThinCommandClient(cloud),
        human,
        workspace,
        { kind: "revoke_agent_principal", principal_id: principalId },
      )
    ).response;
    if (response.status !== "accepted") {
      throw new Error(
        `Agent identity revocation was refused: ${
          response.reason ?? "required condition not met"
        }. The identity and its credentials are unchanged.`,
      );
    }
    const output = {
      message:
        "Agent identity revoked. Its credentials can no longer post or renew, and collaborators will no longer see it as active.",
      status: response.status,
      principal_id: principalId,
      command_event_ids: response.event_ids,
    };
    if (args.has("json")) {
      printJson(output);
    } else {
      process.stdout.write(`${output.message}\n`);
    }
    return;
  }
  throw new Error(`unknown principal command: ${action ?? "(missing)"}`);
}

/**
 * ★ THE GRANT IS NOT CREATED FROM HERE ANY MORE, AND THIS FUNCTION IS GONE.
 *
 * It used to send a `create_renewal_grant` command before minting. THE REDUCER NEVER
 * IMPLEMENTED THAT KIND — `git grep create_renewal_grant src/protocol` returns nothing — so
 * the command was refused as `invalid_request` on every deployment that has ever existed.
 * The failure was caught and reported as advice:
 *
 *   "this deployment did not open a renewal window ... The credential below still works,
 *    but it will not renew itself — re-issue one by hand when it expires."
 *
 * That sentence was FALSE, and it was printed on every single mint. The server creates the
 * grant atomically inside the mint transaction (supabase/functions/command/index.ts, "THE
 * RENEWAL GRANT IS CREATED HERE, IN THE SAME TRANSACTION AS THE TOKEN"), precisely because
 * an earlier version had this same split and shipped root tokens with renewal_grant_id NULL.
 * So the grant existed, renewal worked, and the CLI told every operator it did not — which
 * is worse than saying nothing, because the remedy it recommends is hand-rotation.
 *
 * Measured in production on 2026-07-29, not inferred: a minted credential printed the
 * warning above, and the very next agent call renewed against a grant the server had already
 * created. Two builds of the same feature disagreeing about whose job it was is what this
 * removal ends.
 *
 * There is nothing to put in its place. "Mint one, get one, atomically" is the whole design.
 */

async function runToken(args: Arguments): Promise<void> {
  const action = args.positionals[1];
  if (action === "revoke") {
    await runTokenRevoke(args);
    return;
  }
  args.assertShape(
    [
      ...TARGET_FLAGS,
      "workspace-id",
      "principal-id",
      "run-id",
      "task-id",
      "epoch",
      "ttl-ms",
      "renewal-horizon-days",
    ],
    2,
  );
  if (action !== "mint") {
    throw new Error(`unknown token command: ${action ?? "(missing)"}`);
  }
  const cloud = await target(args);
  const human = await humanCredential(args, cloud);
  const workspace = await workspaceId(args, cloud, human);
  const ttl = args.optional("ttl-ms");
  const principalId = args.required("principal-id");
  const runId = args.required("run-id");
  // Days, not milliseconds: this is the one renewal number a person chooses, and the
  // honest unit for "how long before I am asked again" is days.
  const horizonMs = args.optional("renewal-horizon-days") === undefined
    ? RENEWAL_HORIZON_DEFAULT_MS
    : integer(args, "renewal-horizon-days", {
      minimum: 1,
      maximum: Math.floor(RENEWAL_HORIZON_MAX_MS / 86_400_000),
    }) * 86_400_000;
  /* No separate grant call. The server creates the renewal grant in the same transaction
     as the token, so a successful mint IS a grant — see the removed createRenewalGrant
     above for why this used to be its own request and why that was wrong. The horizon is
     still read from the flag because it is reported to the operator below; the server
     applies its own default and ceiling regardless of what is asked for here. */
  const response = acceptedConnect(
    "token mint",
    await sendConnectWithPending(
      new ThinCommandClient(cloud),
      human,
      workspace,
      {
        kind: "mint_agent_token",
        principal_id: principalId,
        run_id: runId,
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
  const expiresAt = mintedExpiry(response);
  /* The stated expiry is now the ONLY condition, and it is the honest one: the CLI schedules
     renewal off that deadline and refuses to renew a credential whose deadline it does not
     know (src/cloud/renewal.ts `due()`), so an artifact without an expiry renews nothing no
     matter what the server can do. The grant is no longer part of this test because it is no
     longer a separate thing that can fail — a mint that returned a token created one. */
  process.stderr.write(
    expiresAt !== null
      ? `This credential renews itself, so the agent keeps working without anyone re-issuing it. A person is asked to authorise it again in ${
        Math.round(horizonMs / 86_400_000)
      } days.\n`
      : "This credential does not renew itself; re-issue one by hand when it expires.\n",
  );
  printJson(agentCredentialArtifact({
    principalId,
    tokenId: uuid(response.token_id, "token_id"),
    runId: uuid(response.run_id, "run_id"),
    token: response.agent_token,
    expiresAt,
  }));
}

/**
 * Human token revoke names a token-id. Agent self-surrender pipes the artifact via
 * --agent-token-stdin, derives (or validates) token_id from that artifact, and never
 * accepts the secret as argv or prints it back.
 */
async function runTokenRevoke(args: Arguments): Promise<void> {
  if (args.has("agent-token-stdin")) {
    args.assertShape(
      [...TARGET_FLAGS, "workspace-id", "token-id", "agent-token-stdin", "json"],
      2,
    );
    const cloud = await target(args);
    const agent = await stdinCredential();
    const override = workspaceOverride(
      args.optional("workspace-id"),
      process.env.SWARM_CLOUD_WORKSPACE_ID,
    );
    if (override === null) {
      throw new Error(
        "agent token revoke requires --workspace-id or SWARM_CLOUD_WORKSPACE_ID",
      );
    }
    if (agent.tokenId === null) {
      throw new Error(
        "agent credential on stdin has no token_id; pipe the JSON artifact from token mint, not a bare secret",
      );
    }
    const requested = args.optional("token-id");
    if (requested !== undefined && requested.toLowerCase() !== agent.tokenId) {
      throw new Error(
        "token-id does not match the credential on stdin; no request was sent",
      );
    }
    const tokenId = agent.tokenId;
    const response = (
      await new ThinCommandClient(cloud).sendConnect({
        workspaceId: override,
        credential: agent.token,
        command: { kind: "revoke_agent_token", token_id: tokenId },
      })
    ).response;
    if (response.status !== "accepted") {
      throw new Error(
        `Credential surrender was refused: ${
          response.reason ?? "required condition not met"
        }. The credential is unchanged.`,
      );
    }
    const output = {
      message:
        "This credential has been surrendered. It can no longer post or renew.",
      status: response.status,
      token_id: tokenId,
      command_event_ids: response.event_ids,
    };
    if (args.has("json")) {
      printJson(output);
    } else {
      process.stdout.write(`${output.message}\n`);
    }
    return;
  }

  args.assertShape(
    [...TARGET_FLAGS, "workspace-id", "token-id", "json"],
    2,
  );
  const cloud = await target(args);
  const human = await humanCredential(args, cloud);
  const workspace = await workspaceId(args, cloud, human);
  const tokenId = args.required("token-id");
  const response = (
    await sendConnectWithPending(
      new ThinCommandClient(cloud),
      human,
      workspace,
      { kind: "revoke_agent_token", token_id: tokenId },
    )
  ).response;
  if (response.status !== "accepted") {
    throw new Error(
      `Token revocation was refused: ${
        response.reason ?? "required condition not met"
      }. The credential is unchanged.`,
    );
  }
  const output = {
    message:
      "Agent credential revoked. It can no longer post or renew, and its renewal lineage is closed.",
    status: response.status,
    token_id: tokenId,
    command_event_ids: response.event_ids,
  };
  if (args.has("json")) {
    printJson(output);
  } else {
    process.stdout.write(`${output.message}\n`);
  }
}

/**
 * The expiry the mint just recorded, so the artifact can state it and the agent's CLI can
 * renew on time instead of guessing. Read from the AgentTokenMinted event rather than a
 * top-level field, because that is where the reducer puts it; the top-level string is
 * accepted too since the renewal reply uses that shape.
 */
function mintedExpiry(
  response: ConnectCommandResult["response"],
): number | null {
  for (const raw of response.events ?? []) {
    const event = raw as unknown as Record<string, unknown>;
    if (event.type !== "AgentTokenMinted") continue;
    const payload = event.payload as Record<string, unknown> | undefined;
    const expires = payload?.expires_at;
    if (typeof expires === "number" && Number.isFinite(expires)) return expires;
  }
  if (typeof response.expires_at === "string") {
    const parsed = Date.parse(response.expires_at);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

/**
 * The six leaves a link holder can read, named here so --json states the allowlist
 * rather than leaving the person sharing a credential to infer it.
 */
const CAPABILITY_DISCLOSED_FIELDS = [
  "work_item.slug",
  "work_item.lifecycle",
  "repo.full_name",
  "inviter.display_name",
  "workspace.age_days",
  "expires_at",
] as const;

async function runLink(args: Arguments): Promise<void> {
  const subcommand = args.positionals[1];
  if (subcommand === "new") {
    await runLinkNew(args);
    return;
  }
  if (subcommand === "revoke") {
    await runLinkRevoke(args);
    return;
  }
  throw new UsageError(`unknown link command: ${subcommand ?? "(missing)"}`);
}

async function runLinkNew(args: Arguments): Promise<void> {
  args.assertShape(
    [...TARGET_FLAGS, "workspace-id", "task-id", "ttl-ms", "site", "json"],
    2,
  );
  const taskId = args.required("task-id");
  if (!UUID_RE.test(taskId)) {
    throw new Error("--task-id must be the work item's UUID");
  }
  // Resolved before the request, not after: a mistyped origin must cost a line of
  // output, never a live credential we then cannot render as a usable link.
  const site = capabilitySiteOrigin(
    args.optional("site"),
    process.env.CSWARM_SITE_ORIGIN,
  );
  // Bounded here rather than at the call site, so every local objection to the command
  // is raised before any credential work happens.
  const ttl = args.has("ttl-ms")
    ? integer(args, "ttl-ms", {
      minimum: CAPABILITY_MIN_TTL_MS,
      maximum: CAPABILITY_MAX_TTL_MS,
    })
    : undefined;
  const cloud = await target(args);
  const human = await humanCredential(args, cloud);
  // §7 human-mint-only is enforced by the command function, which is the authority. This
  // raises the same rule locally so the refusal names it: the server's answer is a uniform
  // 403 shared with "not an owner" and "no such work item", and an agent credential that
  // can never mint deserves to be told so without a round trip.
  assertHumanCapabilityCredential(human.accessToken, "create");
  const workspace = await workspaceId(args, cloud, human);
  const response = acceptedConnect(
    "link new",
    await sendCapabilityWithPending(
      new ThinCommandClient(cloud),
      human,
      workspace,
      {
        kind: "mint_capability_url",
        task_id: taskId,
        ...(ttl === undefined ? {} : { ttl_ms: ttl }),
      },
    ),
  );
  if (response.capability_token === undefined) {
    // A replayed mint returns the id but never the credential — the server stores only
    // a hash. Naming the id here is what keeps the unseeable link revocable rather than
    // stranding it live until its TTL runs out; an id is a handle, not a credential.
    throw new Error(
      `this link was created on a prior attempt, and its credential is shown only in a fresh response — the server keeps just a hash, so it cannot be shown again; run cswarm link new to issue another, then run cswarm link revoke --capability-id ${
        uuid(response.capability_id, "capability_id")
      } to withdraw the one you cannot see`,
    );
  }
  assertCapabilityToken(response.capability_token);
  const capabilityId = uuid(response.capability_id, "capability_id");
  const expiresAt = capabilityTimestamp(response.expires_at, "expires_at");
  // The credential enters a string here and is written out once, immediately below.
  // It is never stored, never re-read, and never interpolated into an Error.
  const url = capabilityUrl(site, response.capability_token);
  if (args.has("json")) {
    printJson({
      message:
        `Capability link created. It is shown once and is never recoverable. ${CAPABILITY_DISCLOSURE}`,
      status: response.status,
      capability_id: capabilityId,
      capability_url: url,
      expires_at: expiresAt,
      shown_once: true,
      discloses: [...CAPABILITY_DISCLOSED_FIELDS],
    });
    return;
  }
  process.stdout.write(
    `${
      renderCapabilityMint({ url, taskId, capabilityId, expiresAt })
    }\n`,
  );
}

async function runLinkRevoke(args: Arguments): Promise<void> {
  args.assertShape(
    [...TARGET_FLAGS, "workspace-id", "capability-id", "json"],
    2,
  );
  const capabilityId = args.required("capability-id");
  if (!UUID_RE.test(capabilityId)) {
    throw new Error(
      "--capability-id must be the id printed when the link was created",
    );
  }
  const cloud = await target(args);
  const human = await humanCredential(args, cloud);
  // Revoke is human-only for the same reason and by the same server check
  // (capability_revoke_credential_kind_forbidden); say so here rather than at the 403.
  assertHumanCapabilityCredential(human.accessToken, "revoke");
  const workspace = await workspaceId(args, cloud, human);
  const response = acceptedConnect(
    "link revoke",
    await sendCapabilityWithPending(
      new ThinCommandClient(cloud),
      human,
      workspace,
      { kind: "revoke_capability_url", capability_id: capabilityId },
    ),
  );
  const revoked = uuid(response.capability_id, "capability_id");
  const revokedAt = capabilityTimestamp(response.revoked_at, "revoked_at");
  const message = renderCapabilityRevoke(revoked, revokedAt);
  if (args.has("json")) {
    printJson({
      message,
      status: response.status,
      capability_id: revoked,
      revoked_at: revokedAt,
    });
    return;
  }
  process.stdout.write(`${message}\n`);
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

/**
 * Opens the renewing session for a credential that arrived on stdin (§2.3).
 *
 * The lineage key is derived from the credential the caller presented, so the successor
 * this run obtains is found again by the next run — which is the whole point: a one-shot
 * CLI that forgot its successor would be back to an eight-hour wall. When the store cannot
 * be opened (a read-only home directory, a hostile umask) renewal still happens, it just
 * does not outlive the process, and the caller is told so rather than left to find out in
 * eight hours.
 */
async function agentSession(
  cloud: CloudTarget,
  workspaceId: string,
  agent: AgentCredentialInput,
): Promise<AgentCredentialSession> {
  let store: Awaited<ReturnType<typeof agentCredentialStore>> | null = null;
  try {
    const candidate = await agentCredentialStore({
      target: cloud,
      lineageKey: credentialLineageKey(agent.token),
    });
    // Proved usable before it is trusted, the way agentSignalPendingStore proves its own:
    // the directory checks (owned by this user, 0700, not a symlink) only run on first
    // touch, and a path that fails them must degrade to "no renewal" rather than abort a
    // command that would otherwise have worked.
    await candidate.withLock(async () => {
      await candidate.read().catch(() => null);
    });
    store = candidate;
  } catch {
    process.stderr.write(
      "cswarm: this machine has nowhere safe to keep a renewed credential, so this credential will not renew itself and has to be re-issued by hand when it expires.\n",
    );
  }
  return await AgentCredentialSession.open({
    target: cloud,
    workspaceId,
    presented: {
      token: agent.token,
      tokenId: agent.tokenId,
      principalId: agent.principalId,
      runId: agent.runId,
      expiresAt: agent.expiresAt,
    },
    store,
  });
}

async function commandWorkspaceAndCredential(
  args: Arguments,
  cloud: CloudTarget,
  options: { validateHumanWorkspace?: boolean } = {},
): Promise<{
  selectedWorkspace: string;
  bearer: string;
  credentials?: CredentialStore;
  kind: "human" | "agent";
  human?: HumanSession;
  agent?: AgentCredentialInput;
  session?: AgentCredentialSession;
}> {
  const override = workspaceOverride(
    args.optional("workspace-id"),
    process.env.SWARM_CLOUD_WORKSPACE_ID,
  );
  if (args.has("agent-token-stdin")) {
    if (override === null) {
      throw new Error(
        "not logged in; agent credentials require --workspace-id or SWARM_CLOUD_WORKSPACE_ID because they never infer a human's project selection",
      );
    }
    const agent = await stdinCredential();
    // Renewal is resolved HERE, before the first request rather than after a 401, so a
    // credential that is about to expire is replaced without the person watching ever
    // seeing a failure. Every caller below reads `bearer` as a plain string; the session
    // is what decided which string that is.
    const session = await agentSession(cloud, override, agent);
    return {
      selectedWorkspace: override,
      bearer: await session.bearer(),
      kind: "agent",
      agent,
      session,
    };
  }
  const human = await humanCredential(args, cloud);
  return {
    selectedWorkspace: await workspaceId(args, cloud, human, {
      validateOverride: options.validateHumanWorkspace ?? false,
    }),
    bearer: human.accessToken,
    credentials: human.store,
    kind: "human",
    human,
  };
}

function signalKind(value: string): SignalKind {
  if (!["working-on", "note", "ask"].includes(value)) {
    throw new Error("--kind must be working-on, note, or ask");
  }
  return value as SignalKind;
}

function signalDuration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^([1-9]\d*)(m|h|d)$/.exec(value);
  if (!match) {
    throw new Error("--until must be a duration such as 90m, 24h, or 7d");
  }
  const unit = match[2] === "m"
    ? 60_000
    : match[2] === "h"
    ? 3_600_000
    : 86_400_000;
  const milliseconds = Number(match[1]) * unit;
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 30 * 86_400_000) {
    throw new Error("--until must be no more than 30d");
  }
  return milliseconds;
}

function signalText(value: string, label: "body" | "about"): string {
  const maximum = label === "body" ? 2000 : 500;
  if (value.length < (label === "body" ? 1 : 0) || value.length > maximum) {
    throw new Error(
      `${label === "body" ? "signal text" : "--about"} must be ${
        label === "body" ? "1.." : "at most "
      }${maximum} characters`,
    );
  }
  return value;
}

async function signalDirectory(
  cloud: CloudTarget,
  selectedWorkspace: string,
  credential: Awaited<ReturnType<typeof commandWorkspaceAndCredential>>,
): Promise<SignalDirectory> {
  if (credential.kind === "agent") {
    return await readAgentSignalDirectory(
      cloud,
      credential.bearer,
      selectedWorkspace,
    );
  }
  const human = credential.human!;
  const status = await cloudWorkspaceDirectory(cloud).status(
    human,
    selectedWorkspace,
  );
  return {
    members: status.members.map((member) => ({
      user_id: member.user_id,
      display_name: member.name,
    })),
    agents: status.agents
      .filter((agent) => !agent.revoked)
      .map((agent) => ({
        principal_id: agent.principal_id,
        name: agent.name,
      })),
  };
}

function signalAuthorLabelsFromStatus(
  status: WorkspaceStatus,
  currentUserId: string,
): SignalAuthorLabels {
  return {
    users: new Map(
      status.members.map((member) => [member.user_id, member.name]),
    ),
    agents: new Map(
      status.agents.map((agent) => [agent.principal_id, agent.name]),
    ),
    currentUserId,
  };
}

async function signalAuthorLabels(
  cloud: CloudTarget,
  selectedWorkspace: string,
  credential: Awaited<ReturnType<typeof commandWorkspaceAndCredential>>,
): Promise<SignalAuthorLabels> {
  if (credential.kind === "agent") {
    const directory = await readAgentSignalDirectory(
      cloud,
      credential.bearer,
      selectedWorkspace,
    );
    return {
      users: new Map(
        directory.members.map((member) => [
          member.user_id,
          sanitizeDisplayLabel(member.display_name, "Unnamed member"),
        ]),
      ),
      agents: new Map(
        directory.agents.map((agent) => [
          agent.principal_id,
          sanitizeDisplayLabel(agent.name, "Unnamed agent"),
        ]),
      ),
    };
  }
  const human = credential.human!;
  const status = await cloudWorkspaceDirectory(cloud).status(
    human,
    selectedWorkspace,
  );
  return signalAuthorLabelsFromStatus(status, human.userId);
}

async function postSignalCommand(
  cloud: CloudTarget,
  credential: Awaited<ReturnType<typeof commandWorkspaceAndCredential>>,
  command: PostSignalCommand,
): Promise<PostSignalResult> {
  const client = new ThinCommandClient(cloud);
  if (credential.kind === "human") {
    return await sendSignalWithPending(
      client,
      {
        credential: credential.bearer,
        credentialIdentity: `user:${credential.human!.userId}`,
        store: credential.credentials!,
      },
      credential.selectedWorkspace,
      command,
    );
  }
  const agent = credential.agent!;
  let pendingStore = null;
  if (agent.durable && agent.principalId !== null) {
    try {
      pendingStore = await agentSignalPendingStore({
        target: cloud,
        principalId: agent.principalId,
      });
    } catch {
      process.stderr.write(
        "cswarm: durable agent signal recovery state is unavailable; this post uses an ephemeral command ID and an ambiguous retry may create a visible duplicate.\n",
      );
    }
  } else {
    process.stderr.write(
      "cswarm: bare agent credentials post with ephemeral command IDs; pipe the JSON from cswarm token mint for durable retry recovery.\n",
    );
  }
  return pendingStore === null
    ? await client.sendSignal({
      workspaceId: credential.selectedWorkspace,
      command,
      credential: credential.bearer,
    })
    : await sendSignalWithPending(
      client,
      {
        credential: credential.bearer,
        credentialIdentity: `agent:${agent.principalId}`,
        store: pendingStore,
      },
      credential.selectedWorkspace,
      command,
    );
}

function signalCredentialOf(
  selected: Awaited<ReturnType<typeof commandWorkspaceAndCredential>>,
): SignalCredential {
  return selected.kind === "agent"
    ? { kind: "agent", token: selected.bearer }
    : {
      kind: "human",
      accessToken: selected.bearer,
      userId: selected.human!.userId,
    };
}

async function runPostSignal(
  args: Arguments,
  kind: SignalKind,
): Promise<void> {
  const allowTo = kind !== "working-on";
  const allowWait = kind === "ask";
  args.assertShape([
    ...TARGET_FLAGS,
    "workspace-id",
    ...CREDENTIAL_FLAGS,
    ...(allowTo ? ["to"] : []),
    "about",
    "until",
    ...(allowWait ? ["wait"] : []),
    "json",
  ], 2);
  const waitSeconds = allowWait && args.optional("wait") !== undefined
    ? parseWaitSeconds(args.required("wait"))
    : undefined;
  const cloud = await target(args);
  const credential = await commandWorkspaceAndCredential(args, cloud, {
    validateHumanWorkspace: true,
  });
  const toSelector = allowTo ? args.optional("to") : undefined;
  const recipient: ResolvedSignalRecipient | null = toSelector === undefined
    ? null
    : resolveSignalRecipient(
      toSelector,
      await signalDirectory(cloud, credential.selectedWorkspace, credential),
    );
  // Broadcast asks cannot receive authorized replies; waiting would never succeed.
  if (waitSeconds !== undefined && recipient === null) {
    throw new Error(
      "ask --wait requires --to with a direct member or agent recipient",
    );
  }
  const untilMs = signalDuration(args.optional("until"));
  const command: PostSignalCommand = {
    kind: "post_signal",
    signal_kind: kind,
    body: signalText(args.positionals[1]!, "body"),
    ...postSignalTargets(recipient),
    about: args.optional("about") === undefined
      ? null
      : signalText(args.required("about"), "about"),
    ...(untilMs === undefined
      ? {}
      : { until_ms: untilMs }),
  };
  const result = await postSignalCommand(cloud, credential, command);
  const signal = result.response.signal!;

  if (waitSeconds !== undefined) {
    const credentialForRead = signalCredentialOf(credential);
    const deadlineMs = waitDeadlineMs(waitSeconds);
    const waitResult = await pollForSignals({
      deadlineMs,
      read: () =>
        readSignals(cloud, credentialForRead, {
          workspaceId: credential.selectedWorkspace,
          inbox: true,
          in_reply_to: signal.id,
          includeStale: false,
          limit: 1,
        }, { deadlineMs }),
    });
    const reply = waitResult.signals[0] ?? null;
    if (args.has("json")) {
      printJson(askWaitJsonPayload(signal, reply, waitResult.timedOut));
      return;
    }
    const authors = await settleSignalAuthorLabels(
      signalAuthorLabels(
        cloud,
        credential.selectedWorkspace,
        credential,
      ),
    );
    if (waitResult.timedOut || reply === null) {
      process.stdout.write(
        `Ask shared. No reply arrived before the wait ended; the ask remains live.\n${
          renderSignals([signal], {
            inbox: false,
            includeStale: true,
            authors,
          })
        }\n`,
      );
      return;
    }
    process.stdout.write(
      `Ask shared and a correlated reply arrived.\n${
        renderSignals([signal, reply], {
          inbox: false,
          includeStale: true,
          authors,
        })
      }\n`,
    );
    return;
  }

  if (args.has("json")) {
    printJson({
      status: result.response.status,
      message:
        "Signal shared. It is immutable, tenancy-scoped, and will quietly expire at its horizon.",
      signal,
    });
    return;
  }
  const authors = await settleSignalAuthorLabels(
    signalAuthorLabels(
      cloud,
      credential.selectedWorkspace,
      credential,
    ),
  );
  const directed = signal.to !== null || signal.to_agent !== null;
  const audience = directed
    ? "visible only to its recipient"
    : "visible to members of this workspace";
  process.stdout.write(
    `Signal shared. It is immutable and ${audience}.\n${renderSignals([signal], {
      inbox: false,
      includeStale: true,
      authors,
    })}\n`,
  );
}

async function runReply(args: Arguments): Promise<void> {
  args.assertShape([
    ...TARGET_FLAGS,
    "workspace-id",
    ...CREDENTIAL_FLAGS,
    "until",
    "json",
  ], 3);
  const signalId = args.positionals[1];
  if (signalId === undefined || !UUID_RE.test(signalId)) {
    throw new Error("reply requires the signal UUID being answered");
  }
  const body = args.positionals[2];
  if (body === undefined) {
    throw new Error("reply requires the reply text");
  }
  const cloud = await target(args);
  const credential = await commandWorkspaceAndCredential(args, cloud, {
    validateHumanWorkspace: true,
  });
  const untilMs = signalDuration(args.optional("until"));
  // Audience is derived server-side from the referenced signal; client sends null targets.
  const command: PostSignalCommand = {
    kind: "post_signal",
    signal_kind: "note",
    body: signalText(body, "body"),
    to_user_id: null,
    to_agent_principal_id: null,
    in_reply_to: signalId.toLowerCase(),
    about: null,
    ...(untilMs === undefined ? {} : { until_ms: untilMs }),
  };
  const result = await postSignalCommand(cloud, credential, command);
  const signal = result.response.signal!;
  if (args.has("json")) {
    printJson({
      status: result.response.status,
      message:
        "Reply shared. It is immutable, tenancy-scoped, and will quietly expire at its horizon.",
      signal,
    });
    return;
  }
  const authors = await settleSignalAuthorLabels(
    signalAuthorLabels(
      cloud,
      credential.selectedWorkspace,
      credential,
    ),
  );
  process.stdout.write(
    `Reply shared. It is immutable and addressed to the original author.\n${
      renderSignals([signal], {
        inbox: false,
        includeStale: true,
        authors,
      })
    }\n`,
  );
}

async function runSignalRead(
  args: Arguments,
  inbox: boolean,
): Promise<void> {
  args.assertShape([
    ...TARGET_FLAGS,
    "workspace-id",
    ...CREDENTIAL_FLAGS,
    "about",
    "kind",
    ...(inbox ? ["wait", "follow", "ndjson"] : []),
    "since",
    "limit",
    "include-stale",
    "json",
  ], 1);

  if (inbox && args.has("follow")) {
    if (!args.has("ndjson")) {
      throw new Error("inbox --follow requires --ndjson");
    }
    if (args.optional("wait") !== undefined) {
      throw new Error("inbox --follow cannot be combined with --wait");
    }
    if (args.has("json")) {
      throw new Error("inbox --follow --ndjson cannot be combined with --json");
    }
    await runInboxFollowCommand(args);
    return;
  }
  if (inbox && args.has("ndjson")) {
    throw new Error("inbox --ndjson requires --follow");
  }

  const waitSeconds = inbox && args.optional("wait") !== undefined
    ? parseWaitSeconds(args.required("wait"))
    : undefined;
  const cloud = await target(args);
  const selected = await commandWorkspaceAndCredential(args, cloud, {
    validateHumanWorkspace: true,
  });
  const credential = signalCredentialOf(selected);
  const queryBase = {
    workspaceId: selected.selectedWorkspace,
    inbox,
    ...(args.optional("about") === undefined
      ? {}
      : { about: signalText(args.required("about"), "about") }),
    ...(args.optional("kind") === undefined
      ? {}
      : { kind: signalKind(args.required("kind")) }),
    ...(args.optional("since") === undefined
      ? {}
      : { since: args.required("since") }),
    ...(args.optional("limit") === undefined
      ? {}
      : { limit: integer(args, "limit", { minimum: 1, maximum: 100 }) }),
    includeStale: args.has("include-stale"),
  };

  let rows;
  let timedOut = false;
  let waited = false;
  if (waitSeconds === undefined) {
    rows = await readSignals(cloud, credential, queryBase);
  } else {
    waited = true;
    const deadlineMs = waitDeadlineMs(waitSeconds);
    const waitResult = await pollForSignals({
      deadlineMs,
      read: () =>
        readSignals(cloud, credential, queryBase, { deadlineMs }),
    });
    rows = waitResult.signals;
    timedOut = waitResult.timedOut;
  }

  if (args.has("json")) {
    printJson(
      signalReadJsonPayload(selected.selectedWorkspace, inbox, rows, {
        waited,
        timedOut,
      }),
    );
    return;
  }
  const authors = await settleSignalAuthorLabels(
    signalAuthorLabels(
      cloud,
      selected.selectedWorkspace,
      selected,
    ),
  );
  if (waited && timedOut && rows.length === 0) {
    process.stdout.write(
      `${
        inbox ? "Inbox" : "Feed"
      }: Nothing arrived before the wait ended.\n`,
    );
    return;
  }
  process.stdout.write(`${renderSignals(rows, {
    inbox,
    includeStale: args.has("include-stale"),
    authors,
  })}\n`);
}

/**
 * Host-neutral resilient inbox receiver. NDJSON frames only; never claims to
 * wake a model or execute message bodies. Rearms with AgentCredentialSession
 * when the caller presented an agent credential so renewal runs before each arm.
 */
async function runInboxFollowCommand(args: Arguments): Promise<void> {
  const cloud = await target(args);
  const selected = await commandWorkspaceAndCredential(args, cloud, {
    validateHumanWorkspace: true,
  });
  const queryBase = {
    workspaceId: selected.selectedWorkspace,
    inbox: true as const,
    ...(args.optional("about") === undefined
      ? {}
      : { about: signalText(args.required("about"), "about") }),
    ...(args.optional("kind") === undefined
      ? {}
      : { kind: signalKind(args.required("kind")) }),
    ...(args.optional("since") === undefined
      ? {}
      : { since: args.required("since") }),
    ...(args.optional("limit") === undefined
      ? {}
      : { limit: integer(args, "limit", { minimum: 1, maximum: 100 }) }),
    includeStale: args.has("include-stale"),
  };

  const controller = new AbortController();
  const onAbortSignal = () => controller.abort();
  process.on("SIGINT", onAbortSignal);
  process.on("SIGTERM", onAbortSignal);
  try {
    const stop = await runInboxFollow({
      workspaceId: selected.selectedWorkspace,
      signal: controller.signal,
      isCredentialFailure: (error) =>
        error instanceof RenewalReauthorisationRequired ||
        error instanceof RenewalRevoked,
      arm: async () => {
        // Renewal is checked on every arm for agent credentials; humans reuse
        // the session bearer already resolved for this process.
        const credential: SignalCredential = selected.session
          ? { kind: "agent", token: await selected.session.bearer() }
          : signalCredentialOf(selected);
        return await readSignals(cloud, credential, queryBase, {
          signal: controller.signal,
        });
      },
      emit: (frame) => {
        process.stdout.write(`${formatFollowFrame(frame)}\n`);
      },
    });
    if (stop.reason === "cancelled") {
      return;
    }
    if (stop.error) throw stop.error;
    throw new Error(`inbox follow stopped (${stop.reason})`);
  } finally {
    process.off("SIGINT", onAbortSignal);
    process.off("SIGTERM", onAbortSignal);
  }
}

async function runTaskCommand(args: Arguments): Promise<void> {
  args.assertShape(
    [...TARGET_FLAGS, ...ROUTE_FLAGS, ...CREDENTIAL_FLAGS, ...TASK_FLAGS],
    2,
  );
  const kind = args.positionals[1];
  if (!kind) throw new Error("command kind is required");
  const cloud = await target(args);
  const { selectedWorkspace, bearer } =
    await commandWorkspaceAndCredential(args, cloud);
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
  const cloud = await target(args);
  const { selectedWorkspace, bearer } =
    await commandWorkspaceAndCredential(args, cloud);
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
      await tokenFile.writeFile(
        JSON.stringify(agentCredentialArtifact({
          principalId: result.principalId,
          tokenId: result.tokenId,
          runId: result.runId,
          token: result.agentToken,
        })),
        "utf8",
      );
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
  // `--version` is checked against RAW ARGV before parsing, because the parser treats an
  // unknown `--flag` as one requiring a value — so `cswarm --version` failed with
  // "--version requires a value", on the single most-typed diagnostic a user has.
  // Found while writing the installer, which could not read back what it had installed.
  //
  // ONLY the FIRST token counts. An earlier draft scanned all of argv, which meant any
  // argument that happened to be the string "-v" — a message body, a value, a branch
  // name — printed the version and silently did not run the command the user typed.
  // A version flag is only a version flag in the leading position.
  const firstArg = process.argv[2];
  if (firstArg === "--version" || firstArg === "-v") {
    process.stdout.write(
      `cswarm ${CLI_BUILD_VERSION} (protocol ${CLIENT_PROTOCOL_VERSION})\n`,
    );
    return;
  }
  const args = new Arguments(process.argv.slice(2));
  const verb = args.positionals[0];
  if (!verb || verb === "help" || args.has("help")) {
    if (verb === "help") args.assertShape([], 1);
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (verb === "login") {
    args.assertShape([...TARGET_FLAGS, "no-browser"], 1);
    const cloud = await target(args);
    const credentials = await store(args, cloud);
    process.stderr.write(
      "Swarm stores the rotating refresh credential in the OS keychain when available; the access token remains in memory only.\n",
    );
    const result = await login({
      target: cloud,
      store: credentials,
      openBrowser: args.has("no-browser") ? async () => false : undefined,
    });
    await writeCurrentTarget(cloud);
    process.stdout.write(
      `Login complete for ${result.userId}. This device (${result.deviceId}) is registered so its agent credentials can be governed independently; refresh credential: ${result.storage}; ${
        result.workspaceId
          ? `project ${result.workspaceId} is now selected`
          : "no project is selected yet—run cswarm workspaces, then cswarm use <full-id|exact-name>"
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
    const cloud = await target(args);
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
  if (verb === "member") {
    await runMember(args);
    return;
  }
  if (verb === "target") {
    await runTarget(args);
    return;
  }
  if (verb === "status") {
    await runStatus(args);
    return;
  }
  if (verb === "working-on" || verb === "note" || verb === "ask") {
    await runPostSignal(args, verb);
    return;
  }
  if (verb === "reply") {
    await runReply(args);
    return;
  }
  if (verb === "feed" || verb === "inbox") {
    await runSignalRead(args, verb === "inbox");
    return;
  }
  if (verb === "workspaces") {
    await runWorkspaces(args);
    return;
  }
  if (verb === "use") {
    await runUse(args);
    return;
  }
  if (verb === "new") {
    await runNew(args);
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
  if (verb === "link") {
    await runLink(args);
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
  throw new UsageError(`unknown command: ${verb}`);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown error";
  return message
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .slice(0, 1000);
}

/**
 * Keeps the line breaks a multi-line explanation needs while still stripping anything a
 * server-supplied string could use to redraw the terminal. safeError() collapses newlines,
 * which is right for a one-line failure and wrong for the reauthorisation notice — that
 * one is a short set of instructions and reads as noise on a single line.
 */
function safeParagraph(message: string): string {
  return message
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .slice(0, 2000);
}

main().catch((error) => {
  // The renewal horizon is not a malfunction; it is the periodic human checkpoint §2.3
  // asks for, arriving on time. Printing it as `cswarm: <flattened 403>` would tell a
  // person their agent broke. It says instead what happened and what to run.
  if (
    error instanceof RenewalReauthorisationRequired ||
    error instanceof RenewalRevoked
  ) {
    process.stderr.write(`${safeParagraph(error.message)}\n`);
    process.exitCode = 1;
    return;
  }
  if (error instanceof WorkspaceCliError) {
    const structured = error.structured();
    const verb = process.argv[2];
    const json = process.argv.includes("--json") &&
      (
        verb === "status" ||
        verb === "workspaces" ||
        verb === "use" ||
        verb === "working-on" ||
        verb === "note" ||
        verb === "ask" ||
        verb === "reply" ||
        verb === "feed" ||
        verb === "inbox"
      );
    if (json) {
      process.stdout.write(`${JSON.stringify(structured, null, 2)}\n`);
    } else {
      process.stderr.write(`cswarm: ${error.message}\n`);
      const projects = structured.projects;
      if (Array.isArray(projects) && projects.length > 0) {
        process.stderr.write("Available projects:\n");
        for (const project of projects) {
          if (!project || typeof project !== "object") continue;
          const row = project as Record<string, unknown>;
          process.stderr.write(
            `- ${String(row.name)} (${String(row.workspace_id)}) — ${String(row.role)}\n`,
          );
        }
      }
      process.stderr.write(`${JSON.stringify(structured)}\n`);
    }
    process.exitCode = 1;
    return;
  }
  if (error instanceof UsageError) {
    process.stderr.write(`cswarm: ${safeError(error)}\n${usage()}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`cswarm: ${safeError(error)}\n`);
  process.exitCode = 1;
});
