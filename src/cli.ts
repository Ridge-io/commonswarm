#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Command } from "./protocol/index.js";
import { login, logout, refreshedCredential } from "./cloud/auth.js";
import {
  assertAgentToken,
  ThinCommandClient,
  type CommandResult,
  type StreamRoute,
} from "./cloud/command-client.js";
import { cloudTarget, type CloudTarget } from "./cloud/config.js";
import { seedDogfood } from "./cloud/seed.js";
import { credentialStore, type CredentialStore } from "./cloud/storage.js";

const BOOLEAN_FLAGS = new Set([
  "agent-token-stdin",
  "force-file-store",
  "help",
  "no-browser",
]);

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
  return `Usage:
  swarm login --url <project-url> --anon-key <key> [--no-browser]
  swarm logout --url <project-url> --anon-key <key>
  swarm command <kind> --url <url> --anon-key <key> --workspace-id <uuid> [command fields]
  swarm dogfood --url <url> --anon-key <key> --workspace-id <uuid> --slug <slug> --branch <branch> --head-sha <sha> --evidence <ref>
  swarm seed-fixture --uid <auth-user-uuid> [--device-id <uuid>]

Credential selection for command/dogfood:
  default                 refresh the human login from secure storage
  --agent-token-stdin     read one seeded swm_agt_ credential from stdin

Target flags may also be set with SWARM_CLOUD_URL and SWARM_CLOUD_ANON_KEY.
The fixture bridge reads its privileged database connection only from DATABASE_URL
and writes a newly minted agent token only to the absolute create-new path in
SEED_TOKEN_OUT.`;
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

async function credential(
  args: Arguments,
  cloud: CloudTarget,
): Promise<string> {
  if (args.has("agent-token-stdin")) return await stdinCredential();
  const credentials = await store(args, cloud);
  return (await refreshedCredential(cloud, credentials)).accessToken;
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
  const bearer = await credential(args, cloud);
  const client = new ThinCommandClient(cloud);
  const result = await client.send({
    workspaceId: args.required("workspace-id"),
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
  const bearer = await credential(args, cloud);
  const client = new ThinCommandClient(cloud);
  const workspaceId = args.required("workspace-id");
  const route = stream(args);
  const taskId = args.optional("task-id") ?? randomUUID();
  const ttl = Number(args.optional("ttl-ms") ?? "3600000");
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 14_400_000) {
    throw new Error("--ttl-ms must be an integer in 1..14400000");
  }
  const evidence = args.all("evidence");
  if (evidence.length === 0) throw new Error("--evidence is required");
  const common = { workspaceId, stream: route, credential: bearer };
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
    ["uid", "device-id", "display-name", "workspace-name", "agent-name"],
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
      `Logged in as ${result.userId}; device ${result.deviceId}; refresh credential: ${result.storage}.\n`,
    );
    return;
  }
  if (verb === "logout") {
    args.assertShape([...TARGET_FLAGS, "device"], 1);
    if (args.optional("device") !== undefined) {
      throw new Error(
        "--device is deferred until the server-side device authority endpoint ships",
      );
    }
    const cloud = target(args);
    const credentials = await store(args, cloud);
    const removed = await logout(cloud, credentials);
    process.stdout.write(removed ? "Logged out.\n" : "Already logged out.\n");
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
  return message.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 1000);
}

main().catch((error) => {
  process.stderr.write(`swarm: ${safeError(error)}\n`);
  process.exitCode = 1;
});
