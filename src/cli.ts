#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Command } from "./protocol/index.js";
import {
  login,
  logout,
  logoutMessage,
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
  CommandHttpError,
  CommandTransportError,
  newCommandId,
  ThinCommandClient,
  type CommandResult,
  type ConnectCommandResult,
  type PostSignalCommand,
  type PostSignalResult,
  type SignalKind,
  type SignalRecord,
  type StreamRoute,
} from "./cloud/command-client.js";
import {
  CLIENT_PROTOCOL_VERSION,
  cloudTarget,
  type CloudTarget,
} from "./cloud/config.js";
import {
  allowedExtensionList,
  contentTypeForName,
  FILE_CONTENT_WARNING,
  FILE_MAX_VERSION_BYTES,
  FileCommandRefused,
  fileDownloadUrl,
  fileRestore,
  fileTombstone,
  fileVersionCommit,
  fileVersionCreate,
  getObject,
  listFilesAsAgent,
  listFilesAsHuman,
  onceRetried,
  putObject,
  sha256Hex,
  writeDestination,
  type FileListRow,
} from "./cloud/files.js";
import { FeedbackRefusedError, submitFeedback } from "./cloud/feedback.js";
import {
  discoverCloudTarget,
  DEFAULT_SITE_ORIGIN,
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
  describeMintRenewal,
  RENEWAL_HORIZON_DEFAULT_MS,
  RENEWAL_HORIZON_MAX_MS,
  RENEWAL_MAX_SUCCESSORS_DEFAULT,
  RenewalReauthorisationRequired,
  RenewalRevoked,
} from "./cloud/renewal.js";
import {
  agentSignalPendingStore,
  credentialStore,
  readSecureJsonFile,
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
  archiveKnownGaps,
  clearWorkspaceDefault,
  cloudWorkspaceDirectory,
  DEFAULT_MEMBERSHIP_REVOKED,
  renderStatus,
  renderWorkspaces,
  resolveWorkspace,
  resolveWorkspaceSelector,
  selectWorkspace,
  updateWorkspaceDefaultAfterClose,
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
  ASK_WAIT_TIMEOUT_MESSAGE,
  askCreateFailureMessage,
  askReplyReadFailureMessage,
  askWaitJsonPayload,
  followStopFrame,
  formatFollowFrame,
  isFollowCredentialFailure,
  isRestartableReadError,
  parseWaitSeconds,
  pollForSignals,
  postSignalTargets,
  readAgentSignalPage,
  readAgentSignalDirectory,
  readSignals,
  renderSignalStatus,
  renderSignals,
  resolveRefusalToleranceMs,
  resolveSignalRecipient,
  runInboxFollow,
  settleSignalAuthorLabels,
  settleSignalStatus,
  SIGNAL_READ_TIMEOUT_MS,
  SignalReadTimeoutError,
  signalReadJsonPayload,
  waitDeadlineMs,
  type SignalAuthorLabels,
  type SignalCredential,
  type SignalDirectory,
  type ResolvedSignalRecipient,
} from "./cloud/signals.js";
import {
  arrivalNotification,
  fileArrivalCursorStore,
  formatArrivalNotification,
  runArrivalWatch,
} from "./cloud/arrival-watch.js";
import {
  renderSignalReceiptReport,
  signalReceiptJsonPayload,
} from "./cloud/receipts.js";
import {
  DeliveryReceiptReadError,
  readAgentDeliveryReceipts,
} from "./cloud/delivery-receipts.js";
import { resolveOpenCodeExecutable } from "./host/opencode.js";
import { resolveClaudeExecutable } from "./host/claude.js";
import { resolveCodexExecutable } from "./host/codex.js";
import type { ProviderVersionNotice } from "./host/version.js";
import {
  ClaudeListenerModel,
  CodexListenerModel,
  FileHookSurfaceStore,
  FileListenerEffectStore,
  FilePendingMainQueue,
  GrokListenerModel,
  ListenerStartupError,
  OpenCodeListenerModel,
  effectiveListenerStatus,
  listenerPaths,
  defaultListenerStateDirectory,
  discoverListenerHookPrincipalIds,
  listenerSenderProvenance,
  openListenerDeliveryJournal,
  runListenerRuntime,
  runListenerSupervisor,
  spawnDetachedListener,
  stopListener,
  waitForListenerReady,
  LISTENER_PROMPT_TIMEOUT_MS,
  ListenerRenewalUnavailableError,
  listenerRestartCommand,
  readListenerCredentialState,
  runListenerHookCheck,
  writeListenerCredentialState,
  LISTENER_DEFER_OVER_MAX,
  LISTENER_DEFER_OVER_MIN,
  type ListenerCanaryAttemptCallback,
  type ListenerPermissionMode,
  type ListenerProviderId,
  type ListenerDeliveryJournal,
  type ListenerSenderProvenanceContext,
  type ListenerStatus,
  type ListenerRouteMode,
} from "./listener/index.js";

/**
 * Every flag this build accepts, for ERROR WORDING ONLY — never for acceptance. See the throw in
 * the parser for why that distinction is load-bearing. Kept honest by a gate that reads the
 * usage text and requires every flag printed there to appear here.
 */
const KNOWN_FLAGS = new Set([
  "about", "agent-token-file", "agent-token-stdin", "all-devices", "anon-key", "branch", "capability-id",
  "claude-executable", "codex-executable", "confirm", "cooldown", "cwd", "defer-over", "device-id", "effort", "email",
  "epoch", "evidence", "follow", "force", "force-file-store", "foreground", "grok-executable", "head-sha",
  "help", "include-stale", "include-tombstoned", "invitation-id", "invitation-token-stdin", "json", "kind", "limit",
  "link-stdin", "local", "model", "name", "ndjson", "no-browser", "notify", "opencode-executable", "out",
  "permissions", "principal-id", "provider", "reveal-anon-key", "route", "run-id", "since", "site", "slug",
  "task-id", "to", "token-id", "ttl-ms", "turn-budget", "uid", "until", "url", "version", "wait", "workspace-id", "write",
]);

const BOOLEAN_FLAGS = new Set([
  "agent-token-stdin",
  "all-devices",
  "force-file-store",
  "follow",
  "force",
  "foreground",
  "help",
  "include-stale",
  "include-tombstoned",
  "invitation-token-stdin",
  "json",
  "link-stdin",
  "local",
  "ndjson",
  "notify",
  "no-browser",
  "reveal-anon-key",
  "write",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/* The credential artifact's `message` is validated byte-for-byte below, which makes it a PROTOCOL
 * CONSTANT rather than copy: a site minting a different spelling is unreadable by every cswarm
 * already installed. Measured against the shipped v0.1.15 binary, 2026-08-12.
 *
 * D-088. The current wording claims the credential is "bound to this task … so the agent's work
 * stays scoped". The run binding and attribution are real; the task scope is not. So the honest
 * spelling is ACCEPTED HERE FIRST, in this release, and the site keeps emitting the current one
 * until enough installs carry this build. Reversing that order trades a soft false claim for a hard
 * break. */
const AGENT_CREDENTIAL_MESSAGE =
  "Agent credential minted. It is bound to this task and run so the agent's work stays scoped and attributable.";
const AGENT_CREDENTIAL_MESSAGE_D088 =
  "Agent credential minted. It is bound to this run, so the agent's work is attributable to it.";
const ACCEPTED_AGENT_CREDENTIAL_MESSAGES: readonly string[] = [
  AGENT_CREDENTIAL_MESSAGE,
  AGENT_CREDENTIAL_MESSAGE_D088,
];

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
        /* Wren, 2026-08-10. Every unknown flag reported "--X requires a value", because anything
         * outside BOOLEAN_FLAGS is assumed to take one. So a flag that DOES NOT EXIST was
         * reported as a flag used wrongly, and the user was told to fix their invocation rather
         * than that the thing they typed is not a flag.
         *
         * Found when someone on 0.1.11 tried `--reveal-anon-key`, a flag that only exists on a
         * later build: they were told it "requires a value". Same family as D-080 — the error
         * blames the reader for something that is not their doing. AGENTS.md already records the
         * other cost of this: a control written with a bare `--not-a-real-flag` died in the
         * parser and was passing for the wrong reason.
         *
         * MESSAGING ONLY. The accept path is untouched, so a value-taking flag missing from
         * KNOWN_FLAGS still works exactly as before; the worst a stale list can do is word an
         * error badly. Making the list authoritative for ACCEPTANCE would turn an omission into
         * a broken command, which is a far worse failure than a clumsy sentence. */
        if (!KNOWN_FLAGS.has(name)) {
          throw new Error(
            `unknown option --${name}; run cswarm --help to see the options this version accepts`,
          );
        }
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
const CREDENTIAL_FLAGS = ["agent-token-file", "agent-token-stdin"] as const;
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
  const agentCredential = "[--agent-token-file <path> | --agent-token-stdin]";
  const requiredAgentCredential = "(--agent-token-file <path> | --agent-token-stdin)";
  return `cswarm ${CLI_BUILD_VERSION} (protocol ${CLIENT_PROTOCOL_VERSION})

Usage:
  cswarm login [--url <project-url> --anon-key <key>] [--no-browser]
  cswarm logout [--url <project-url> --anon-key <key>] [--all-devices] [--local]
  cswarm target [show] [--json] [--reveal-anon-key]
  cswarm target set --url <project-url> --anon-key <key> [--json]
  cswarm target clear [--json]
  cswarm status [--url <url> --anon-key <key>] [--workspace-id <uuid>] [--json]
  cswarm whoami ${requiredAgentCredential} [--url <url> --anon-key <key>] [--workspace-id <uuid>] [--json]
  cswarm members [--url <url> --anon-key <key>] [--workspace-id <uuid>] ${agentCredential} [--json]
  cswarm working-on "<what>" [--url <url> --anon-key <key>] [--workspace-id <uuid>] ${agentCredential} [--about <ref>] [--until <dur>] [--json]
  cswarm note "<text>" [--url <url> --anon-key <key>] [--workspace-id <uuid>] ${agentCredential} [--to <member|agent>] [--about <ref>] [--until <dur>] [--json]  # text: 1..8000 characters
  cswarm ask "<text>" [--url <url> --anon-key <key>] [--workspace-id <uuid>] ${agentCredential} [--to <member|agent>] [--about <ref>] [--until <dur>] [--wait <seconds>] [--json]  # text: 1..8000 characters
  cswarm reply <signal-id> "<text>" [--url <url> --anon-key <key>] [--workspace-id <uuid>] ${agentCredential} [--until <dur>] [--json]
  cswarm receipt <signal-id> ${requiredAgentCredential} [--url <url> --anon-key <key>] --workspace-id <uuid> [--json]
  cswarm feed [--url <url> --anon-key <key>] [--workspace-id <uuid>] ${agentCredential} [--about <ref>] [--kind <kind>] [--since <timestamp>] [--limit <n>] [--include-stale] [--json]
  cswarm inbox [--url <url> --anon-key <key>] [--workspace-id <uuid>] ${agentCredential} [--kind <kind>] [--about <ref>] [--since <timestamp>] [--limit <n>] [--include-stale] [--wait <seconds>] [--json]
  cswarm inbox --notify ${requiredAgentCredential} [--url <url> --anon-key <key>] --workspace-id <uuid> [--json]
  cswarm inbox --follow --ndjson [--url <url> --anon-key <key>] [--workspace-id <uuid>] ${agentCredential} [--kind <kind>] [--about <ref>] [--since <timestamp>] [--limit <n>] [--include-stale]
  cswarm file put <local-path> [--name <name>] [--url <url> --anon-key <key>] [--workspace-id <uuid>] ${agentCredential} [--json]
  cswarm file ls [--include-tombstoned] [--url <url> --anon-key <key>] [--workspace-id <uuid>] ${agentCredential} [--json]
  cswarm file get <name|file-id> [--version <n>] [--out <local-path>] [--force] [--url <url> --anon-key <key>] [--workspace-id <uuid>] ${agentCredential} [--json]
  cswarm file rm <name|file-id> [--url <url> --anon-key <key>] [--workspace-id <uuid>] ${agentCredential} [--json]
  cswarm file restore <name|file-id> [--url <url> --anon-key <key>] [--workspace-id <uuid>] ${agentCredential} [--json]
  cswarm feedback "<text>" --kind bug|idea|friction [--about <ref>] [--url <url> --anon-key <key>] [--workspace-id <uuid>] ${agentCredential} [--json]
  cswarm listen start ${requiredAgentCredential} [--url <url> --anon-key <key>] --workspace-id <uuid> --provider grok|opencode|claude|codex [--cwd <absolute-path>] [--model <model>] [--effort <level>] [--permissions deny|allow] [--grok-executable <path>] [--opencode-executable <path>] [--claude-executable <path>] [--codex-executable <path>] [--turn-budget <duration>] [--route worker|main|split] [--defer-over <chars>] [--foreground] [--json]
  cswarm listen status [--url <url> --anon-key <key>] --workspace-id <uuid> --principal-id <uuid> [--json]
  cswarm listen stop [--url <url> --anon-key <key>] --workspace-id <uuid> --principal-id <uuid> [--json]
  cswarm hook check [--principal-id <uuid> ...] [--cooldown <seconds>]
  cswarm hook install claude [--principal-id <uuid>] [--write]
  cswarm hook uninstall claude --write
  cswarm new "<workspace name>" [--url <url> --anon-key <key>] [--json]
  cswarm new --name "<workspace name>" [--url <url> --anon-key <key>] [--json]
  cswarm workspaces [--url <url> --anon-key <key>] [--json]
  cswarm use <full-id|exact-name> [--url <url> --anon-key <key>] [--json]
  cswarm invite [--url <url> --anon-key <key>] [--workspace-id <uuid>] --email <email>
  cswarm invite revoke [--url <url> --anon-key <key>] [--workspace-id <uuid>] --invitation-id <uuid> [--json]
  cswarm member remove <full-user-id|exact-name> --confirm <same-selector> [--url <url> --anon-key <key>] [--workspace-id <uuid>] [--json]
  cswarm workspace close <full-id|exact-name> --confirm <same-selector> [--url <url> --anon-key <key>] [--json]
  cswarm accept --link-stdin [--name <name>] [--no-browser] [--json]
  cswarm accept <https://...#invite=...|cswarm://accept/...> [--name <name>] [--no-browser] [--json]  # unsafe: shell history/process list
  cswarm accept --invitation-token-stdin [--url <url> --anon-key <key>]
  cswarm accept <invitation-token> [--url <url> --anon-key <key>]  # unsafe: shell history/process list
  cswarm principal create [--url <url> --anon-key <key>] [--workspace-id <uuid>] --name <name>
  cswarm principal revoke [--url <url> --anon-key <key>] [--workspace-id <uuid>] --principal-id <uuid>
  cswarm token mint [--url <url> --anon-key <key>] [--workspace-id <uuid>] --principal-id <uuid> --run-id <uuid> --task-id <uuid> --epoch <n> [--ttl-ms <ms>]
  cswarm token revoke [--url <url> --anon-key <key>] [--workspace-id <uuid>] --token-id <uuid>
  cswarm token revoke ${requiredAgentCredential} [--url <url> --anon-key <key>] --workspace-id <uuid> [--token-id <uuid>]
  cswarm link new [--url <url> --anon-key <key>] [--workspace-id <uuid>] --task-id <uuid> [--ttl-ms <ms>] [--site <origin>] [--json]
  cswarm link revoke [--url <url> --anon-key <key>] [--workspace-id <uuid>] --capability-id <uuid> [--json]
  cswarm command <kind> [--url <url> --anon-key <key>] [--workspace-id <uuid>] ${agentCredential} [command fields]
  cswarm dogfood [--url <url> --anon-key <key>] [--workspace-id <uuid>] ${agentCredential} --slug <slug> --branch <branch> --head-sha <sha> --evidence <ref>
  cswarm seed-fixture --uid <auth-user-uuid> [--device-id <uuid>] [--workspace-id <uuid>]

Credential selection for command/dogfood:
  default                 refresh the human login from secure storage
  --agent-token-file      read the credential from an owned 0600 regular file in an owned
                          0700 directory. The path may appear in argv; the secret never does.
  --agent-token-stdin     read a mint/seed credential artifact, or a bare swm_agt_ token, from
                          stdin. WHICH FORMS ARE ACCEPTED DEPENDS ON WHAT THE SUBCOMMAND DOES
                          WITH THE CREDENTIAL. A subcommand that only reads takes either form.
                          One that persists or references the credential needs the complete
                          JSON artifact, because it needs a field a bare secret does not carry:
                            whoami        reads server-proven identity -- complete or bare form
                            members       reads only          -- either form
                            working-on, note, ask, reply, feed, inbox
                                          signal command/read only         -- either form
                            receipt       reads only          -- either form
                            inbox --notify persists a per-agent cursor -- needs principal_id
                            file put, file ls, file get, file rm, file restore
                                          read and command, nothing persisted -- either form
                            feedback      command only, nothing persisted     -- either form
                            command, dogfood
                                          task protocol commands              -- either form
                            listen start  persists durable state, rotates -- needs expires_at
                            hook check    reads only the selected listener's owned 0600 credential state;
                                          never accepts or prints a credential
                            hook install/uninstall
                                          edits only local Claude Code settings; no credential
                            token revoke  names what it revokes           -- needs token_id
                            workspace close is human-session-only; it never accepts an agent token

Found a bug or missing feature in cswarm itself? cswarm feedback sends it to the
deployment's operators — agents are encouraged to report friction they hit.

Signals (intention sharing) accept the same credential selection. Agent mode
never opens a browser or infers a human's saved workspace. Durations use a whole
number plus m, h, or d (for example 90m, 24h, or 7d) and are capped at 30d.
Place -- before signal text that itself begins with -- to stop option parsing.
Signal text is at most 8000 characters and --about at most 500; a longer body is
refused locally before any network call, so compose within the limit.

listen start --turn-budget bounds ONE worker prompt turn (default 10m): how long
the worker may think and use tools on a single message before the turn times out
and durable delivery retries it. A whole number plus s, m, or h (for example
90s, 5m, 1h), at least 30s and at most 60m. Each turn is additionally clamped
to the live credential's remaining lifetime minus 60s, after renewing it when
due — a turn never outlives its credential. Right after a rotation the full
budget is available up to the token TTL minus 60s (about 59m on the default 1h
TTL); a turn that lands just before a rotation can be clamped to the ~5m
renewal lead, and if it times out there, durable delivery retries it on the
fresh credential.

listen start --route worker|main|split chooses where directed messages go. worker
is the unchanged default. main queues every ask or note for the interactive session.
split queues messages whose body is longer than --defer-over <chars>; the bound is
1..10000 and an equal-length message stays on the worker path. Run cswarm hook check
--principal-id <uuid> to surface that agent's queued messages. A bare check works only
when the state directory holds one principal. hook check has its own 3s ceiling, exits 0
on every outcome, and skips network checks made within --cooldown seconds (default 30).
hook install claude prints principal-scoped UserPromptSubmit JSON by default and changes
the project's .claude/settings.json only with --write; uninstall also requires --write.

Invite, legacy token accept, principal create/revoke, human token mint/revoke, link, new, and workspace close require a
stored human login. Agent self-surrender of a token uses --agent-token-file or --agent-token-stdin and never takes the secret on argv. Invite-link accept signs in when needed, then accepts and
registers one principal. Invitation links, agent credentials, and capability links
appear only in fresh success responses.

cswarm link new hands someone a browser link to ONE work item before they install
anything. It shows that item's name and state, the repository it belongs to, who
invited them, and how long the workspace has existed — and reaches nothing else, not
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
be set with SWARM_CLOUD_WORKSPACE_ID. cswarm new starts a workspace of your own
(a name of 1 to 80 characters) and selects it; whether a deployment accepts that
is a setting on the deployment, and an invite link is the other way in.
Normal workspace selection is:
cswarm workspaces, then cswarm use <full-id|exact-name>. A sole accepted
workspace is saved automatically; ambiguous names require the full id and CommonSwarm
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
  const mode = hasAgentCredential(args) ? "agent" : "human";
  try {
    return await resolveCloudTarget({
      explicitUrl: args.optional("url"),
      explicitAnonKey: args.optional("anon-key"),
      environmentalUrl: process.env.SWARM_CLOUD_URL,
      environmentalAnonKey: process.env.SWARM_CLOUD_ANON_KEY,
      mode,
    });
  } catch (error) {
    /* F-1. A cold self-serve user has no target and no way to get one: they hold no invite link,
     * "whoever runs this deployment" is themselves, and they created no Supabase project. The
     * deployment publishes its own target on the host they installed from, so ask it.
     *
     * Narrow on purpose. Only when NOTHING supplied a URL — an explicit flag, the environment, or
     * a saved target — so this can never override a choice the user made, and never redirect a
     * command that was merely missing its anon key. Agent mode is excluded because agent
     * credentials deliberately do not inherit a human's target. */
    if (
      mode !== "human" ||
      args.optional("url") !== undefined ||
      process.env.SWARM_CLOUD_URL !== undefined ||
      (await readCurrentTarget()) !== null
    ) {
      throw error;
    }
    const discovered = await discoverCloudTarget();
    /* Rethrow the ORIGINAL error, which describes the user's situation, rather than one about
     * our network. */
    if (discovered === null) throw error;
    await writeCurrentTarget(discovered);
    /* stderr, so this never contaminates --json on stdout. Announced rather than silent: the CLI
     * just chose where this machine sends its traffic, and the user is entitled to know which
     * deployment and how to change it. */
    process.stderr.write(
      `Using the CommonSwarm deployment at ${discovered.url}, discovered from ${
        process.env.CSWARM_SITE ?? DEFAULT_SITE_ORIGIN
      } and saved. Change it with cswarm target set, or point CSWARM_SITE at your own deployment.\n`,
    );
    return discovered;
  }
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
    !ACCEPTED_AGENT_CREDENTIAL_MESSAGES.includes(artifact.message as string) ||
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

type AgentTokenFileErrorCode =
  | "agent_token_file_missing"
  | "agent_token_file_unreadable";

/** Gives automation a stable reason when a credential file cannot be consumed. */
class AgentTokenFileError extends Error {
  readonly name = "AgentTokenFileError";

  constructor(readonly code: AgentTokenFileErrorCode, message: string) {
    super(`[${code}] ${message}`);
  }
}

function hasAgentCredential(args: Arguments): boolean {
  return CREDENTIAL_FLAGS.some((flag) => args.has(flag));
}

/** Select exactly one secret channel and keep the secret itself out of argv and env. */
async function agentCredential(
  args: Arguments,
  options: { implicitStdin?: boolean } = {},
): Promise<AgentCredentialInput> {
  const fromFile = args.optional("agent-token-file");
  const fromStdin = args.has("agent-token-stdin");
  if (fromFile !== undefined && fromStdin) {
    throw new Error(
      "use exactly one agent credential source: --agent-token-file or --agent-token-stdin",
    );
  }
  if (fromFile !== undefined) {
    let value: string | null;
    try {
      /* Reuse the listener/profile reader: owned regular file, 0600, bounded read, and an
       * owned 0700 parent directory. This flag does not create, chmod, or repair secrets. */
      value = await readSecureJsonFile(fromFile, 4096);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown read failure";
      throw new AgentTokenFileError(
        "agent_token_file_unreadable",
        `could not read --agent-token-file securely: ${detail}`,
      );
    }
    if (value === null) {
      throw new AgentTokenFileError(
        "agent_token_file_missing",
        `--agent-token-file does not exist: ${fromFile}`,
      );
    }
    return parsedAgentCredential(value.trim());
  }
  if (fromStdin || options.implicitStdin === true) {
    return await stdinCredential();
  }
  throw new Error(
    "provide the agent credential with --agent-token-file <path> or --agent-token-stdin",
  );
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
    `Selected workspace ${selected.name} (${selected.workspace_id}). Later commands will use it unless --workspace-id or SWARM_CLOUD_WORKSPACE_ID overrides it.`;
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
      "give the workspace name once: as a positional or as --name, not both",
    );
  }
  args.assertShape([...TARGET_FLAGS, "name", "json"], named ? 1 : 2);
  // Validated before any credential or network work, so a typo costs one line.
  const name = (named ? args.required("name") : args.positionals[1]!).trim();
  assertWorkspaceName(name);
  const cloud = await target(args);
  const human = await humanCredential(args, cloud);
  // The id is ours: the workspace has no route to be addressed by until it exists,
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
        `${error.message}; run cswarm workspaces to see whether the workspace exists before creating it again`,
      );
    }
    throw error;
  }
  const response = acceptedConnect("workspace creation", result);
  const created = uuid(response.workspace_id, "workspace_id");
  if (created !== proposedId) {
    throw new Error(
      "the server confirmed a different workspace than this command created; run cswarm workspaces before doing anything else",
    );
  }
  await writeWorkspaceDefault(human.store, human.userId, created);
  const message =
    `Created workspace ${name} (${created}). It is now your selected workspace, so later commands will use it unless --workspace-id or SWARM_CLOUD_WORKSPACE_ID overrides it.`;
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
    /* D-079: `--reveal-anon-key` is opt-in. Agent credentials never inherit a human's saved
     * target, and that refusal names --url/--anon-key — so without this flag the CLI demanded a
     * value no command returned, and an agent on a second machine satisfied it by reading
     * ~/.cswarm/credentials.d/ directly. The key is public (RLS-protected, and published in a
     * meta tag on every page of commonswarm.com), so there is no secret to withhold; the default
     * stays fingerprinted only so a 208-character JWT does not land in logs by accident. */
    args.assertShape(
      ["json", "reveal-anon-key"],
      args.positionals[1] === undefined ? 1 : 2,
    );
    const reveal = args.has("reveal-anon-key");
    const saved = await readCurrentTarget();
    if (args.has("json")) {
      printJson({
        current_target: saved === null ? null : currentTargetSummary(saved, reveal),
      });
      return;
    }
    if (saved === null) {
      process.stdout.write(
        "No current Cloud target is saved. Start with cswarm accept --link-stdin, or run cswarm target set --url https://api.commonswarm.com --anon-key <key> for the hosted service (the anon key is public, in the meta tags at https://commonswarm.com/start); a self-hosted deployment uses its own URL and key.\n",
      );
      return;
    }
    const summary = currentTargetSummary(saved, reveal);
    process.stdout.write(
      `Current Cloud target: ${summary.url}\nAnon key fingerprint: ${summary.anon_key_fingerprint}\n`
          + (summary.anon_key === undefined
            ? ""
            : `Anon key: ${summary.anon_key}\n`),
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
      "You're not in any workspaces yet. Ask a colleague to send you an invitation link, then accept it with cswarm accept --link-stdin.";
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
      `You: ${identityLabel} (${human.userId})\nYou're not in any workspaces yet.\nAsk a colleague to send you an invitation link, then accept it with cswarm accept --link-stdin.\n`,
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
  /* `--json` is accepted and has no effect: this verb's receipt is already JSON on stdout,
   * with narration on stderr. It is allowed because refusing it was a trap — `--json` works
   * on status/feed/inbox/workspaces/listen-status, so a caller reasonably assumes it works
   * here, and `mint --json > cred.json` left an EMPTY file (shell truncation, then a failed
   * command writing nothing to stdout). See D-064. */
  /* `cswarm invite revoke` — D-069.
   *
   * An invitation is a bearer capability with a TTL of up to seven days, and until now it was
   * the ONLY capability in this product that could not be withdrawn: `principal revoke`,
   * `token revoke` and `link revoke` all exist. The reducer and the command edge have supported
   * `revoke_invitation` all along (9 references in the edge, 0 in this file) — nothing reached
   * it. So a link that was forwarded, pasted into a chat, or read over a shoulder had no remedy
   * at all.
   *
   * Client-only: no edge deploy, nothing near the D-047 freeze. */
  if (args.positionals[1] === "revoke") {
    args.assertShape(
      [...TARGET_FLAGS, "workspace-id", "invitation-id", "json"],
      2,
    );
    const cloud = await target(args);
    const human = await humanCredential(args, cloud);
    const workspace = await workspaceId(args, cloud, human);
    const invitationId = args.required("invitation-id");
    const revoked = (
      await sendConnectWithPending(
        new ThinCommandClient(cloud),
        human,
        workspace,
        { kind: "revoke_invitation", invitation_id: invitationId },
      )
    ).response;
    if (revoked.status !== "accepted") {
      /* Report the refusal and DO NOT infer what it implies about the link. The obvious
       * wording — "anyone holding the link can still use it" — is false for the commonest
       * refusal: `invitation_not_live` means the invitation was already accepted or revoked, so
       * the link is dead and the sentence would tell an operator to panic about a spent
       * capability. Naming a consequence the refusal does not establish is exactly the
       * cause-splitting that produced three defects on the logout path (D-060). */
      throw new Error(
        `The invitation was not revoked: ${
          revoked.reason ?? "required condition not met"
        }.`,
      );
    }
    const output = {
      message:
        "Invitation revoked. The link no longer works, and anyone who already accepted it stays a member — remove them with cswarm member remove.",
      status: revoked.status,
      invitation_id: invitationId,
      command_event_ids: revoked.event_ids,
    };
    if (args.has("json")) printJson(output);
    else process.stdout.write(`${output.message}\n`);
    return;
  }
  args.assertShape([...TARGET_FLAGS, "workspace-id", "email", "json"], 1);
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
      `Removed ${selected.name} (${selected.user_id}) from this workspace. Their access to other workspaces was not changed.`,
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

async function runWorkspace(args: Arguments): Promise<void> {
  args.assertShape([...TARGET_FLAGS, "confirm", "json"], 3);
  if (args.positionals[1] !== "close") {
    throw new UsageError(
      `unknown workspace command: ${args.positionals[1] ?? "(missing)"}`,
    );
  }
  const selector = args.positionals[2]!;
  if (args.required("confirm") !== selector) {
    throw new Error(
      "--confirm must exactly repeat the workspace selector; no request was sent",
    );
  }
  const cloud = await target(args);
  const human = await humanCredential(args, cloud);
  const directory = cloudWorkspaceDirectory(cloud);
  const projects = await directory.list(human);
  const selected = resolveWorkspaceSelector(selector, projects);
  const response = (
    await sendConnectWithPending(
      new ThinCommandClient(cloud),
      human,
      selected.workspace_id,
      { kind: "archive_workspace" },
    )
  ).response;
  if (response.status !== "accepted") {
    throw new Error(
      `Workspace close was rejected: ${
        response.reason ?? "domain rejection"
      }. The workspace is still open.`,
    );
  }

  const { closedWasSelected, nextWorkspace, selectedWorkspaceId } =
    await updateWorkspaceDefaultAfterClose(
      human.store,
      human.userId,
      selected.workspace_id,
      projects,
    );
  const message = nextWorkspace
    ? `Closed workspace ${selected.name} (${selected.workspace_id}). It is hidden for everyone, and ${nextWorkspace.name} (${nextWorkspace.workspace_id}) is now selected.`
    : closedWasSelected
    ? `Closed workspace ${selected.name} (${selected.workspace_id}). It is hidden for everyone. No live workspace remains, so the selected workspace was cleared.`
    : `Closed workspace ${selected.name} (${selected.workspace_id}). It is hidden for everyone. Your selected workspace was not changed.`;
  const output = {
    message,
    status: response.status,
    workspace_id: selected.workspace_id,
    selected_workspace_id: selectedWorkspaceId,
    command_event_ids: response.event_ids,
  };
  if (args.has("json")) printJson(output);
  else process.stdout.write(`${message}\n`);
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
      "accept expects one https://...#invite=<payload> link, cswarm://accept/<payload>, or swm_inv_ invitation capability",
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
    /* `--json` accepted, no effect — see the note on `runInvite`. D-064. */
    args.assertShape([...TARGET_FLAGS, "workspace-id", "name", "json"], 2);
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
        /* The visibility sentence is Verity's, and it is the whole fix for the disclosure it
         * found: every member can see every agent's NAME via `cswarm members`. Concealing them
         * is not an option — addressing depends on them — so the remedy is saying so at the one
         * moment a person chooses the name. Names like `wake-replier` or `uxtest-fixture-r1`
         * disclose what someone has been working on, and eventually one will name a customer or
         * an unreleased feature. */
        "Agent identity created. It makes this machine's agent auditable inside the shared workspace. Its name is visible to everyone in the workspace, so avoid naming it after anything private.",
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
      /* `--json` accepted, no effect — see the note on `runInvite`. D-064. */
      "json",
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
              maximum: 2_592_000_000,
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
    describeMintRenewal(
      expiresAt !== null,
      Math.round(horizonMs / 86_400_000),
    ),
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
  // Agent self-surrender accepts both --agent-token-file and the existing --agent-token-stdin.
  if (hasAgentCredential(args)) {
    args.assertShape(
      [...TARGET_FLAGS, "workspace-id", "token-id", ...CREDENTIAL_FLAGS, "json"],
      2,
    );
    const cloud = await target(args);
    const agent = await agentCredential(args);
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
        "agent credential has no token_id; use the JSON artifact from token mint, not a bare secret",
      );
    }
    const requested = args.optional("token-id");
    if (requested !== undefined && requested.toLowerCase() !== agent.tokenId) {
      throw new Error(
        "token-id does not match the credential; no request was sent",
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
 * Opens the renewing session for a credential supplied through a secret channel (§2.3).
 *
 * The lineage key is derived from the credential the caller presented, so the successor
 * this run obtains is found again by the next run — which is the whole point: a one-shot
 * CLI that forgot its successor would be back at the bootstrap-expiry wall. When the store cannot
 * be opened (a read-only home directory, a hostile umask) renewal still happens, it just
 * does not outlive the process, and the caller is told so rather than left to find out at
 * expiry.
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
  if (hasAgentCredential(args)) {
    if (override === null) {
      throw new Error(
        "not logged in; agent credentials require --workspace-id or SWARM_CLOUD_WORKSPACE_ID because they never infer a human's workspace selection",
      );
    }
    const agent = await agentCredential(args);
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

/**
 * One worker prompt turn's budget. Default is LISTENER_PROMPT_TIMEOUT_MS; the
 * floor keeps a typo from making every turn time out instantly, and the cap
 * keeps a wedged worker from holding a claimed signal for hours.
 */
function listenerTurnBudgetMs(value: string | undefined): number {
  if (value === undefined) return LISTENER_PROMPT_TIMEOUT_MS;
  const match = /^([1-9]\d*)(s|m|h)$/.exec(value);
  if (!match) {
    throw new Error("--turn-budget must be a duration such as 90s, 5m, or 1h");
  }
  const unit = match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000;
  const milliseconds = Number(match[1]) * unit;
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 30_000 ||
    milliseconds > 3_600_000
  ) {
    throw new Error("--turn-budget must be between 30s and 60m");
  }
  return milliseconds;
}

/** Parse the public route pair before credentials or network work. */
export function listenerRouteConfiguration(
  routeValue: string | undefined,
  deferOverValue: string | undefined,
): { routeMode: ListenerRouteMode; deferOverChars: number | null } {
  const routeMode = routeValue ?? "worker";
  if (routeMode !== "worker" && routeMode !== "main" && routeMode !== "split") {
    throw new Error("--route must be worker, main, or split");
  }
  if (routeMode !== "split") {
    if (deferOverValue !== undefined) {
      throw new Error("--defer-over is only valid with --route split");
    }
    return { routeMode, deferOverChars: null };
  }
  if (deferOverValue === undefined) {
    throw new Error("--route split requires --defer-over <chars>");
  }
  if (!/^\d+$/.test(deferOverValue)) {
    throw new Error(
      `--defer-over must be an integer from ${LISTENER_DEFER_OVER_MIN} to ${LISTENER_DEFER_OVER_MAX}`,
    );
  }
  const deferOverChars = Number(deferOverValue);
  if (
    !Number.isSafeInteger(deferOverChars) ||
    deferOverChars < LISTENER_DEFER_OVER_MIN ||
    deferOverChars > LISTENER_DEFER_OVER_MAX
  ) {
    throw new Error(
      `--defer-over must be an integer from ${LISTENER_DEFER_OVER_MIN} to ${LISTENER_DEFER_OVER_MAX}`,
    );
  }
  return { routeMode, deferOverChars };
}

/** Post-turn work (the ack, the reply post, the renewal request itself) must fit between turn end and credential expiry. */
export const TURN_BUDGET_CREDENTIAL_MARGIN_MS = 60_000;

/**
 * Bound one worker turn to the live credential's remaining lifetime.
 *
 * ★ Invariant: a worker turn never starts with a budget the live credential
 * cannot outlast. Renewal runs in bearer(), which nothing calls during a
 * prompt, so an unclamped turn longer than the credential's remaining life
 * ends with the listener stopped as credential loss
 * (predecessor_expired_local) because of a timeout setting. The floor keeps
 * the clamp recoverable rather than protective-in-name-only: a turn bounded
 * at 1s fails as the timeout class and is durably redelivered, where
 * outliving the credential stops the listener.
 */
export function clampTurnBudgetToCredential(
  budgetMs: number,
  credentialExpiresAt: number | null,
  nowMs: number,
): number {
  if (credentialExpiresAt === null) return budgetMs;
  const horizonMs = credentialExpiresAt - nowMs - TURN_BUDGET_CREDENTIAL_MARGIN_MS;
  return Math.max(1_000, Math.min(budgetMs, horizonMs));
}

/**
 * Decide one worker turn's budget, or refuse to start it.
 *
 * ★ Invariant: a turn starts ONLY with a credential proven to outlast it. Two
 * conditions defer the turn instead of attempting it — renewal FAILED at turn
 * start (`renewalFailed`), or the live credential's remaining lifetime is
 * already inside the rotation margin. Both throw
 * ListenerRenewalUnavailableError, a recoverable class the durable claim/ack
 * layer redelivers once rotation recovers. The 1s floor in
 * clampTurnBudgetToCredential is therefore reachable ONLY for a LIVE credential
 * whose remaining life is just over the margin (rotation-due-soon) — never for
 * a failed rotation or a credential already inside the margin, because those
 * throw before the clamp runs.
 */
export function resolveTurnBudgetOrDefer(
  configuredBudgetMs: number,
  credentialExpiresAt: number | null,
  nowMs: number,
  renewalFailed: boolean,
): number {
  if (renewalFailed) {
    throw new ListenerRenewalUnavailableError(
      "the worker credential could not be renewed before this turn; deferring the ask for durable redelivery",
    );
  }
  if (
    credentialExpiresAt !== null &&
    credentialExpiresAt - nowMs <= TURN_BUDGET_CREDENTIAL_MARGIN_MS
  ) {
    throw new ListenerRenewalUnavailableError(
      "the live worker credential is inside its rotation margin and was not renewed; deferring the ask for durable redelivery",
    );
  }
  return clampTurnBudgetToCredential(configuredBudgetMs, credentialExpiresAt, nowMs);
}

/* Signal body / --about caps, mirrored by the DB CHECK in the signals migration
 * (char_length(body) BETWEEN 1 AND 8000; about <= 500). Hardcoded in several
 * places (file-store.ts, signals.ts) — no shared module across the protocol
 * boundary; if the DB cap moves, grep 8000/500 for the signal body/about. Named
 * here so the usage text below and the validator cannot drift from each other. */
const SIGNAL_BODY_MAX = 8000;
const SIGNAL_ABOUT_MAX = 500;

function signalText(value: string, label: "body" | "about"): string {
  const maximum = label === "body" ? SIGNAL_BODY_MAX : SIGNAL_ABOUT_MAX;
  if (value.length < (label === "body" ? 1 : 0) || value.length > maximum) {
    if (label === "body") {
      throw new Error(
        `signal text is ${value.length} characters; the maximum is ${maximum}`,
      );
    }
    throw new Error(
      `--about must be at most ${maximum} characters`,
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
  let recipient: ResolvedSignalRecipient | null = null;
  if (toSelector !== undefined) {
    let directory: SignalDirectory;
    try {
      directory = await signalDirectory(
        cloud,
        credential.selectedWorkspace,
        credential,
      );
    } catch (error) {
      if (kind === "ask") {
        throw new Error(
          askCreateFailureMessage(credential.selectedWorkspace, error),
        );
      }
      throw error;
    }
    recipient = resolveSignalRecipient(toSelector, directory);
  }
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
  let result: PostSignalResult;
  try {
    result = await postSignalCommand(cloud, credential, command);
  } catch (error) {
    if (kind === "ask") {
      throw new Error(
        askCreateFailureMessage(credential.selectedWorkspace, error),
      );
    }
    throw error;
  }
  const signal = result.response.signal!;

  if (waitSeconds !== undefined) {
    const credentialForRead = signalCredentialOf(credential);
    const deadlineMs = waitDeadlineMs(waitSeconds);
    let waitResult;
    try {
      waitResult = await pollForSignals({
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
    } catch (error) {
      throw new Error(
        askReplyReadFailureMessage(credential.selectedWorkspace, error),
      );
    }
    const reply = waitResult.signals[0] ?? null;
    if (args.has("json")) {
      printJson({
        ...askWaitJsonPayload(signal, reply, waitResult.timedOut),
        retried: result.retried,
        attempts: result.attempts,
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
    if (waitResult.timedOut || reply === null) {
      process.stdout.write(
        `${ASK_WAIT_TIMEOUT_MESSAGE}\n${
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
      retried: result.retried,
      attempts: result.attempts,
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
  const audience = describeAudience(signal, authors);
  /* A NOTE AIMED AT AN AGENT REACHES THEIR CHANNEL, NOT THEIR MODEL, and until now nothing said
   * so. A listener turns an ASK into a model turn; a note is recorded and wakes no one.
   *
   * Measured 2026-08-11 by two agents dogfooding on a laptop: one posted the rules of a game as a
   * note and opened with an ask; the far agent answered that it held no context. Its report is
   * the reason this line exists — "this fails silently and looks like the far agent being
   * uncooperative rather than sandboxed". The sender had no way to learn otherwise.
   *
   * Only for a note directed AT AN AGENT. A broadcast note is for people reading the channel and
   * is behaving exactly as intended, so warning there would be noise on the common case. */
  const noteAtAgent = kind === "note" && recipient !== null &&
    recipient.kind === "agent";

  /* THE ANNOUNCE RACE. The product's whole claim is "post before you begin so nobody starts the
   * same work twice", and the one window it could not cover was the join itself: two agents each
   * read the feed, each saw nothing, and each announced the same work seconds apart. Measured
   * 2026-08-11 — two agents onboarded a minute apart both posted "joining, standing up a
   * listener", and one of them noticed only because it re-read the feed afterwards and said so.
   *
   * A read-then-post gap cannot be closed by ordering; there is no lock and there should not be
   * one. What CAN be done is to close the loop AFTER the write: having just posted, look back
   * over the window you could not have seen, and say what landed in it.
   *
   * Scoped to working-on, which is the verb that makes a claim about what you are about to do.
   * Best-effort: a failure here must not fail the post, which has already succeeded. */
  let raced: readonly SignalRecord[] = [];
  if (kind === "working-on") {
    const since = new Date(Date.parse(signal.created_at) - 120_000).toISOString();
    raced = await readSignals(cloud, signalCredentialOf(credential), {
      workspaceId: credential.selectedWorkspace,
      inbox: false,
      kind: "working-on",
      since,
      includeStale: false,
      limit: 10,
    }).then(
      (rows) => rows.filter((row) => row.id !== signal.id && row.from !== signal.from),
      () => [],
    );
  }
  process.stdout.write(
    `Signal shared. It is immutable and ${audience}.\n${renderSignals([signal], {
      inbox: false,
      includeStale: true,
      authors,
    })}\n${
      noteAtAgent
        ? "\nThis note is in their channel, but it does NOT wake their agent — only an ask does.\nIf they need to act on it, send it again with: cswarm ask \"<text>\" --to <agent>\n"
        : ""
    }${
      raced.length === 0 ? "" : `\nSomeone else announced in the two minutes before you, which you could not have seen when you read the feed:\n${
        renderSignals(raced, { inbox: false, includeStale: true, authors })
      }\nCheck whether you are about to do the same work.\n`
    }`,
  );
}

/**
 * The reply verb refusal message. Exported and pure so it is unit-testable without a
 * full CLI spawn. A 403 on REPLY means the referenced signal is not one this caller may
 * answer — the audience is derived server-side and a reply is accepted only when the
 * referenced signal was addressed TO the caller. The most common way to hit it is
 * replying to your OWN ask (you addressed it to someone else, so you are not its
 * addressee). Classify on the typed HTTP status, never the message (D-053). Returns null
 * for anything that is not this case, so the original error propagates unchanged.
 * Added for the Fastio feedback 2026-08-19: the bare "HTTP 403 forbidden" gave no next step.
 */
export function replyRefusalHint(error: unknown): string | null {
  if (!(error instanceof CommandHttpError) || error.status !== 403) return null;
  /* A 403 on this path is NOT always "you are not the addressee": the same status carries
   * revoked credentials, non-membership, and other authorization refusals (the inversion arm
   * on the Fastio fix round found the hint firing on all of them, which is misleading advice
   * — the D-053 family one level up: right status, wrong CAUSE). So the hint is phrased as a
   * possibility with the other causes named, never as a diagnosis. If the server ever
   * distinguishes this refusal with its own code, branch on that code instead and drop the
   * hedging — the hedge exists only because the status is ambiguous today. */
  return "reply was refused (403). The most common cause is that the signal was not addressed " +
    "to you — you cannot reply to your own ask; reply to the other party's signal, reach " +
    "someone directly with cswarm ask --to <agent>, or post a channel-visible cswarm note. " +
    "If you did receive that signal, the refusal is an authorization one instead: the " +
    "credential may be revoked or expired, or it may not be a member of this workspace.";
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
  let result;
  try {
    result = await postSignalCommand(cloud, credential, command);
  } catch (error) {
    /* A 403 on the REPLY verb specifically means the referenced signal is not one this
     * caller may answer — the audience is derived server-side and a reply is accepted only
     * when the referenced signal was addressed TO the caller (command/index.ts reply target
     * resolution). The most common way to hit it is replying to your OWN ask: you addressed
     * that ask to someone else, so you are not its addressee. Classify on the typed HTTP
     * status, never the message (D-053); the bare "HTTP 403 forbidden" gave the reader
     * nowhere to go (Fastio feedback 2026-08-19). */
    const hint = replyRefusalHint(error);
    if (hint !== null) throw new Error(hint);
    throw error;
  }
  const signal = result.response.signal!;
  if (args.has("json")) {
    printJson({
      status: result.response.status,
      message:
        "Reply shared. It is immutable, tenancy-scoped, and will quietly expire at its horizon.",
      signal,
      retried: result.retried,
      attempts: result.attempts,
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

/**
 * The roster, for whoever is asking — including an agent. D-062.
 *
 * `status` already showed all of this, and refused `--agent-token-stdin` at its shape gate,
 * so the party that needs a roster to address a signal was the one party that could not read
 * one. That cost twenty hours: a principal named `Wren` existed, `--to Wren` resolved to it,
 * and no supported command could show that it was not the Wren we meant.
 *
 * This is deliberately NOT `status --agent-token-stdin`. `runStatus` is built on
 * `humanCredential` throughout — `human.userId`, `human.deviceId`, `profileIdentity(human)` —
 * and speaks as "You:". Widening its gate would move the failure deeper, not fix it.
 *
 * Nothing new is fetched: `signalDirectory` already served both credential kinds, and the
 * deployed `read` edge function already answers `resource: "members"` with `{members, agents}`
 * for an agent token. This verb only shows what the CLI was already reading to resolve `--to`.
 * So it needs no edge deploy, and stays clear of the D-047 freeze.
 */
/**
 * Say who a signal actually went to, by name AND id. D-062.
 *
 * `--to <name>` is resolved server-side and the resolved id came back in `to_agent` on every
 * send — but only under `--json`, so nobody read it. A principal named `Wren` existed, was not
 * the Wren anyone meant, and three agents spent about twenty hours on that with the answer
 * sitting in every response object they had already received.
 *
 * Exported for the gate: this is a claim a user reads, so it is worth pinning as a pure value
 * rather than only observing it against a live deployment.
 *
 * **What this does and does not do.** It surfaces the resolved id at the moment of sending, so a
 * mismatch becomes visible the instant anyone knows the id they meant. It does NOT tell you the
 * id is wrong — nothing here can, because the send is well-formed and the server resolved
 * exactly what was asked. Enumerating (`cswarm members`) is the other half.
 *
 * The id is printed even when the name is known, because the id is the addressable identity:
 * names are unique per workspace, but a name you did not create can belong to someone you did
 * not mean. When the directory does not know the recipient the bare id is printed rather than a
 * guessed label — a wrong name here would be worse than no name, which is the defect itself.
 */
export function describeAudience(
  signal: { to: string | null; to_agent: string | null },
  authors: SignalAuthorLabels,
): string {
  const recipientId = signal.to_agent ?? signal.to;
  if (recipientId === null) return "visible to members of this workspace";
  const name = signal.to_agent !== null
    ? authors.agents.get(signal.to_agent)
    : authors.users.get(recipientId);
  return `visible only to ${
    name === undefined ? recipientId : `${name} (${recipientId})`
  }`;
}

/**
 * The roster as a user reads it. Pure, so the CLAIMS it makes can be gated. FM-1.
 */
export function renderRoster(
  directory: SignalDirectory,
  memberNames: ReadonlyMap<string, string>,
): string {
  /* FM-1, found by Verity: an EMPTY roster is ambiguous and must not be reported as emptiness.
   *
   * The read edge answers a workspace this credential is not scoped to with
   * `200 {members: [], agents: []}` — deliberately, because a 403 would be a workspace-existence
   * oracle. That is right on the server. What was wrong was this command translating it into
   * "nobody yet", which asserts the workspace is empty and is exactly the confident zero this
   * repo's doctrine exists to prevent. Caught in the verb built to stop people manufacturing
   * zeros, by a non-author, which is the argument for non-author review in one line.
   *
   * The ambiguity is only total when BOTH lists are empty. If people are visible, an empty agent
   * list is genuinely empty — you are demonstrably scoped to the workspace — so "none yet" stays
   * true there and is kept. */
  const lines: string[] = [];
  if (directory.members.length === 0 && directory.agents.length === 0) {
    /* Say which. FM-1 first said "this command cannot tell you which" — TRUE-sounding and FALSE,
     * caught by Verity within hours of it shipping in 0.1.10.
     *
     * A workspace can never have zero members, and the protocol enforces that as an INVARIANT
     * rather than a rule: `WorkspaceCreated` seeds `owners_count: 1`; the reducer raises
     * `StreamIntegrityError` — a corrupt stream, not a refused command — if the live owner count
     * drops below one; the last owner can be neither removed nor demoted; and no leave or
     * self-remove command exists at all. The read edge selects every live member of the
     * workspace, gated on `is_member`. So an empty roster cannot mean "empty workspace". It means
     * this credential is not scoped, with certainty.
     *
     * AND SAYING SO LEAKS NOTHING, which is the part the first attempt got backwards. There are
     * two ambiguities and it conflated them:
     *   EXISTENCE — must stay hidden. Preserved: this sentence is IDENTICAL whether the workspace
     *               does not exist or exists without you.
     *   SCOPE     — the caller's own state. Safe to state, and the only actionable half.
     * The first fix protected existence by also hiding scope. Scope never needed hiding. */
    return (
      "This credential is not scoped to that workspace.\n\n"
        + "That is all this command can tell you: the answer is the same whether the workspace does\n"
        + "not exist or exists without you. Asking about a workspace must not reveal whether it is\n"
        + "real, so the two are deliberately indistinguishable.\n"
    );
  }
  lines.push("People:");
  if (directory.members.length === 0) {
    lines.push("- nobody yet");
  }
  for (const member of directory.members) {
    lines.push(`- ${memberNames.get(member.user_id)} (${member.user_id})`);
  }
  lines.push("");
  lines.push("Agents:");
  if (directory.agents.length === 0) {
    lines.push("- none yet");
  }
  for (const agent of directory.agents) {
    /* Owner attribution is omitted, not guessed, when the deployment does not send it. */
    const owner = agent.owner_user_id === undefined
      ? undefined
      : memberNames.get(agent.owner_user_id);
    lines.push(
      `- ${sanitizeDisplayLabel(agent.name, "Unnamed agent")} (${agent.principal_id})${
        owner === undefined ? "" : ` — ${owner}`
      }`,
    );
  }
  lines.push("");
  /* The UUID is the addressable identity and the name is not: names are unique per workspace,
   * but a name you did not create can belong to someone you did not mean. Saying so here is
   * the cheap half of D-062. */
  lines.push("Address an agent by the id in brackets: cswarm ask \"…\" --to <id>");
  return `${lines.join("\n")}\n`;
}

async function runMembers(args: Arguments): Promise<void> {
  args.assertShape([
    ...TARGET_FLAGS,
    "workspace-id",
    ...CREDENTIAL_FLAGS,
    "json",
  ], 1);

  const cloud = await target(args);
  const selected = await commandWorkspaceAndCredential(args, cloud, {
    validateHumanWorkspace: true,
  });
  const directory = await signalDirectory(
    cloud,
    selected.selectedWorkspace,
    selected,
  );

  const memberNames = new Map(
    directory.members.map((member) => [
      member.user_id,
      sanitizeDisplayLabel(member.display_name, "Unnamed member"),
    ]),
  );

  if (args.has("json")) {
    process.stdout.write(
      `${
        JSON.stringify(
          {
            workspace_id: selected.selectedWorkspace,
            members: directory.members.map((member) => ({
              user_id: member.user_id,
              name: memberNames.get(member.user_id) ?? null,
            })),
            agents: directory.agents.map((agent) => ({
              principal_id: agent.principal_id,
              name: sanitizeDisplayLabel(agent.name, "Unnamed agent"),
              /* `owner_user_id` is optional on the read contract — an older deployment omits
               * it. Report null rather than inventing an owner. */
              owner_user_id: agent.owner_user_id ?? null,
              owner_name: agent.owner_user_id === undefined
                ? null
                : memberNames.get(agent.owner_user_id) ?? null,
            })),
          },
          null,
          2,
        )
      }\n`,
    );
    return;
  }

  process.stdout.write(renderRoster(directory, memberNames));
}

/** Show the identity authenticated by this request, never a saved human profile. */
async function runWhoami(args: Arguments): Promise<void> {
  args.assertShape([
    ...TARGET_FLAGS,
    "workspace-id",
    ...CREDENTIAL_FLAGS,
    "json",
  ], 1);
  if (!hasAgentCredential(args)) {
    throw new UsageError(
      "cswarm whoami needs --agent-token-file <path> or --agent-token-stdin",
    );
  }
  const cloud = await target(args);
  const selected = await commandWorkspaceAndCredential(args, cloud, {
    validateHumanWorkspace: true,
  });
  const directory = await readAgentSignalDirectory(
    cloud,
    selected.bearer,
    selected.selectedWorkspace,
  );
  const identity = directory.identity;
  if (identity === undefined) {
    throw new Error(
      "this deployment authenticated the credential but did not return its identity; update the read service before using cswarm whoami",
    );
  }
  const principal = directory.agents.find(
    (agent) => agent.principal_id === identity.principal_id,
  );
  if (
    principal === undefined ||
    principal.owner_user_id !== identity.owner_user_id
  ) {
    throw new Error(
      "the read service authenticated this credential but returned no matching live principal; identity was not shown",
    );
  }
  const owner = directory.members.find(
    (member) => member.user_id === identity.owner_user_id,
  );
  if (owner === undefined) {
    throw new Error(
      "the read service authenticated this credential but returned no matching owner; identity was not shown",
    );
  }
  const displayName = sanitizeDisplayLabel(principal.name, "Unnamed agent");
  const ownerName = sanitizeDisplayLabel(owner.display_name, "Unnamed member");
  const artifactPrincipalId = selected.agent?.principalId ?? null;
  const artifactMatches = artifactPrincipalId === null ||
    artifactPrincipalId === identity.principal_id;
  if (!artifactMatches) {
    process.stderr.write(
      `WARNING: the credential authenticated as ${displayName} (${identity.principal_id}), but its JSON metadata names ${artifactPrincipalId}. Trust the authenticated identity shown here and replace the inconsistent artifact.\n`,
    );
  }
  const output = {
    credential_valid: identity.credential_valid,
    principal_id: identity.principal_id,
    display_name: displayName,
    workspace_id: identity.workspace_id,
    owner_user_id: identity.owner_user_id,
    owner_display_name: ownerName,
    credential_metadata_match: artifactMatches,
  };
  if (args.has("json")) {
    printJson(output);
    return;
  }
  process.stdout.write(
    `You are ${displayName} (${identity.principal_id}).\n` +
      `Credential valid now: yes.\n` +
      `Workspace: ${identity.workspace_id}.\n` +
      `Owner: ${ownerName} (${identity.owner_user_id}).\n`,
  );
}

async function runSignalRead(
  args: Arguments,
  inbox: boolean,
): Promise<void> {
  const notify = inbox && args.has("notify");
  args.assertShape(notify
    ? [
      ...TARGET_FLAGS,
      "workspace-id",
      ...CREDENTIAL_FLAGS,
      "notify",
      "json",
    ]
    : [
      ...TARGET_FLAGS,
      "workspace-id",
      ...CREDENTIAL_FLAGS,
      "about",
      "kind",
      ...(inbox ? ["wait", "follow", "ndjson", "notify"] : []),
      "since",
      "limit",
      "include-stale",
      "json",
    ], 1);

  if (notify) {
    await runInboxNotifyCommand(args);
    return;
  }

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

/** Write one complete monitor line and wait until Node flushes it to stdout. */
async function writeMonitorLine(line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${line}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Human-visible arrival surface for a host Monitor. It reads signal pages and
 * advances only a local cursor; delivery claim/ack state belongs to the
 * listener and interactive hook paths and is never touched here.
 */
async function runInboxNotifyCommand(args: Arguments): Promise<void> {
  if (!hasAgentCredential(args)) {
    throw new Error(
      "inbox --notify is for one agent; provide its JSON credential with --agent-token-file or --agent-token-stdin",
    );
  }
  const cloud = await target(args);
  const selected = await commandWorkspaceAndCredential(args, cloud, {
    validateHumanWorkspace: true,
  });
  const principalId = selected.agent?.principalId ?? null;
  if (selected.kind !== "agent" || principalId === null) {
    throw new Error(
      "inbox --notify needs the full JSON agent credential so its durable cursor is tied to one agent",
    );
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const cursorStore = fileArrivalCursorStore({
      target: cloud,
      workspaceId: selected.selectedWorkspace,
      principalId,
    });
    const result = await runArrivalWatch({
      workspaceId: selected.selectedWorkspace,
      principalId,
      store: cursorStore,
      signal: controller.signal,
      readPage: async ({ after, baseline, limit }) => {
        const token = selected.session
          ? await selected.session.bearer()
          : selected.bearer;
        return await readAgentSignalPage(
          cloud,
          { kind: "agent", token },
          {
            workspaceId: selected.selectedWorkspace,
            inbox: true,
            limit,
            includeStale: false,
            ...(baseline
              ? {}
              : {
                ascending: true as const,
                ...(after === null ? {} : { after }),
              }),
          },
          { signal: controller.signal },
        );
      },
      emit: async (signal) => {
        const notification = arrivalNotification(
          signal,
          selected.selectedWorkspace,
          cloud,
        );
        await writeMonitorLine(
          args.has("json")
            ? JSON.stringify(notification)
            : formatArrivalNotification(notification),
        );
      },
      onRetry: (_error, delayMs) => {
        process.stderr.write(
          `cswarm: arrival read failed; still watching and retrying in ${delayMs}ms.\n`,
        );
      },
    });
    if (result.reason === "error") {
      throw result.error ?? new Error("arrival watch stopped");
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

async function runReceipt(args: Arguments): Promise<void> {
  args.assertShape([
    ...TARGET_FLAGS,
    "workspace-id",
    ...CREDENTIAL_FLAGS,
    "json",
  ], 2);
  const signalId = args.positionals[1]!;
  if (!UUID_RE.test(signalId)) {
    throw new Error("signal-id must be a UUID");
  }
  if (!hasAgentCredential(args)) {
    throw new Error(
      "receipt reads signals sent by an agent; provide --agent-token-file or --agent-token-stdin, and --workspace-id",
    );
  }
  const cloud = await target(args);
  const selected = await commandWorkspaceAndCredential(args, cloud, {
    validateHumanWorkspace: true,
  });
  let result;
  try {
    result = await readAgentDeliveryReceipts(
      cloud,
      selected.bearer,
      selected.selectedWorkspace,
      signalId,
    );
  } catch (error) {
    const reason = error instanceof SignalReadTimeoutError
      ? `the read reached its ${SIGNAL_READ_TIMEOUT_MS / 1000}-second deadline`
      : error instanceof DeliveryReceiptReadError && error.status !== null
      ? `the read service refused it with HTTP ${error.status}`
      : error instanceof DeliveryReceiptReadError && error.code === "not_author"
      ? "the service could not verify that this agent sent the signal"
      : error instanceof DeliveryReceiptReadError && error.code === "protocol"
      ? "the read service returned an invalid receipt response"
      : "the read service could not be reached";
    throw new Error(
      `Delivery receipt lookup failed because ${reason}. No delivery state was shown, so do not treat this signal as pending, delivered, or failed. Retry with: cswarm receipt ${signalId.toLowerCase()} --workspace-id ${selected.selectedWorkspace}`,
    );
  }
  const report = {
    ...result,
    workspaceId: selected.selectedWorkspace,
    signalId: signalId.toLowerCase(),
  };
  if (args.has("json")) {
    printJson(signalReceiptJsonPayload(report));
    return;
  }
  process.stdout.write(`${renderSignalReceiptReport(report)}\n`);
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
  // Follow always pages ascending with a keyset cursor. --limit only caps each
  // page; a backlog larger than one page is drained, not truncated to newest-N.
  const pageLimit = args.optional("limit") === undefined
    ? undefined
    : integer(args, "limit", { minimum: 1, maximum: 100 });
  const queryBase = {
    workspaceId: selected.selectedWorkspace,
    inbox: true as const,
    ascending: true as const,
    ...(args.optional("about") === undefined
      ? {}
      : { about: signalText(args.required("about"), "about") }),
    ...(args.optional("kind") === undefined
      ? {}
      : { kind: signalKind(args.required("kind")) }),
    ...(args.optional("since") === undefined
      ? {}
      : { since: args.required("since") }),
    includeStale: args.has("include-stale"),
  };

  const controller = new AbortController();
  let legacyCursorWarned = false;
  let malformedRowWarnings = 0;
  const onAbortSignal = () => controller.abort();
  process.on("SIGINT", onAbortSignal);
  process.on("SIGTERM", onAbortSignal);
  // Read ONCE, here, not per read: a value that can change mid-stream is a state
  // surface nobody would test. A supervised host sets 0 to restore the strict
  // D-051 veto, because the tolerance exists for the UNSUPERVISED path.
  const refusalToleranceMs = resolveRefusalToleranceMs(
    process.env.CSWARM_REFUSAL_TOLERANCE_MS,
    // Warn rather than guess silently. A knob that quietly disagrees with the
    // operator is worse than one that argues back.
    (message) => process.stderr.write(`cswarm: ${message}\n`),
  );
  try {
    const stop = await runInboxFollow({
      workspaceId: selected.selectedWorkspace,
      signal: controller.signal,
      refusalToleranceMs,
      ...(pageLimit === undefined ? {} : { pageLimit }),
      isCredentialFailure: (error) =>
        isFollowCredentialFailure(error) ||
        error instanceof RenewalReauthorisationRequired ||
        error instanceof RenewalRevoked,
      arm: async ({ after, limit }) => {
        // Renewal is checked on every arm for agent credentials; humans reuse
        // the session bearer already resolved for this process.
        const credential: SignalCredential = selected.session
          ? { kind: "agent", token: await selected.session.bearer() }
          : signalCredentialOf(selected);
        const query = {
          ...queryBase,
          limit,
          ...(after === null ? {} : { after }),
        };
        if (credential.kind === "agent") {
          const page = await readAgentSignalPage(
            cloud,
            credential,
            query,
            { signal: controller.signal },
            {
              allowLegacyCursorFallback: true,
              tolerateMalformedRows: true,
              maxMalformedRows: 3,
              onMalformedRow: (index) => {
                if (malformedRowWarnings >= 3) return;
                malformedRowWarnings += 1;
                process.stderr.write(
                  `cswarm: quarantined malformed inbox row ${index + 1}; no message content was logged.\n`,
                );
              },
            },
          );
          if (page.legacyCursorFallback && !legacyCursorWarned) {
            legacyCursorWarned = true;
            process.stderr.write(
              "cswarm: this deployment predates lossless inbox paging; update the read service because a burst larger than one page can be missed.\n",
            );
          }
          return {
            signals: page.signals,
            rawCount: page.rawCount,
            nextCursor: page.nextCursor,
            canPage: page.capabilities.cursorAfter &&
              !page.legacyCursorFallback,
          };
        }
        return await readSignals(
          cloud,
          credential,
          query,
          { signal: controller.signal },
        );
      },
      emit: (frame) => {
        process.stdout.write(`${formatFollowFrame(frame)}\n`);
      },
    });
    if (stop.reason === "cancelled") {
      return;
    }
    // D-055: the terminal frame is emitted by runInboxFollow through the same
    // emit callback as the rest of the stream, so it cannot be forgotten here.
    // This throw is the human-facing exit status, not the machine surface.
    //
    // D-056: the status also has to be actionable. isRestartableReadError is
    // the same predicate the supervisor's bounded restart uses, so a shell loop
    // and the supervisor cannot disagree about whether to try again.
    if (stop.error) {
      throw isRestartableReadError(stop.error)
        ? markRestartable(stop.error)
        : stop.error;
    }
    throw new Error(`inbox follow stopped (${stop.reason})`);
  } finally {
    process.off("SIGINT", onAbortSignal);
    process.off("SIGTERM", onAbortSignal);
  }
}

function listenerUuid(value: string | undefined, flag: string): string {
  if (!value || !UUID_RE.test(value)) {
    throw new Error(`--${flag} must be a UUID`);
  }
  return value.toLowerCase();
}

/** Omitting --permissions means ALLOW. Operator direction 2026-08-11: low friction by default. */
export function listenerPermissionMode(value: string | undefined): ListenerPermissionMode {
  /* ~~`if (value === undefined || value === "deny") return "deny";`~~ Dead 2026-08-11. The omitted
   * flag used to mean deny, which made the safe-looking default the one that quietly breaks the
   * product: under deny a worker cannot do anything it must ask permission for, while
   * `listen status` reports it healthy. Measured on the two-agent dogfood (OpenCode): Bash and
   * Write were refused, so it could not hash, persist or initiate; the agent on the other end
   * read it as uncooperative and nothing on any surface said why.
   *
   * ~~"ANSWERS and cannot ACT"~~ is too strong and is corrected here: deny governs only the
   * operations the PROVIDER raises a permission request for. Which those are is the provider's
   * choice, not ours.
   *
   * `allow` is not a blanket grant. It selects allow-once PER REQUEST (allowOnceOrDeny) and falls
   * back to deny when the host offers no such option, so it is the decision a human makes clicking
   * through, one tool call at a time. The permission-boundary canary is UNAFFECTED: it forces deny
   * regardless of this mode, so the proof that CommonSwarm controls ACP permissions still runs.
   *
   * NOT ESTABLISHED, and it is the reason this was deny: steady-state `allow` is unmeasured — see
   * the canary limit strings below, which still say so and are still true. The enforced boundary
   * against a CROSS-OWNER sender steering the worker is what this trades away; what remains is
   * sender provenance in the prompt plus the model's judgement. `--permissions deny` is unchanged
   * and is the answer for a listener taking work from outside your account. */
  if (value === undefined || value === "allow") return "allow";
  if (value === "deny") return "deny";
  throw new Error("--permissions must be deny or allow");
}

function listenerStateDirectory(args: Arguments): string | undefined {
  const value = args.optional("state-dir");
  if (value === undefined) return undefined;
  if (!isAbsolute(value)) {
    throw new Error("--state-dir must be an absolute path");
  }
  return value;
}

/**
 * Provider-derived self-description (docs/design/2026-08-03-AGENT-SELF-IDENTIFY.md):
 * the label states what the operator factually chose — the provider and its
 * pinned bridge — never a guessed underlying model. The bridge versions are the
 * pinned ones this file already instructs installing; keep them in step.
 */
function listenerModelLabel(provider: ListenerProviderId): string {
  switch (provider) {
    case "claude":
      return "claude (claude-agent-acp 0.64.2)";
    case "codex":
      return "codex (codex-acp 1.1.9)";
    case "opencode":
      return "opencode";
    case "grok":
      return "grok";
  }
}

function listenerProvider(args: Arguments): ListenerProviderId {
  const provider = args.optional("provider");
  const hints =
    "supported providers: grok — install Grok CLI 0.2.117 or newer and run grok login; opencode — install OpenCode 1.18.10 or newer and authenticate it; claude — npm install -g @agentclientprotocol/claude-agent-acp@latest (minimum 0.64.2); codex — npm install -g @agentclientprotocol/codex-acp@latest (minimum 1.1.9). You can use working-on, note, ask, and feed now; detached live receipt needs one of these adapters";
  if (provider === undefined) {
    throw new Error(`--provider is required; ${hints}`);
  }
  if (
    provider !== "grok" &&
    provider !== "opencode" &&
    provider !== "claude" &&
    provider !== "codex"
  ) {
    throw new Error(
      `unsupported --provider; ${hints}`,
    );
  }
  return provider;
}

function validateListenerProviderFlags(
  args: Arguments,
  provider: ListenerProviderId,
): void {
  if (provider !== "grok" && args.optional("effort")) {
    throw new Error(
      `--effort is not supported for --provider ${provider} (no measured mapping); omit it`,
    );
  }
  if ((provider === "claude" || provider === "codex") && args.optional("model")) {
    throw new Error(
      `--model is not supported for --provider ${provider} (no measured bridge mapping); omit it`,
    );
  }
  const executableFlags = [
    ["grok", "grok-executable"],
    ["opencode", "opencode-executable"],
    ["claude", "claude-executable"],
    ["codex", "codex-executable"],
  ] as const;
  for (const [owner, flag] of executableFlags) {
    if (provider !== owner && args.optional(flag)) {
      throw new Error(`--${flag} requires --provider ${owner}`);
    }
  }
}

/** Structured host limit copy for listen status JSON. */
export type ListenerHostLimits = {
  host_configuration: string;
  deny_canary_scope: string;
  steady_allow_unproven: string;
  cross_owner_context: string;
  local_state_lifecycle: string;
  human_copy: string;
  toString(): string;
};

export function listenerHostLimits(
  provider: ListenerStatus["provider"],
): ListenerHostLimits {
  if (provider === "opencode") {
    const host_configuration =
      "The OpenCode worker uses one private 0700 auth/config home and the operator-selected project cwd. OPENCODE_DISABLE_PROJECT_CONFIG=1 plus a verified debug config --pure probe keeps ACP permission requests on the forced-ask path.";
    const deny_canary_scope =
      "The deny canary proves host reject + correlated terminal deny only.";
    const steady_allow_unproven =
      "It does not prove steady-state --permissions allow behavior.";
    const cross_owner_context =
      "All sender relations reach that same worker and project context; each prompt carries sender and operator provenance.";
    const local_state_lifecycle =
      "The worker home is removed after verified close, or retained on shutdown failure.";
    const human_copy = [
      host_configuration,
      deny_canary_scope,
      steady_allow_unproven,
      cross_owner_context,
      local_state_lifecycle,
    ].join(" ");
    return {
      host_configuration,
      deny_canary_scope,
      steady_allow_unproven,
      cross_owner_context,
      local_state_lifecycle,
      human_copy,
      toString() {
        return human_copy;
      },
    };
  }
  if (provider === "claude") {
    const host_configuration =
      "The Claude worker uses the operator-selected cwd and the normal Claude Code home through claude-agent-acp 0.64.2 or newer. Keychain/OAuth auth was measured; ANTHROPIC_API_KEY is stripped by the listener environment sanitizer.";
    const deny_canary_scope =
      "The deny canary proves host reject + correlated terminal deny only.";
    const steady_allow_unproven =
      "The deny canary does not prove steady-state --permissions allow behavior.";
    const cross_owner_context =
      "All sender relations reach that same worker and local context; each prompt carries sender and operator provenance.";
    const local_state_lifecycle =
      "CommonSwarm does not create a separate Claude home or temporary worker cwd.";
    const human_copy = [
      host_configuration,
      cross_owner_context,
      steady_allow_unproven,
      local_state_lifecycle,
    ].join(" ");
    return {
      host_configuration,
      deny_canary_scope,
      steady_allow_unproven,
      cross_owner_context,
      local_state_lifecycle,
      human_copy,
      toString() {
        return human_copy;
      },
    };
  }
  if (provider === "codex") {
    const host_configuration =
      "The Codex worker uses the operator-selected cwd and normal ChatGPT/Codex auth through codex-acp 1.1.9 or newer. CommonSwarm explicitly selects read-only mode after every session/new; API-key variables are stripped by the listener environment sanitizer.";
    const deny_canary_scope =
      "The deny canary proves host reject + correlated terminal deny only.";
    const steady_allow_unproven =
      "The deny canary does not prove steady-state --permissions allow behavior.";
    const cross_owner_context =
      "All sender relations reach that same worker and local context; each prompt carries sender and operator provenance.";
    const local_state_lifecycle =
      "CommonSwarm does not create a separate Codex home or temporary worker cwd.";
    const human_copy = [
      host_configuration,
      cross_owner_context,
      steady_allow_unproven,
      local_state_lifecycle,
    ].join(" ");
    return {
      host_configuration,
      deny_canary_scope,
      steady_allow_unproven,
      cross_owner_context,
      local_state_lifecycle,
      human_copy,
      toString() {
        return human_copy;
      },
    };
  }
  const host_configuration =
    "The Grok worker uses the operator-selected cwd and local Grok configuration, including user and cmux hooks.";
  const deny_canary_scope =
    "The deny canary proves host reject + correlated terminal deny only.";
  const steady_allow_unproven =
    "The deny canary does not prove steady-state --permissions allow behavior.";
  const cross_owner_context =
    "All sender relations reach that same worker and local context; each prompt carries sender and operator provenance.";
  const local_state_lifecycle =
    "CommonSwarm does not create a separate Grok home for remote turns.";
  const human_copy = [
    host_configuration,
    cross_owner_context,
    steady_allow_unproven,
    local_state_lifecycle,
  ].join(" ");
  return {
    host_configuration,
    deny_canary_scope,
    steady_allow_unproven,
    cross_owner_context,
    local_state_lifecycle,
    human_copy,
    toString() {
      return human_copy;
    },
  };
}

export function listenerStatusJson(
  status: ListenerStatus,
  permissionMode?: ListenerPermissionMode,
): Record<string, unknown> {
  const mode = permissionMode ?? status.permissionMode;
  return {
    ...status,
    deliveryMode: status.deliveryMode ?? null,
    pendingDeliveryCount: status.pendingDeliveryCount ?? null,
    lastTerminalDeliveryFailureCount:
      status.lastTerminalDeliveryFailureCount ?? null,
    lastTerminalDeliveryFailureAt:
      status.lastTerminalDeliveryFailureAt ?? null,
    lastClaimAt: status.lastClaimAt ?? null,
    lastAckAt: status.lastAckAt ?? null,
    routeMode: status.routeMode ?? "worker",
    deferOverChars: status.deferOverChars ?? null,
    pendingForMainCount: status.pendingForMainCount ?? 0,
    droppedForMainCount: status.droppedForMainCount ?? 0,
    ...(mode
      ? {
        permission_mode: mode,
        /* "allowed once" alone overstates it: allowOnceOrDeny selects allow_once only when the
         * host OFFERS that option, and denies otherwise. Both review arms flagged the
         * unqualified form on 4844b4e7. */
        same_owner_delivery: status.routeMode === "main"
          ? "interactive session; no ACP worker prompt"
          : mode === "allow"
          ? "worker session; tool requests allowed once each when the host offers allow_once, otherwise denied"
          : "worker session; tool requests denied",
        cross_owner_delivery: status.routeMode === "main"
          ? "interactive session; no ACP worker prompt"
          : mode === "allow"
          ? "same worker session with sender provenance; tool requests allowed once each when the host offers allow_once, otherwise denied"
          : "same worker session with sender provenance; tool requests denied",
      }
      : {}),
    host_limits: listenerHostLimits(status.provider),
  };
}

export function renderListenerStatus(status: ListenerStatus): string {
  const routeMode = status.routeMode ?? "worker";
  const pendingForMainCount = status.pendingForMainCount ?? 0;
  const droppedForMainCount = status.droppedForMainCount ?? 0;
  const lines = [
    `Listener ${status.state} for agent ${status.principalId}.`,
    `Provider: ${status.provider}; process: ${status.pid}; started: ${status.startedAt}.`,
    status.readyAt ? `Ready since: ${status.readyAt}.` : "Not ready yet.",
    status.lastSignalId
      ? `Last handled signal: ${status.lastSignalId}.`
      : "No signal has been handled yet.",
    status.lastErrorCode
      ? `Last status code: ${status.lastErrorCode}.`
      : "No listener error is recorded.",
  ];
  if (status.lastErrorDetail) {
    const [first, ...rest] = status.lastErrorDetail.split("\n");
    lines.push(`Last error detail (local only): ${first}`);
    for (const line of rest) lines.push(`  ${line}`);
  }
  if (status.lastWorkerStderrTail) {
    // Local diagnosis for the D-090 family: the failing box's own log is the
    // only place the cause exists, so surface the end of it here.
    const tailLines = status.lastWorkerStderrTail
      .split("\n")
      .filter((line) => line.trim().length > 0);
    lines.push("Worker stderr (local log only):");
    for (const line of tailLines.slice(-3)) {
      lines.push(`  ${line}`);
    }
  }
  if (status.providerVersion && status.providerLastMeasuredVersion) {
    lines.push(
      `Provider version ${status.providerVersion} is newer than the last measured version ${status.providerLastMeasuredVersion}. It is unverified but allowed because the startup permission canary passed. Next: verify this provider release with CommonSwarm and update the last-measured version.`,
    );
  }
  if (status.deliveryMode === "durable_claim") {
    lines.push("Delivery mode: durable claim and acknowledgement.");
  } else if (status.deliveryMode === "cursor_fallback") {
    lines.push("Delivery mode: cursor fallback.");
  } else {
    lines.push("Delivery mode has not been reported yet.");
  }
  if (status.pendingDeliveryCount !== null) {
    lines.push(
      `Pending deliveries reported by the service: ${status.pendingDeliveryCount}.`,
    );
  }
  lines.push(
    routeMode === "split"
      ? `Ask route: split; bodies over ${status.deferOverChars} characters wait for this interactive session.`
      : routeMode === "main"
      ? "Ask route: main; directed asks wait for this interactive session."
      : "Ask route: worker (default).",
  );
  if (routeMode !== "worker") {
    lines.push(`Asks waiting for this session: ${pendingForMainCount}.`);
    lines.push(`Routed asks dropped from the overflow queue: ${droppedForMainCount}.`);
    if (droppedForMainCount > 0) {
      lines.push(
        "The signals remain in the inbox. Recover them with: cswarm inbox",
      );
    }
    if (pendingForMainCount > 0) {
      lines.push(
        status.state === "stopped" || status.state === "failed"
          ? `${pendingForMainCount} asks are stranded because this listener is not running. Restart it by piping the same agent credential into: ${listenerRestartCommand(status)}`
          : `${pendingForMainCount} asks waiting for this session; they surface at your next prompt, or run cswarm hook check.`,
      );
    }
  }
  if (
    status.lastTerminalDeliveryFailureCount !== null &&
    status.lastTerminalDeliveryFailureCount > 0
  ) {
    lines.push(
      `The last claim reported ${status.lastTerminalDeliveryFailureCount} terminal delivery failures; they remain recorded, and the listener will keep receiving.`,
    );
  }
  /* D-074. `stopping` and `starting` are TRANSITIONAL: the verb returns before teardown or
   * startup completes, so `listen stop` exits 0 while the child is still going away. The state
   * word is honest — it says "stopping", not "stopped" — but a verb the user just invoked,
   * exiting 0, reads as done, and nothing here said how to find out.
   *
   * Found by Wren, which read the return as unable to distinguish "stopping and will succeed"
   * from "stopping and will fail". The response does carry the distinction; what it lacked was
   * the next step. This repo's own standard is that output says what happened, what is now true,
   * AND what happens next — the third part was missing exactly where it matters most. */
  if (status.state === "stopping" || status.state === "starting") {
    lines.push(
      `This is still in progress. Confirm with: cswarm listen status --workspace-id ${status.workspaceId} --principal-id ${status.principalId}`,
    );
  }
  return lines.join("\n");
}

async function unsurfacedPendingMainStats(
  instanceDirectory: string,
  fallback: { count: number; droppedCount: number },
): Promise<{ count: number; droppedCount: number }> {
  try {
    const queue = new FilePendingMainQueue(instanceDirectory);
    const pending = await queue.read();
    const stats = await queue.stats();
    const staged = await new FileHookSurfaceStore(instanceDirectory).stage(
      pending,
      stats.droppedCount,
    );
    return { count: staged.unseen.length, droppedCount: stats.droppedCount };
  } catch {
    return fallback;
  }
}

export function listenerFailureMessage(
  code: string,
  provider?: ListenerProviderId,
): string {
  if (code === "version_below_floor") {
    if (provider === "codex") {
      return "the Codex listener requires codex-acp 1.1.9 or newer; update the bridge, then retry";
    }
    if (provider === "claude") {
      return "the Claude listener requires claude-agent-acp 0.64.2 or newer; update the bridge, then retry";
    }
    if (provider === "opencode") {
      return "the OpenCode listener requires OpenCode 1.18.10 or newer; update OpenCode, then retry";
    }
    return "the Grok listener requires Grok 0.2.117 or newer; update Grok, confirm grok login, then retry";
  }
  if (code === "version_unparseable") {
    return `the ${provider ?? "provider"} version output was not valid semantic version data, so startup stopped. Next: run the provider's --version command, then update or reinstall it`;
  }
  if (code === "version_refused") {
    return `the ${provider ?? "provider"} version check could not run, so startup stopped. Next: run the provider's --version command and fix that error, then retry`;
  }
  if (code === "executable_missing" && provider === "claude") {
    return "claude-agent-acp is not installed; run npm install -g @agentclientprotocol/claude-agent-acp@latest (minimum 0.64.2), then retry";
  }
  if (code === "executable_missing" && provider === "codex") {
    return "codex-acp is not installed; run npm install -g @agentclientprotocol/codex-acp@latest (minimum 1.1.9), then retry";
  }
  if (code === "permission_mode_unavailable" && provider === "claude") {
    return "the Claude bridge does not expose the required manual permission mode; update or reinstall claude-agent-acp, then retry";
  }
  if (code === "permission_mode_unavailable" && provider === "codex") {
    return "the Codex bridge does not expose the required read-only permission mode; update or reinstall codex-acp, then retry";
  }
  if (
    provider === "claude" &&
    (code === "rpc_error" ||
      code === "child_exit" ||
      code === "timeout")
  ) {
    return `the Claude bridge could not start (${code}); confirm Claude Code keychain/OAuth sign-in and network access, then retry. ANTHROPIC_API_KEY is not forwarded to detached listeners`;
  }
  if (
    provider === "codex" &&
    (code === "rpc_error" ||
      code === "child_exit" ||
      code === "timeout")
  ) {
    return `the Codex bridge could not start (${code}); confirm ChatGPT/Codex sign-in and network access, then retry. API-key variables are not forwarded to detached listeners`;
  }
  if (code === "grok_auth_missing") {
    return "Grok is not signed in for detached use; run grok login, then retry listen start";
  }
  if (code.startsWith("grok_auth_")) {
    return `Grok's local login artifact failed its safety check (${code}); run grok login again and ensure ~/.grok/auth.json is an owned 0600 regular file`;
  }
  if (code === "opencode_auth_missing") {
    return "OpenCode is not signed in for detached use; authenticate OpenCode, then retry listen start";
  }
  if (
    code.startsWith("opencode_auth_") ||
    code === "opencode_project_config_active" ||
    code === "opencode_config_probe_failed"
  ) {
    return `OpenCode host safety check failed (${code}); re-authenticate and ensure OPENCODE_DISABLE_PROJECT_CONFIG keeps project allow from merging`;
  }
  if (
    code === "sender_relation_capability_missing" ||
    code === "cursor_capability_missing"
  ) {
    return `the deployed read service lacks the safe listener capability (${code}); update/deploy the read edge before starting a model`;
  }
  if (code === "credential_stopped") {
    return "the agent credential expired, was revoked, or reached its renewal horizon; ask the signed-in workspace owner for a new onboarding prompt";
  }
  if (code === "permission_canary_failed") {
    if (provider === "claude") {
      return "the Claude bridge did not complete the ACP permission canary; the startup canary ran, but no workspace signal prompt was delivered. Confirm Claude Code keychain/OAuth sign-in, then retry";
    }
    if (provider === "codex") {
      return "the Codex bridge did not complete the read-only ACP permission canary; no workspace signal prompt was delivered. Confirm ChatGPT/Codex sign-in, then retry";
    }
    if (provider === "grok") {
      return "the Grok bridge did not complete the ACP permission canary; no workspace signal prompt was delivered. The local cswarm listen status output includes the final error detail; read it, then retry";
    }
    return "the host did not prove that CommonSwarm controls ACP tool permissions; no model prompt was delivered";
  }
  if (code === "process_exit") {
    return "the detached listener process exited before it became ready; check the measured host version and login, then retry";
  }
  if (code === "ready_timeout") {
    /* D-080. "then retry" described a state this path does not create: nothing kills the child
     * on a ready timeout, so the listener is still running when this prints. Retrying spawns a
     * second one or hits "already running". Every other code here follows a listener that
     * reported `failed` and terminated, where "retry" is correct — this was the one that did not.
     *
     * Wren, who measured D-080, pointed at `listen stop` as the pattern already in the product:
     * it says it is asynchronous, says it is incomplete, and names the command to confirm with.
     * The timeout is a report that we stopped waiting, not that the listener stopped.
     *
     * The wording asserts OUR action, not the process's state, and that distinction is the whole
     * point. A first version said "was not stopped", which reads as a claim about the listener —
     * and both review arms refuted it: the loop does no final liveness check, so the child can
     * exit between the last poll and this throw. What IS guaranteed is that cswarm did not stop
     * it, because this path never kills the child. Say the thing that is true. */
    return "the listener did not become ready within two minutes and cswarm did not stop it; check cswarm listen status before starting another";
  }
  /* D-080, F-3 of the 2026-08-10 dogfood. "no ready listener was left running" was MEASURED
   * false on production: a start printed it while the listener it had just spawned was in state
   * `starting` with no error recorded, and that listener reached ready 24 seconds later. Nothing
   * on this path stops the child, and nothing re-checks it before this string is built.
   *
   * Same correction as `ready_timeout` above: drop the claim about the process's state, which we
   * do not check, and give the reader the command that answers it. The code is still named,
   * because that is the part that is ours to assert. */
  return `listener failed (${code}); check cswarm listen status before starting another`;
}

/** Resolve the detached Claude bridge while preserving its install remedy. */
export function resolveDetachedClaudeExecutable(
  executable = "claude-agent-acp",
  pathEnv = process.env.PATH,
): string {
  try {
    return resolveClaudeExecutable(executable, pathEnv);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      if (
        isAbsolute(executable) ||
        executable.includes("/") ||
        executable.includes("\\")
      ) {
        const detail = error instanceof Error ? error.message : code;
        throw new Error(
          `could not use --claude-executable: ${detail}; install the current bridge with npm install -g @agentclientprotocol/claude-agent-acp@latest if this path should be replaced`,
        );
      }
      throw new Error(listenerFailureMessage(code, "claude"));
    }
    throw error;
  }
}

/** Resolve the detached Codex bridge while preserving its install remedy. */
export function resolveDetachedCodexExecutable(
  executable = "codex-acp",
  pathEnv = process.env.PATH,
): string {
  try {
    return resolveCodexExecutable(executable, pathEnv);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      if (
        isAbsolute(executable) ||
        executable.includes("/") ||
        executable.includes("\\")
      ) {
        const detail = error instanceof Error ? error.message : code;
        throw new Error(
          `could not use --codex-executable: ${detail}; install the current bridge with npm install -g @agentclientprotocol/codex-acp@latest if this path should be replaced`,
        );
      }
      throw new Error(listenerFailureMessage(code, "codex"));
    }
    throw error;
  }
}

function assertDurableListenerCredential(
  agent: AgentCredentialInput,
  expectedPrincipal?: string,
): asserts agent is AgentCredentialInput & {
  principalId: string;
  tokenId: string;
  runId: string;
  expiresAt: number;
  durable: true;
} {
  if (
    !agent.durable ||
    agent.principalId === null ||
    agent.tokenId === null ||
    agent.runId === null ||
    agent.expiresAt === null
  ) {
    throw new Error(
      "listen start requires the complete JSON credential artifact, including expires_at; a bare token cannot identify durable state or rotate safely",
    );
  }
  if (
    expectedPrincipal !== undefined &&
    agent.principalId !== expectedPrincipal.toLowerCase()
  ) {
    throw new Error(
      "the credential artifact belongs to a different agent principal",
    );
  }
}

async function runConfiguredListener(options: {
  cloud: CloudTarget;
  workspaceId: string;
  principalId: string;
  agent: AgentCredentialInput & {
    principalId: string;
    tokenId: string;
    runId: string;
    expiresAt: number;
    durable: true;
  };
  cwd: string;
  permissionMode: ListenerPermissionMode;
  provider: ListenerProviderId;
  model?: string;
  effort?: string;
  executable?: string;
  opencodeExecutable?: string;
  claudeExecutable?: string;
  codexExecutable?: string;
  stateDirectory?: string;
  turnBudgetMs?: number;
  routeMode?: ListenerRouteMode;
  deferOverChars?: number | null;
}): Promise<ListenerStatus> {
  if (options.provider === "opencode" && options.effort) {
    throw new Error(
      "--effort is not supported for --provider opencode (no measured mapping); omit it",
    );
  }
  if ((options.provider === "claude" || options.provider === "codex") && options.effort) {
    throw new Error(
      `--effort is not supported for --provider ${options.provider} (no measured mapping); omit it`,
    );
  }
  if ((options.provider === "claude" || options.provider === "codex") && options.model) {
    throw new Error(
      `--model is not supported for --provider ${options.provider} (no measured bridge mapping); omit it`,
    );
  }
  const paths = listenerPaths({
    profileId: options.cloud.profileId,
    workspaceId: options.workspaceId,
    principalId: options.principalId,
    ...(options.stateDirectory
      ? { stateDirectory: options.stateDirectory }
      : {}),
  });
  const liveCredentialSession = await agentSession(
    options.cloud,
    options.workspaceId,
    options.agent,
  );
  let storedCredential: string | null = null;
  const credentialSession = {
    bearer: async (): Promise<string> => {
      const credential = await liveCredentialSession.bearer();
      if (credential !== storedCredential) {
        await writeListenerCredentialState(paths.instanceDirectory, {
          target: options.cloud,
          workspaceId: options.workspaceId,
          principalId: options.principalId,
          credential,
        }).then(() => {
          storedCredential = credential;
        });
      }
      const stored = await readListenerCredentialState(paths.instanceDirectory);
      if (stored === null || stored.credential !== credential) {
        throw new Error("listener credential state did not preserve the live credential");
      }
      return stored.credential;
    },
  };
  const resolveSenderProvenance = async (
    signal: SignalRecord,
    context: ListenerSenderProvenanceContext,
  ) => {
    const credential = await credentialSession.bearer();
    const senderDirectory = await readAgentSignalDirectory(
      options.cloud,
      credential,
      options.workspaceId,
      context,
    );
    return listenerSenderProvenance(signal, senderDirectory);
  };
  const effectStore = new FileListenerEffectStore({
    profileId: options.cloud.profileId,
    workspaceId: options.workspaceId,
    principalId: options.principalId,
    ...(options.stateDirectory
      ? { stateDirectory: options.stateDirectory }
      : {}),
  });
  const turnBudgetMs = options.turnBudgetMs ?? LISTENER_PROMPT_TIMEOUT_MS;
  // The budget actually applied to the most recent turn, so a timeout event can
  // report the bound that was hit rather than the configured cap (a reader who
  // sees 600000 when the turn was clamped to 5m has a wrong bound).
  let lastAppliedTurnBudgetMs: number | null = null;
  /* Each turn renews FIRST (bearer() rotates when due), then either clamps to
   * what the live credential can still cover or DEFERS when no budget can be
   * proven to outlast the turn — see resolveTurnBudgetOrDefer for the
   * invariant. A deferral throws a recoverable error before any worker prompt;
   * a clamped-short turn that times out is redelivered by the durable claim/ack
   * layer, and the retry starts on the freshly rotated credential. */
  const resolveTurnBudgetMs = async (): Promise<number> => {
    let renewalFailed = false;
    try {
      await credentialSession.bearer();
    } catch {
      // A rotation-endpoint failure must NOT let the turn start on the old
      // (possibly expired) credential; resolveTurnBudgetOrDefer throws so the
      // ask is deferred and durably redelivered when rotation recovers.
      renewalFailed = true;
    }
    const applied = resolveTurnBudgetOrDefer(
      turnBudgetMs,
      liveCredentialSession.expiry,
      Date.now(),
      renewalFailed,
    );
    lastAppliedTurnBudgetMs = applied;
    return applied;
  };
  // The newest dead worker's stderr tail. Read-and-cleared by the supervisor,
  // which writes it only to the operator's own 0600 log and status file; it
  // never rides an error object or a server payload (D-090 family).
  let lastWorkerStderrTail: string | null = null;
  let workerStderrGeneration = 0;
  let providerVersionNotice: ProviderVersionNotice | null = null;
  const onVersionNotice = (notice: ProviderVersionNotice) => {
    providerVersionNotice = notice;
  };
  /* One sink per model (= per supervisor attempt). Creating a sink clears the
   * slot and expires every older sink, so a superseded worker whose exit
   * publishes late can never label its stderr as the current attempt's — the
   * second worker must not inherit or be overwritten by the first's tail. */
  const newWorkerStderrTailSink = () => {
    const generation = ++workerStderrGeneration;
    lastWorkerStderrTail = null;
    return (tail: string) => {
      if (generation !== workerStderrGeneration) return;
      // An empty tail still clears the slot: a previous worker's stderr must
      // not masquerade as this exit's.
      lastWorkerStderrTail = tail.length > 0 ? tail : null;
    };
  };
  // A factory, not a value: the supervisor may run the listener more than once
  // and a model is single-use (runListenerRuntime closes it on every exit, and
  // every adapter throws "listener model is closed" once closed). Constructing
  // one here and capturing it would make every restart fail instantly.
  const newModel = (onCanaryAttempt: ListenerCanaryAttemptCallback) => {
    providerVersionNotice = null;
    return options.provider === "opencode"
    ? new OpenCodeListenerModel({
      cwd: options.cwd,
      permissionMode: options.permissionMode,
      promptTimeoutMs: resolveTurnBudgetMs,
      onWorkerStderrTail: newWorkerStderrTailSink(),
      onCanaryAttempt,
      onVersionNotice,
      ...(options.model ? { model: options.model } : {}),
      ...(options.opencodeExecutable
        ? { executable: options.opencodeExecutable }
        : options.executable
        ? { executable: options.executable }
        : {}),
    })
    : options.provider === "claude"
    ? new ClaudeListenerModel({
      cwd: options.cwd,
      permissionMode: options.permissionMode,
      promptTimeoutMs: resolveTurnBudgetMs,
      onWorkerStderrTail: newWorkerStderrTailSink(),
      onCanaryAttempt,
      onVersionNotice,
      ...(options.claudeExecutable
        ? { executable: options.claudeExecutable }
        : options.executable
        ? { executable: options.executable }
        : {}),
    })
    : options.provider === "codex"
    ? new CodexListenerModel({
      cwd: options.cwd,
      permissionMode: options.permissionMode,
      promptTimeoutMs: resolveTurnBudgetMs,
      onWorkerStderrTail: newWorkerStderrTailSink(),
      onCanaryAttempt,
      onVersionNotice,
      ...(options.codexExecutable
        ? { executable: options.codexExecutable }
        : options.executable
        ? { executable: options.executable }
        : {}),
    })
    : new GrokListenerModel({
      cwd: options.cwd,
      permissionMode: options.permissionMode,
      promptTimeoutMs: resolveTurnBudgetMs,
      onWorkerStderrTail: newWorkerStderrTailSink(),
      onCanaryAttempt,
      onVersionNotice,
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.executable ? { executable: options.executable } : {}),
    });
  };
  const onProcessSignal = () => {
    void stopListener(paths);
  };
  let selectedJournal: ListenerDeliveryJournal | undefined;
  let selectedListenerInstanceId: string | undefined;
  const routeMode = options.routeMode ?? "worker";
  const deferOverChars = options.deferOverChars ?? null;
  const pendingMainQueue = new FilePendingMainQueue(paths.instanceDirectory);
  process.on("SIGINT", onProcessSignal);
  process.on("SIGTERM", onProcessSignal);
  try {
    return await runListenerSupervisor({
      paths,
      profileId: options.cloud.profileId,
      workspaceId: options.workspaceId,
      principalId: options.principalId,
      provider: options.provider,
      permissionMode: options.permissionMode,
      routeMode,
      deferOverChars,
      // The bound a timeout event reports: the last turn's clamped budget when
      // one has run, else the configured cap.
      getTurnBudgetMs: () => lastAppliedTurnBudgetMs ?? turnBudgetMs,
      getProviderVersionNotice: () => providerVersionNotice,
      takeWorkerStderrTail: () => {
        const tail = lastWorkerStderrTail;
        lastWorkerStderrTail = null;
        return tail;
      },
      prepare: async (proposedInstanceId) => {
        const selected = await openListenerDeliveryJournal({
          profileId: options.cloud.profileId,
          workspaceId: options.workspaceId,
          principalId: options.principalId,
          proposedListenerInstanceId: proposedInstanceId,
          ...(options.stateDirectory
            ? { stateDirectory: options.stateDirectory }
            : {}),
        });
        selectedJournal = selected.journal;
        selectedListenerInstanceId = selected.listenerInstanceId;
        return { instanceId: selected.listenerInstanceId };
      },
      run: async (signal, onEvent, listenerInstanceId) => {
        if (
          selectedJournal === undefined ||
          selectedListenerInstanceId === undefined ||
          listenerInstanceId !== selectedListenerInstanceId
        ) {
          throw new Error(
            "listener delivery journal was not selected for this instance",
          );
        }
        const onCanaryAttempt: ListenerCanaryAttemptCallback = (
          attempt,
          total,
          result,
        ) => {
          onEvent({
            type: "canary_attempt",
            attempt,
            total,
            passed: result.passed,
            reason: result.reason ?? null,
            ts: new Date().toISOString(),
          });
        };
        return await runListenerRuntime({
          target: options.cloud,
          workspaceId: options.workspaceId,
          principalId: options.principalId,
          credentialSession,
          store: effectStore,
          model: newModel(onCanaryAttempt),
          signal,
          onEvent,
          declareModel: listenerModelLabel(options.provider),
          listenerInstanceId,
          deliveryJournal: selectedJournal,
          resolveSenderProvenance,
          routeMode,
          deferOverChars,
          pendingMainQueue,
        });
      },
    });
  } finally {
    process.off("SIGINT", onProcessSignal);
    process.off("SIGTERM", onProcessSignal);
  }
}

async function runListenStart(args: Arguments): Promise<void> {
  args.assertShape([
    ...TARGET_FLAGS,
    "workspace-id",
    ...CREDENTIAL_FLAGS,
    "provider",
    "cwd",
    "model",
    "effort",
    "permissions",
    "grok-executable",
    "opencode-executable",
    "claude-executable",
    "codex-executable",
    "state-dir",
    "turn-budget",
    "route",
    "defer-over",
    "foreground",
    "json",
  ], 2);
  if (!hasAgentCredential(args)) {
    throw new Error(
      "listen start requires --agent-token-file or --agent-token-stdin; credentials are never accepted on argv",
    );
  }
  const provider = listenerProvider(args);
  validateListenerProviderFlags(args, provider);
  // Validated before the target and credential work so a bad duration fails
  // fast; the detached path forwards the validated string for the supervisor
  // to re-parse.
  const turnBudgetMs = listenerTurnBudgetMs(args.optional("turn-budget"));
  const routing = listenerRouteConfiguration(
    args.optional("route"),
    args.optional("defer-over"),
  );
  const cloud = await target(args);
  const workspaceId = listenerUuid(
    args.optional("workspace-id") ?? process.env.SWARM_CLOUD_WORKSPACE_ID,
    "workspace-id",
  );
  const agent = await agentCredential(args);
  assertDurableListenerCredential(agent);
  const principalId = agent.principalId;
  const cwd = args.optional("cwd") ?? process.cwd();
  if (!isAbsolute(cwd)) throw new Error("--cwd must be an absolute path");
  const permissionMode = listenerPermissionMode(args.optional("permissions"));
  const stateDirectory = listenerStateDirectory(args);
  const paths = listenerPaths({
    profileId: cloud.profileId,
    workspaceId,
    principalId,
    ...(stateDirectory ? { stateDirectory } : {}),
  });
  const existing = await effectiveListenerStatus(paths);
  if (
    existing &&
    (existing.state === "starting" ||
      existing.state === "ready" ||
      existing.state === "stopping")
  ) {
    throw new Error(
      `a listener is already ${existing.state} for agent ${principalId}`,
    );
  }

  let status: ListenerStatus;
  if (args.has("foreground")) {
    status = await runConfiguredListener({
      cloud,
      workspaceId,
      principalId,
      agent,
      cwd,
      permissionMode,
      provider,
      turnBudgetMs,
      ...routing,
      ...(args.optional("model") ? { model: args.required("model") } : {}),
      ...(args.optional("effort") ? { effort: args.required("effort") } : {}),
      ...(args.optional("grok-executable")
        ? { executable: args.required("grok-executable") }
        : {}),
      ...(args.optional("opencode-executable")
        ? { opencodeExecutable: args.required("opencode-executable") }
        : {}),
      ...(args.optional("claude-executable")
        ? { claudeExecutable: args.required("claude-executable") }
        : {}),
      ...(args.optional("codex-executable")
        ? { codexExecutable: args.required("codex-executable") }
        : {}),
      ...(stateDirectory ? { stateDirectory } : {}),
    });
  } else {
    const entrypoint = process.argv[1];
    if (!entrypoint || !isAbsolute(entrypoint)) {
      throw new Error("cannot locate the cswarm executable for detached start");
    }
    const artifact = JSON.stringify(agentCredentialArtifact({
      principalId,
      tokenId: agent.tokenId,
      runId: agent.runId,
      token: agent.token,
      expiresAt: agent.expiresAt,
    }));
    const opencodeExecutable = provider === "opencode"
      ? resolveOpenCodeExecutable(
        args.optional("opencode-executable") ?? "opencode",
      )
      : undefined;
    let claudeExecutable: string | undefined;
    if (provider === "claude") {
      claudeExecutable = resolveDetachedClaudeExecutable(
        args.optional("claude-executable") ?? "claude-agent-acp",
      );
    }
    let codexExecutable: string | undefined;
    if (provider === "codex") {
      codexExecutable = resolveDetachedCodexExecutable(
        args.optional("codex-executable") ?? "codex-acp",
      );
    }
    /* D-080. Captured BEFORE the spawn on purpose: any status file older than this belongs to
     * an earlier run in this config-hash-keyed directory, whatever pid it carries. Taking it
     * after the spawn would race the child's own first write and could discard a real failure. */
    const startedAtFloorMs = Date.now();
    const child = await spawnDetachedListener({
      spec: {
        entrypoint,
        url: cloud.url,
        anonKey: cloud.anonKey,
        workspaceId,
        principalId,
        cwd,
        permissionMode,
        provider,
        nodeExecArgv: process.execArgv,
        route: routing.routeMode,
        ...(routing.deferOverChars === null
          ? {}
          : { deferOver: routing.deferOverChars }),
        ...(stateDirectory ? { stateDirectory } : {}),
        ...(args.optional("model") ? { model: args.required("model") } : {}),
        ...(args.optional("effort") ? { effort: args.required("effort") } : {}),
        ...(args.optional("turn-budget")
          ? { turnBudget: args.required("turn-budget") }
          : {}),
        ...(args.optional("grok-executable")
          ? { executable: args.required("grok-executable") }
          : {}),
        ...(opencodeExecutable
          ? { opencodeExecutable }
          : {}),
        ...(claudeExecutable
          ? { claudeExecutable }
          : {}),
        ...(codexExecutable
          ? { codexExecutable }
          : {}),
      },
      credentialArtifact: artifact,
    });
    if (child.pid === undefined) {
      child.kill();
      throw new Error("detached listener did not receive a process id");
    }
    try {
      status = await waitForListenerReady(paths, {
        expectedPid: child.pid,
        startedAtFloorMs,
        isProcessAlive: () =>
          child.exitCode === null && child.signalCode === null,
      });
    } catch (error) {
      if (error instanceof ListenerStartupError) {
        throw new Error(listenerFailureMessage(error.code, provider));
      }
      throw error;
    }
  }

  if (status.state === "failed") {
    throw new Error(
      listenerFailureMessage(status.lastErrorCode ?? "unknown_error", provider),
    );
  }
  if ((status.routeMode ?? "worker") !== "worker") {
    const recordedPending = status.pendingForMainCount ?? 0;
    const recordedDropped = status.droppedForMainCount ?? 0;
    const queueStats = await unsurfacedPendingMainStats(
      paths.instanceDirectory,
      { count: recordedPending, droppedCount: recordedDropped },
    );
    status = {
      ...status,
      pendingForMainCount: queueStats.count,
      droppedForMainCount: queueStats.droppedCount,
    };
  }
  if (args.has("json")) {
    printJson(listenerStatusJson(status, permissionMode));
    return;
  }
  const routingNote = routing.routeMode === "main"
    ? "Directed asks are queued for your interactive session and never prompt the ACP worker. Run cswarm hook check to surface them.\n"
    : routing.routeMode === "split"
    ? `Directed asks over ${routing.deferOverChars} characters are queued for your interactive session; shorter asks use the worker. Run cswarm hook check to surface queued asks.\n`
    : "";
  const workerAudience = routing.routeMode === "main"
    ? "Directed asks do not reach that worker."
    : routing.routeMode === "split"
    ? "Only asks at or below the split threshold reach that worker, with sender and operator provenance in the prompt."
    : "Every sender reaches that worker with sender and operator provenance in the prompt.";
  const hostNote = provider === "opencode"
    ? `The OpenCode worker uses one private auth/config home and your selected project cwd. ${workerAudience} Tool requests are approved one at a time by default, when the worker asks and the host offers a one-time approval; --permissions deny refuses them. The deny canary does not cover steady-state allow.\n`
    : provider === "claude"
    ? `The Claude worker uses your selected cwd and normal Claude Code keychain/OAuth state through claude-agent-acp 0.64.2 or newer. ${workerAudience}\n`
    : provider === "codex"
    ? `The Codex worker uses your selected cwd and normal ChatGPT/Codex auth through codex-acp 1.1.9 or newer. CommonSwarm selects read-only mode before its deny canary. ${workerAudience}\n`
    : `The Grok worker uses your selected cwd and local Grok configuration, including user and cmux hooks. ${workerAudience}\n`;
  process.stdout.write(
    `${
      args.has("foreground")
        ? "Listener stopped."
        : "Listener is ready and will keep receiving after this command exits."
    }\n${renderListenerStatus(status)}\n` +
      /* ~~"allowed once because you explicitly selected --permissions allow" / "denied by
       * default"~~ Dead 2026-08-11. Flipping the default inverted BOTH clauses at once: allow is
       * no longer explicitly selected and deny is no longer the default. Neither string appeared
       * in the diff that changed the default, which is why the sweep has to be over claims rather
       * than over changed lines.
       *
       * The deny branch also now states the COST. Measured the same day: a worker under deny had
       * Bash and Write refused, so it could answer and could not act, and every status surface
       * called it healthy — the operator had nothing to read that explained it. "Tool requests are
       * denied" is true and gets skimmed past; naming what the worker cannot do does not. */
      `Same-owner tool requests are ${
        permissionMode === "allow"
          ? "approved one at a time, when the worker asks and the host offers a one-time approval"
          /* ~~"running commands and writing files were both refused in testing"~~ Dead: this line
           * is emitted for EVERY provider, and the durable record
           * (docs/evidence/2026-08-10-dogfood/README.md) exercised only OpenCode. A measurement
           * from one provider was being asserted for four. Caught by the exact-review arm. */
          : "denied. This worker can reply to messages but cannot do anything it must ask " +
            "permission for; restart with --permissions allow if that is not what you want"
      }. The same permission mode applies to every sender relation.\n` +
      "The short credential rotates while this process remains alive and secure local state is available; a person reauthorises after the 30-day horizon.\n" +
      routingNote +
      hostNote +
      `Use listen status/stop with --workspace-id ${workspaceId} --principal-id ${principalId} and the same Cloud target.\n`,
  );
}

async function runListenSupervisor(args: Arguments): Promise<void> {
  args.assertShape([
    ...TARGET_FLAGS,
    ...CREDENTIAL_FLAGS,
    "workspace-id",
    "principal-id",
    "cwd",
    "model",
    "effort",
    "permissions",
    "provider",
    "grok-executable",
    "opencode-executable",
    "claude-executable",
    "codex-executable",
    "state-dir",
    "turn-budget",
    "route",
    "defer-over",
  ], 1);
  const provider = listenerProvider(args);
  validateListenerProviderFlags(args, provider);
  // Validated before the credential is read, like the public listen start
  // path: a bad duration must fail fast, not after secrets moved.
  const turnBudgetMs = listenerTurnBudgetMs(args.optional("turn-budget"));
  const routing = listenerRouteConfiguration(
    args.optional("route"),
    args.optional("defer-over"),
  );
  const cloud = await target(args);
  const workspaceId = listenerUuid(args.optional("workspace-id"), "workspace-id");
  const principalId = listenerUuid(args.optional("principal-id"), "principal-id");
  /* Detached starts keep using the inherited pipe. The file form is also accepted for direct
   * supervisor diagnostics, but the public parent never puts the credential or an env var here. */
  const agent = await agentCredential(args, { implicitStdin: true });
  assertDurableListenerCredential(agent, principalId);
  const cwd = args.required("cwd");
  if (!isAbsolute(cwd)) throw new Error("--cwd must be an absolute path");
  const status = await runConfiguredListener({
    cloud,
    workspaceId,
    principalId,
    agent,
    cwd,
    permissionMode: listenerPermissionMode(args.optional("permissions")),
    provider,
    turnBudgetMs,
    ...routing,
    ...(args.optional("model") ? { model: args.required("model") } : {}),
    ...(args.optional("effort") ? { effort: args.required("effort") } : {}),
    ...(args.optional("grok-executable")
      ? { executable: args.required("grok-executable") }
      : {}),
    ...(args.optional("opencode-executable")
      ? { opencodeExecutable: args.required("opencode-executable") }
      : {}),
    ...(args.optional("claude-executable")
      ? { claudeExecutable: args.required("claude-executable") }
      : {}),
    ...(args.optional("codex-executable")
      ? { codexExecutable: args.required("codex-executable") }
      : {}),
    ...(listenerStateDirectory(args)
      ? { stateDirectory: listenerStateDirectory(args) }
      : {}),
  });
  if (status.state === "failed") {
    throw new Error(
      `listener failed (${status.lastErrorCode ?? "unknown_error"})`,
    );
  }
}

async function runListenStatusOrStop(
  args: Arguments,
  command: "status" | "stop",
): Promise<void> {
  args.assertShape([
    ...TARGET_FLAGS,
    "workspace-id",
    "principal-id",
    "state-dir",
    "json",
  ], 2);
  const cloud = await target(args);
  const workspaceId = listenerUuid(args.optional("workspace-id"), "workspace-id");
  const principalId = listenerUuid(args.optional("principal-id"), "principal-id");
  const stateDirectory = listenerStateDirectory(args);
  const paths = listenerPaths({
    profileId: cloud.profileId,
    workspaceId,
    principalId,
    ...(stateDirectory ? { stateDirectory } : {}),
  });
  let status = command === "stop"
    ? await stopListener(paths)
    : await effectiveListenerStatus(paths);
  if (status === null) {
    if (args.has("json")) {
      printJson({ status: "not_found", workspace_id: workspaceId, principal_id: principalId });
    } else {
      process.stdout.write("No listener has been started for that agent.\n");
    }
    return;
  }
  if ((status.routeMode ?? "worker") !== "worker") {
    const recordedPending = status.pendingForMainCount ?? 0;
    const recordedDropped = status.droppedForMainCount ?? 0;
    const queueStats = await unsurfacedPendingMainStats(
      paths.instanceDirectory,
      { count: recordedPending, droppedCount: recordedDropped },
    );
    status = {
      ...status,
      pendingForMainCount: queueStats.count,
      droppedForMainCount: queueStats.droppedCount,
    };
  }
  if (args.has("json")) {
    printJson(listenerStatusJson(status));
  } else {
    process.stdout.write(`${renderListenerStatus(status)}\n`);
  }
}

async function runListen(args: Arguments): Promise<void> {
  const command = args.positionals[1];
  if (command === "start") {
    await runListenStart(args);
    return;
  }
  if (command === "status" || command === "stop") {
    await runListenStatusOrStop(args, command);
    return;
  }
  throw new UsageError("listen requires start, status, or stop");
}

const CLAUDE_HOOK_COMMAND = "cswarm hook check";

function scopedClaudeHookCommand(principalId: string): string {
  return `${CLAUDE_HOOK_COMMAND} --principal-id ${listenerUuid(principalId, "principal-id")}`;
}

function isCommonSwarmClaudeHook(value: unknown): boolean {
  return typeof value === "string" && (
    value === CLAUDE_HOOK_COMMAND ||
    /^cswarm hook check --principal-id [0-9a-f-]{36}$/.test(value)
  );
}

/** Exact project-settings fragment printed by `cswarm hook install claude`. */
export function claudeUserPromptHookSnippet(principalId: string): Record<string, unknown> {
  return {
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: scopedClaudeHookCommand(principalId),
            },
          ],
        },
      ],
    },
  };
}

function projectClaudeSettingsPath(): string {
  return join(process.cwd(), ".claude", "settings.json");
}

function readProjectSettings(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("local .claude/settings.json must contain a JSON object");
  }
  return value as Record<string, unknown>;
}

function installClaudeHook(
  settings: Record<string, unknown>,
  principalId: string,
): Record<string, unknown> {
  const hooks = settings.hooks && typeof settings.hooks === "object" &&
      !Array.isArray(settings.hooks)
    ? { ...(settings.hooks as Record<string, unknown>) }
    : {};
  const current = Array.isArray(hooks.UserPromptSubmit)
    ? [...hooks.UserPromptSubmit]
    : [];
  const command = scopedClaudeHookCommand(principalId);
  let installed = false;
  const groups: unknown[] = [];
  for (const group of current) {
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      groups.push(group);
      continue;
    }
    const row = { ...(group as Record<string, unknown>) };
    if (!Array.isArray(row.hooks)) {
      groups.push(group);
      continue;
    }
    const commands: unknown[] = [];
    for (const hook of row.hooks) {
      if (
        hook && typeof hook === "object" && !Array.isArray(hook) &&
        (hook as Record<string, unknown>).type === "command" &&
        isCommonSwarmClaudeHook((hook as Record<string, unknown>).command)
      ) {
        if (!installed) {
          commands.push({ ...(hook as Record<string, unknown>), command });
          installed = true;
        }
        continue;
      }
      commands.push(hook);
    }
    if (commands.length > 0) groups.push({ ...row, hooks: commands });
  }
  if (!installed) {
    const snippetHooks = (claudeUserPromptHookSnippet(principalId).hooks as Record<string, unknown>)
      .UserPromptSubmit as unknown[];
    groups.push(snippetHooks[0]);
  }
  hooks.UserPromptSubmit = groups;
  return { ...settings, hooks };
}

function uninstallClaudeHook(settings: Record<string, unknown>): Record<string, unknown> {
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    return settings;
  }
  const hooks = { ...(settings.hooks as Record<string, unknown>) };
  if (!Array.isArray(hooks.UserPromptSubmit)) return settings;
  const groups: unknown[] = [];
  for (const group of hooks.UserPromptSubmit) {
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      groups.push(group);
      continue;
    }
    const row = { ...(group as Record<string, unknown>) };
    if (!Array.isArray(row.hooks)) {
      groups.push(group);
      continue;
    }
    row.hooks = row.hooks.filter((hook) => !(
      hook && typeof hook === "object" && !Array.isArray(hook) &&
      (hook as Record<string, unknown>).type === "command" &&
      isCommonSwarmClaudeHook((hook as Record<string, unknown>).command)
    ));
    if ((row.hooks as unknown[]).length > 0) groups.push(row);
  }
  if (groups.length > 0) hooks.UserPromptSubmit = groups;
  else delete hooks.UserPromptSubmit;
  if (Object.keys(hooks).length === 0) {
    const result = { ...settings };
    delete result.hooks;
    return result;
  }
  return { ...settings, hooks };
}

async function hookInstallPrincipalId(args: Arguments): Promise<string> {
  const explicit = args.optional("principal-id");
  if (explicit !== undefined) return listenerUuid(explicit, "principal-id");
  const principalIds = await discoverListenerHookPrincipalIds(
    defaultListenerStateDirectory(),
  );
  if (principalIds.length === 1) return principalIds[0]!;
  if (principalIds.length > 1) {
    throw new Error(
      "hook install claude found multiple agents on this host. " +
      "Choose this agent explicitly: cswarm hook install claude --principal-id <uuid> [--write]",
    );
  }
  throw new Error(
    "hook install claude could not find a listener principal. " +
    "Name this agent explicitly: cswarm hook install claude --principal-id <uuid> [--write]",
  );
}

async function runHook(args: Arguments): Promise<void> {
  const command = args.positionals[1];
  if (command === "check") {
    args.assertShape(["cooldown", "principal-id"], 2);
    const rawPrincipalIds = args.all("principal-id");
    if (rawPrincipalIds.some((principalId) => !UUID_RE.test(principalId))) return;
    const principalIds = rawPrincipalIds.map((principalId) => principalId.toLowerCase());
    const rawCooldown = args.optional("cooldown");
    const cooldownSeconds = rawCooldown === undefined ? undefined : Number(rawCooldown);
    if (
      cooldownSeconds !== undefined &&
      (!/^\d+$/.test(rawCooldown!) || !Number.isSafeInteger(cooldownSeconds) ||
        cooldownSeconds < 0 || cooldownSeconds > 86_400)
    ) {
      return;
    }
    // The fetch deadline only aborts cooperative I/O. This process ceiling also
    // stops sockets that ignore abort; completed stdout writes have already
    // called their callback before the hook advances its high-water.
    const hardExit = setTimeout(() => {
      process.exit(0);
    }, 3_000);
    hardExit.unref();
    await runListenerHookCheck({
      ...(cooldownSeconds === undefined ? {} : { cooldownSeconds }),
      ...(principalIds.length === 0 ? {} : { principalIds }),
      write: async (output) => {
        await new Promise<void>((resolve, reject) => {
          process.stdout.write(`${output}\n`, (error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      },
    });
    return;
  }
  if (command !== "install" && command !== "uninstall") {
    throw new UsageError("hook requires check, install, or uninstall");
  }
  args.assertShape(command === "install" ? ["write", "principal-id"] : ["write"], 3);
  if (args.positionals[2] !== "claude") {
    throw new Error("hook install/uninstall currently supports claude");
  }
  if (command === "uninstall" && !args.has("write")) {
    throw new Error("hook uninstall claude requires --write");
  }
  const principalId = command === "install" ? await hookInstallPrincipalId(args) : null;
  const snippet = principalId === null ? null : claudeUserPromptHookSnippet(principalId);
  if (command === "install" && !args.has("write")) {
    process.stdout.write(`${JSON.stringify(snippet, null, 2)}\n`);
    return;
  }
  const path = projectClaudeSettingsPath();
  const settings = readProjectSettings(path);
  const updated = command === "install"
    ? installClaudeHook(settings, principalId!)
    : uninstallClaudeHook(settings);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(
    command === "install"
      ? `Installed the Claude Code UserPromptSubmit hook in ${path}. It runs: ${scopedClaudeHookCommand(principalId!)}\n`
      : `Removed the CommonSwarm UserPromptSubmit hook from ${path}. Other settings were kept.\n`,
  );
}

/*
 * cswarm file — the S3 verb surface over the file-artifacts server commands
 * (FILE-ARTIFACTS.md §3). Copy rule: every success says what happened, what is
 * now true, and what happens next; every refusal arrives with the server's own
 * message, which carries the numbers (§4).
 */

function formatFileSize(value: number | string | null): string {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type FileCliContext = {
  cloud: CloudTarget;
  selected: Awaited<ReturnType<typeof commandWorkspaceAndCredential>>;
};

async function fileContext(
  args: Arguments,
  extraFlags: readonly string[],
  positionalCount: number,
): Promise<FileCliContext> {
  args.assertShape(
    [...TARGET_FLAGS, "workspace-id", ...CREDENTIAL_FLAGS, "json", ...extraFlags],
    positionalCount,
  );
  const cloud = await target(args);
  const selected = await commandWorkspaceAndCredential(args, cloud, {
    validateHumanWorkspace: true,
  });
  return { cloud, selected };
}

async function fileRows(context: FileCliContext): Promise<FileListRow[]> {
  const { cloud, selected } = context;
  if (selected.kind === "agent") {
    return await listFilesAsAgent(
      cloud,
      selected.bearer,
      selected.selectedWorkspace,
    );
  }
  /* The read edge function accepts agent credentials only; humans read the
   * membership-gated swarm_read view over REST, the same split members uses. */
  return await listFilesAsHuman(
    cloud,
    selected.human!.accessToken,
    selected.selectedWorkspace,
  );
}

/** A selector is a file id when it parses as one; anything else is a name. */
async function resolveFileSelector(
  context: FileCliContext,
  selector: string,
): Promise<string> {
  if (UUID_RE.test(selector)) return selector.toLowerCase();
  const rows = await fileRows(context);
  const match = rows.find(
    (row) => row.name.toLowerCase() === selector.toLowerCase(),
  );
  if (match === undefined) {
    throw new Error(
      `no file named "${
        sanitizeDisplayLabel(selector, "that name")
      }" exists in this workspace; run cswarm file ls to see what does, or pass a file id`,
    );
  }
  return match.file_id;
}

async function runFilePut(args: Arguments): Promise<void> {
  const localPath = args.positionals[2];
  if (!localPath) throw new UsageError("cswarm file put needs a local path");
  const context = await fileContext(args, ["name"], 3);
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(localPath);
  } catch {
    throw new Error(`could not read ${localPath}; check the path and permissions`);
  }
  const name = args.optional("name") ?? basename(localPath);
  if (bytes.byteLength > FILE_MAX_VERSION_BYTES) {
    // Preflight so a refusal costs zero upload bytes; the server enforces the
    // same cap authoritatively at create.
    throw new Error(
      `this file is ${formatFileSize(bytes.byteLength)}; the per-file limit is ${
        formatFileSize(FILE_MAX_VERSION_BYTES)
      }, so the upload was not started`,
    );
  }
  const contentType = contentTypeForName(name);
  if (contentType === null) {
    throw new Error(
      `"${
        sanitizeDisplayLabel(name, "that name")
      }" has no allowed file extension; the workspace accepts ${allowedExtensionList()}`,
    );
  }
  const send = {
    target: context.cloud,
    workspaceId: context.selected.selectedWorkspace,
    credential: context.selected.bearer,
  };
  /* Every id is minted ONCE per invocation and reused on the internal retry a
   * no-response failure gets, so the server's command-id replay resolves an
   * unknown outcome instead of a second attempt minting a second version
   * (review finding 2a). A re-RUN of `file put` is a new operation on purpose. */
  const fileId = randomUUID();
  const versionId = randomUUID();
  const createCommandId = newCommandId();
  const commitCommandId = newCommandId();
  const created = await onceRetried(() =>
    fileVersionCreate({ ...send, commandId: createCommandId }, {
      fileId,
      versionId,
      name,
      declaredSizeBytes: bytes.byteLength,
      contentType,
    })
  );
  await onceRetried(() =>
    putObject(context.cloud, created.upload_path, bytes, contentType)
  );
  const committed = await onceRetried(() =>
    fileVersionCommit({ ...send, commandId: commitCommandId }, {
      fileId: created.file_id,
      versionId: created.version_id,
      sha256: sha256Hex(bytes),
    })
  );
  if (args.has("json")) {
    /* Passthrough, no field allowlist: the server is the trusted party here,
     * and agent consumers read JSON unknown-field-tolerantly — filtering would
     * only hide fields a newer server added on purpose. */
    process.stdout.write(`${JSON.stringify(committed, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `Uploaded ${committed.name} — version ${committed.version_n}, ${
      formatFileSize(committed.size_bytes)
    }, visible to everyone in this workspace.\n` +
      `Reference for signals, pinned to this version: --about ${committed.reference}\n` +
      `The recorded sha256 is an unverified client attestation.\n`,
  );
}

async function runFileLs(args: Arguments): Promise<void> {
  const context = await fileContext(args, ["include-tombstoned"], 2);
  const rows = await fileRows(context);
  const visible = args.has("include-tombstoned")
    ? rows
    : rows.filter((row) => row.tombstoned_at === null);
  if (args.has("json")) {
    process.stdout.write(
      `${
        JSON.stringify(
          {
            workspace_id: context.selected.selectedWorkspace,
            files: visible,
            sha256_note: "unverified client attestation",
            content_warning: FILE_CONTENT_WARNING,
          },
          null,
          2,
        )
      }\n`,
    );
    return;
  }
  if (visible.length === 0) {
    process.stdout.write(
      rows.length === 0
        ? "No files in this workspace yet. Upload one with cswarm file put <path>.\n"
        : "No live files; tombstoned ones exist. See them with cswarm file ls --include-tombstoned.\n",
    );
    return;
  }
  process.stdout.write(`Files in this workspace (${visible.length}):\n`);
  for (const row of visible) {
    const marker = row.tombstoned_at === null
      ? ""
      : "  [tombstoned; restorable with cswarm file restore]";
    process.stdout.write(
      `- ${sanitizeDisplayLabel(row.name, "unnamed file")}  v${row.current_version} · ${
        formatFileSize(row.size_bytes)
      } · ${
        sanitizeDisplayLabel(row.content_type ?? "unknown type", "unknown type")
      } · by ${row.uploaded_by_kind ?? row.created_by_kind}${marker}\n`,
    );
  }
  process.stdout.write(`${FILE_CONTENT_WARNING}\n`);
}

async function runFileGet(args: Arguments): Promise<void> {
  const selector = args.positionals[2];
  if (!selector) throw new UsageError("cswarm file get needs a file name or id");
  const context = await fileContext(args, ["version", "out", "force"], 3);
  const versionN = args.has("version")
    ? integer(args, "version", { minimum: 1 })
    : null;
  const fileId = await resolveFileSelector(context, selector);
  const send = {
    target: context.cloud,
    workspaceId: context.selected.selectedWorkspace,
    credential: context.selected.bearer,
  };
  const grant = await fileDownloadUrl(send, { fileId, versionN });
  const destination = args.optional("out") ?? basename(grant.name);
  const bytes = await getObject(context.cloud, grant.download_path);
  // Atomic: `wx` under the hood, so a file created since any earlier look is
  // refused by the filesystem, never truncated (review finding 1).
  writeDestination(destination, bytes, args.has("force"), writeFileSync);
  if (args.has("json")) {
    process.stdout.write(
      `${
        JSON.stringify(
          { ...grant, written_to: destination, written_bytes: bytes.byteLength },
          null,
          2,
        )
      }\n`,
    );
    return;
  }
  process.stdout.write(
    `Downloaded ${grant.name} version ${grant.version_n} (${
      formatFileSize(bytes.byteLength)
    }, ${grant.content_type}) to ${destination}.\n${grant.content_warning}\n`,
  );
}

async function runFileRm(args: Arguments): Promise<void> {
  const selector = args.positionals[2];
  if (!selector) throw new UsageError("cswarm file rm needs a file name or id");
  /* ★R7: no --confirm here on purpose — the tombstone is reversible for 30
   * days and says so; the ceremony belongs to the irreversible purge, which
   * nobody invokes by hand. */
  const context = await fileContext(args, [], 3);
  const fileId = await resolveFileSelector(context, selector);
  const result = await fileTombstone({
    target: context.cloud,
    workspaceId: context.selected.selectedWorkspace,
    credential: context.selected.bearer,
  }, { fileId });
  if (args.has("json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `Tombstoned ${result.name}. It is hidden from listings and downloads now, and stays restorable with cswarm file restore until ${
      result.restorable_until ?? "the 30-day window ends"
    }.\nAfter that the purge permanently deletes the bytes; existing download URLs expire on their own 5-minute clock.\n`,
  );
}

async function runFileRestore(args: Arguments): Promise<void> {
  const selector = args.positionals[2];
  if (!selector) {
    throw new UsageError("cswarm file restore needs a file name or id");
  }
  const context = await fileContext(args, [], 3);
  const fileId = await resolveFileSelector(context, selector);
  const result = await fileRestore({
    target: context.cloud,
    workspaceId: context.selected.selectedWorkspace,
    credential: context.selected.bearer,
  }, { fileId });
  if (args.has("json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `Restored ${result.name}. It is listed and downloadable again; nothing else changed.\n`,
  );
}

async function runFeedback(args: Arguments): Promise<void> {
  const body = args.positionals[1];
  if (!body) {
    throw new UsageError(
      'cswarm feedback needs the feedback text: cswarm feedback "<text>" --kind bug|idea|friction',
    );
  }
  const kind = args.required("kind");
  if (kind !== "bug" && kind !== "idea" && kind !== "friction") {
    throw new UsageError("--kind must be bug, idea, or friction");
  }
  const about = args.optional("about");
  const context = await fileContext(args, ["kind", "about"], 2);
  /* Context is descriptive only: the CLI version and platform help the
   * operator reproduce, and nothing here reads env vars or paths. */
  const submitted = await submitFeedback({
    target: context.cloud,
    workspaceId: context.selected.selectedWorkspace,
    credential: context.selected.bearer,
  }, {
    category: kind,
    body,
    context: {
      surface: "cli",
      cswarm_version: CLI_BUILD_VERSION,
      platform: process.platform,
      ...(about ? { about } : {}),
    },
  });
  if (args.has("json")) {
    process.stdout.write(`${JSON.stringify(submitted, null, 2)}\n`);
    return;
  }
  if (submitted.duplicate === true) {
    process.stdout.write(
      "This matches feedback you sent within the hour, so it was not recorded twice. It is already with the operators of this deployment.\n",
    );
    return;
  }
  process.stdout.write(
    "Feedback recorded for the operators of this deployment. It is stored durably with your workspace and identity attached, and it is read when they review feedback - there is no reply channel, so nothing further will happen in this session.\n",
  );
}

async function runFile(args: Arguments): Promise<void> {
  const action = args.positionals[1];
  if (action === "put") return await runFilePut(args);
  if (action === "ls") return await runFileLs(args);
  if (action === "get") return await runFileGet(args);
  if (action === "rm") return await runFileRm(args);
  if (action === "restore") return await runFileRestore(args);
  throw new UsageError(
    "cswarm file takes put, ls, get, rm, or restore",
  );
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
  if (verb === "__listen-supervisor") {
    await runListenSupervisor(args);
    return;
  }
  if (verb === "hook") {
    await runHook(args);
    return;
  }
  if (verb === "listen") {
    await runListen(args);
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
          ? `workspace ${result.workspaceId} is now selected`
          : "no workspace is selected yet—run cswarm workspaces, then cswarm use <full-id|exact-name>"
      }.\n`,
    );
    return;
  }
  if (verb === "logout") {
    args.assertShape([...TARGET_FLAGS, "device", "all-devices", "local"], 1);
    if (args.optional("device") !== undefined) {
      throw new Error(
        "--device is deferred until the server-side device authority endpoint ships",
      );
    }
    const cloud = await target(args);
    const credentials = await store(args, cloud);
    const allDevices = args.has("all-devices");
    const localOnly = args.has("local");
    if (localOnly && allDevices) {
      throw new Error(
        "--local clears only this device and never contacts the server, so it cannot be combined with --all-devices",
      );
    }
    const outcome = await logout(
      cloud,
      credentials,
      allDevices ? "global" : "local",
      { localOnly },
    );
    process.stdout.write(logoutMessage(outcome, allDevices));
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
  if (verb === "workspace") {
    await runWorkspace(args);
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
  if (verb === "whoami") {
    await runWhoami(args);
    return;
  }
  if (verb === "feedback") {
    await runFeedback(args);
    return;
  }
  if (verb === "file") {
    await runFile(args);
    return;
  }
  if (verb === "members") {
    await runMembers(args);
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
  if (verb === "receipt") {
    await runReceipt(args);
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
/**
 * sysexits EX_TEMPFAIL: "temporary failure; the user is invited to retry".
 *
 * D-056: the follow loop correctly dies on a refused read rather than retrying
 * through the server's instruction, and supervision is the remedy for a process
 * that exits. But every cswarm failure exited 1, so the supervisor forms that
 * read only an exit status — a shell until-loop, a service unit, a
 * respawn-on-nonzero runner — could not tell "refused, a later attempt may
 * succeed" from "credential revoked, do not restart". The D-055 frame serves
 * hosts that parse the NDJSON stream; this serves the ones that cannot.
 */
export const EXIT_RESTARTABLE = 75;

/** Exit status attached to an error whose failure may clear on a later run. */
const restartableExit = new WeakMap<Error, number>();

/** Mark an error so the top-level handler exits with EX_TEMPFAIL. */
function markRestartable(error: Error): Error {
  restartableExit.set(error, EXIT_RESTARTABLE);
  return error;
}

function exitCodeFor(error: unknown): number {
  return error instanceof Error ? restartableExit.get(error) ?? 1 : 1;
}

function safeParagraph(message: string): string {
  return message
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .slice(0, 2000);
}

main().catch((error) => {
  if (process.argv[2] === "hook" && process.argv[3] === "check") {
    process.exitCode = 0;
    return;
  }
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
        verb === "receipt" ||
        verb === "feed" ||
        verb === "inbox"
      );
    if (json) {
      process.stdout.write(`${JSON.stringify(structured, null, 2)}\n`);
    } else {
      process.stderr.write(`cswarm: ${error.message}\n`);
      const projects = structured.projects;
      if (Array.isArray(projects) && projects.length > 0) {
        process.stderr.write("Available workspaces:\n");
        for (const project of projects) {
          if (!project || typeof project !== "object") continue;
          const row = project as Record<string, unknown>;
          process.stderr.write(
            `- ${String(row.name)} (${String(row.workspace_id)}) — ${String(row.role)}\n`,
          );
        }
      }
      /* D-073. This branch is the one a PERSON reads — the `--json` branch above already
       * writes the machine form, to stdout. A trailing `JSON.stringify(structured)` here made
       * every server-returned error appear twice: once as the sentence, then again wrapped in
       * braces, with no `--json` requested. Client-side errors were unaffected, so the
       * doubling followed the error CLASS rather than the verb, which is why it went unnoticed
       * for so long — it never appeared in the failure modes anyone was testing.
       *
       * Removed rather than reformatted: nothing pinned it, the originating commit gives no
       * rationale for it, and a caller wanting the object has `--json`. */
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
  process.exitCode = exitCodeFor(error);
});
